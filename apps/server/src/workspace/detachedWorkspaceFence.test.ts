// @effect-diagnostics nodeBuiltinImport:off - exercise actual native filesystem mutex semantics.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  checkDetachedWorkspaceJobs,
  jobsDirectory,
  withDetachedWorkspaceFence,
} from "./detachedWorkspaceFence.ts";

const fixture = async () => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-detached-fence-"));
  const workspace = NodePath.join(temporary, "checkout");
  const jobs = NodePath.join(temporary, "durable");
  await NodeFSP.mkdir(workspace);
  await NodeFSP.mkdir(NodePath.join(jobs, "jobs"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(jobs, "workspace-fence-version"), "1\n");
  return { temporary, workspace, jobs };
};

const record = async (root: string, id: string, cwd: string, result?: Record<string, unknown>) => {
  const directory = NodePath.join(root, "jobs", id.repeat(32));
  await NodeFSP.mkdir(directory);
  await NodeFSP.writeFile(NodePath.join(directory, "request.json"), JSON.stringify({ cwd }));
  if (result)
    await NodeFSP.writeFile(NodePath.join(directory, "result.json"), JSON.stringify(result));
};

it("blocks unfinished overlapping jobs but allows completed and unrelated jobs", async () => {
  const { temporary, workspace, jobs } = await fixture();
  try {
    await record(jobs, "a", NodePath.join(temporary, "elsewhere"));
    await checkDetachedWorkspaceJobs(workspace, jobs);
    await record(jobs, "b", NodePath.join(workspace, "subdir"));
    await NodeAssert.rejects(checkDetachedWorkspaceJobs(workspace, jobs), /may still be writing/);
    await NodeFSP.writeFile(
      NodePath.join(jobs, "jobs", "b".repeat(32), "result.json"),
      JSON.stringify({
        status: "exited",
        group_verified: true,
        child: { pid: 99999999, start_ticks: 1, boot_id: "other-boot" },
      }),
    );
    await checkDetachedWorkspaceJobs(workspace, jobs);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});

it("fails closed on missing protocol, unknown reservation, and unverified receipt", async () => {
  const { temporary, workspace, jobs } = await fixture();
  try {
    await NodeFSP.rm(NodePath.join(jobs, "workspace-fence-version"));
    await NodeAssert.rejects(checkDetachedWorkspaceJobs(workspace, jobs), /ENOENT/);
    await NodeFSP.writeFile(NodePath.join(jobs, "workspace-fence-version"), "1\n");
    await NodeFSP.mkdir(NodePath.join(jobs, "jobs", "c".repeat(32)));
    await NodeAssert.rejects(
      checkDetachedWorkspaceJobs(workspace, jobs),
      /Unresolved durable job reservation/,
    );
    await NodeFSP.writeFile(
      NodePath.join(jobs, "jobs", "c".repeat(32), "request.json"),
      JSON.stringify({ cwd: workspace }),
    );
    await NodeFSP.writeFile(
      NodePath.join(jobs, "jobs", "c".repeat(32), "result.json"),
      '{"status":"termination_unverified","group_verified":false}',
    );
    await NodeAssert.rejects(
      checkDetachedWorkspaceJobs(workspace, jobs),
      /Unverified durable job termination/,
    );
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});

it.effect("keeps the launch gate held during a mutation and releases it after failure", () =>
  Effect.gen(function* () {
    const { temporary, workspace, jobs } = yield* Effect.promise(fixture);
    let entered!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = Effect.gen(function* () {
      const mutation = yield* withDetachedWorkspaceFence(
        workspace,
        Effect.promise(async () => {
          entered();
          await hold;
        }),
        jobs,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => began);
      const lock = NodePath.join(jobs, "workspace-mutation.lock");
      yield* Effect.promise(() => NodeAssert.rejects(NodeFSP.mkdir(lock), { code: "EEXIST" }));
      release();
      yield* Fiber.join(mutation);
      NodeAssert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(jobs)), [
        "jobs",
        "workspace-fence-version",
      ]);

      // A cooperating launcher reserves its job while holding the same gate.
      yield* Effect.promise(() => NodeFSP.mkdir(lock));
      yield* Effect.promise(() => record(jobs, "d", workspace));
      yield* Effect.promise(() => NodeFSP.rmdir(lock));
      const error = yield* withDetachedWorkspaceFence(
        workspace,
        Effect.succeed("unsafe"),
        jobs,
      ).pipe(Effect.flip);
      NodeAssert.match(error.message, /Workspace mutation blocked by Terminal MCP jobs/);
      NodeAssert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(jobs)), [
        "jobs",
        "workspace-fence-version",
      ]);
    });
    yield* action.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          release?.();
        }),
      ),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      ),
    );
  }),
);

it("rejects a forged completion receipt for a still-running process", async () => {
  const { temporary, workspace, jobs } = await fixture();
  try {
    const bootId = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const stat = await NodeFSP.readFile("/proc/self/stat", "utf8");
    const startTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    await record(jobs, "e", workspace, {
      status: "exited",
      group_verified: true,
      child: { pid: process.pid, start_ticks: startTicks, boot_id: bootId },
    });
    await NodeAssert.rejects(checkDetachedWorkspaceJobs(workspace, jobs), /remains alive/);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});

it("blocks parent and descendant mutations but not unrelated siblings", async () => {
  const { temporary, workspace, jobs } = await fixture();
  try {
    await record(jobs, "f", workspace);
    await NodeAssert.rejects(checkDetachedWorkspaceJobs(temporary, jobs), /may still be writing/);
    const nested = NodePath.join(workspace, "nested");
    await NodeFSP.mkdir(nested);
    await NodeAssert.rejects(checkDetachedWorkspaceJobs(nested, jobs), /may still be writing/);
    const sibling = NodePath.join(temporary, "other");
    await NodeFSP.mkdir(sibling);
    await checkDetachedWorkspaceJobs(sibling, jobs);
    const alias = NodePath.join(temporary, "alias");
    await NodeFSP.symlink(workspace, alias);
    await NodeAssert.rejects(checkDetachedWorkspaceJobs(alias, jobs), /may still be writing/);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});

it("rejects unknown ledger entries instead of pretending the ledger is empty", async () => {
  const { temporary, workspace, jobs } = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(jobs, "jobs", "invalid-reservation"));
    await NodeAssert.rejects(
      checkDetachedWorkspaceJobs(workspace, jobs),
      /Unrecognized durable job/,
    );
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});

it("discovers configured producer roots and allows explicitly disabled installations", () => {
  const keys = [
    "T3_WORKSPACE_FENCE_DISABLED",
    "T3_WORKSPACE_DURABLE_JOBS_DIR",
    "MCP_T3_DURABLE_JOBS_DIR",
    "T3_TERMINAL_DB",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.T3_TERMINAL_DB = "/testing/terminal/state.sqlite";
    NodeAssert.equal(jobsDirectory(), "/testing/terminal/durable-jobs");
    process.env.MCP_T3_DURABLE_JOBS_DIR = "/testing/producer";
    NodeAssert.equal(jobsDirectory(), "/testing/producer");
    process.env.T3_WORKSPACE_DURABLE_JOBS_DIR = "/testing/consumer";
    NodeAssert.equal(jobsDirectory(), "/testing/consumer");
    process.env.T3_WORKSPACE_FENCE_DISABLED = "1";
    NodeAssert.equal(jobsDirectory(), null);
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
