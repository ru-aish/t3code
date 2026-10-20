// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalTimers:off - filesystem mutex must match Terminal MCP's native atomic mkdir protocol.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { withWorkspaceLease } from "./workspaceLease.ts";

export class DetachedWorkspaceFenceError extends Schema.TaggedError<DetachedWorkspaceFenceError>()(
  "DetachedWorkspaceFenceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const FENCE_VERSION = "1";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3_000;

// Terminal MCP's documented default is state.path.parent/durable-jobs.
// Detect only a configured/installed producer; unrelated T3 installations do
// not need a Terminal MCP service to manipulate their worktrees.
export const jobsDirectory = (): string | null => {
  if (process.env.T3_WORKSPACE_FENCE_DISABLED === "1") return null;
  const explicit = process.env.T3_WORKSPACE_DURABLE_JOBS_DIR ?? process.env.MCP_T3_DURABLE_JOBS_DIR;
  if (explicit !== undefined) return NodePath.resolve(explicit);
  if (process.env.T3_TERMINAL_DB)
    return NodePath.join(NodePath.dirname(NodePath.resolve(process.env.T3_TERMINAL_DB)), "durable-jobs");
  const home = NodeOS.homedir();
  const token = NodePath.join(home, ".config/terminal-mcp-t3/control-token");
  const state = NodePath.join(home, ".local/share/terminal-mcp-t3/state.sqlite");
  return NodeFS.existsSync(token) && NodeFS.existsSync(state)
    ? NodePath.join(NodePath.dirname(state), "durable-jobs")
    : null;
};

const overlaps = (left: string, right: string) => {
  const contains = (parent: string, child: string) => {
    const relative = NodePath.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  };
  return contains(left, right) || contains(right, left);
};

const json = async (file: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(file, "utf8"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The Terminal MCP producer must hold the same atomic directory lock while
 * reserving a durable job, through commit of its request.json. Result receipts
 * are written only after its entire process group has stopped. Unknown jobs
 * intentionally keep destructive operations blocked.
 */
export const checkDetachedWorkspaceJobs = async (
  workspace: string,
  root: string,
): Promise<void> => {
  if (
    (await NodeFSP.readFile(NodePath.join(root, "workspace-fence-version"), "utf8")).trim() !==
    FENCE_VERSION
  )
    throw new Error("Terminal MCP workspace fence protocol is not active");

  const canonicalWorkspace = await NodeFSP.realpath(workspace).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return NodePath.resolve(workspace);
      throw error;
    },
  );
  const directory = NodePath.join(root, "jobs");
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(entry.name))
      throw new Error("Unrecognized durable job entry " + entry.name);
    const job = NodePath.join(directory, entry.name);
    // A reservation without a request is ambiguous. Never assume it is safe.
    const request = await json(NodePath.join(job, "request.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new Error(`Unresolved durable job reservation ${entry.name}`);
        throw error;
      },
    );
    if (!isRecord(request) || typeof request.cwd !== "string" || !NodePath.isAbsolute(request.cwd))
      throw new Error(`Invalid durable job record ${entry.name}`);
    const canonicalJobCwd = await NodeFSP.realpath(request.cwd).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return NodePath.resolve(request.cwd as string);
        throw error;
      },
    );
    if (!overlaps(canonicalWorkspace, canonicalJobCwd)) continue;
    try {
      const result = await json(NodePath.join(job, "result.json"));
      if (
        !isRecord(result) ||
        result.group_verified !== true ||
        !isRecord(result.child) ||
        !Number.isSafeInteger(result.child.pid) ||
        (result.child.pid as number) <= 0 ||
        !Number.isSafeInteger(result.child.start_ticks) ||
        (result.child.start_ticks as number) <= 0 ||
        typeof result.child.boot_id !== "string" ||
        !["exited", "timed_out", "descendants_stopped", "cancelled", "stop_not_effective"].includes(
          String(result.status),
        )
      )
        throw new Error("Unverified durable job termination " + entry.name);
      const bootId = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (result.child.boot_id === bootId) {
        const stat = await NodeFSP.readFile("/proc/" + result.child.pid + "/stat", "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (stat !== null) {
          const closing = stat.lastIndexOf(")");
          const startTicks = Number(stat.slice(closing + 2).split(" ")[19]);
          if (!Number.isSafeInteger(startTicks) || startTicks === result.child.start_ticks)
            throw new Error("Durable job process remains alive " + entry.name);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Detached job ${entry.name} may still be writing ${workspace}`, {
        cause: error,
      });
    }
  }
};

/**
 * Wrap only destructive worktree operations. A held or abandoned lock fails
 * closed; no PID or wall-clock based stale-lock stealing is safe here.
 */
export const withDetachedWorkspaceFence = <A, E, R>(
  workspace: string,
  effect: Effect.Effect<A, E, R>,
  root: string | null = jobsDirectory(),
): Effect.Effect<A, E | DetachedWorkspaceFenceError, R> =>
  withWorkspaceLease(
    NodePath.resolve(workspace),
    root === null
      ? effect
      : Effect.acquireUseRelease(
          Effect.tryPromise({
            try: async () => {
              const lock = NodePath.join(root, "workspace-mutation.lock");
              const deadline = Date.now() + LOCK_TIMEOUT_MS;
              for (;;) {
                try {
                  await NodeFSP.mkdir(lock);
                  return lock;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
                    throw error;
                  await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
                }
              }
            },
            catch: (error) =>
              new DetachedWorkspaceFenceError({
                message: "Cannot acquire durable workspace fence",
                cause: error,
              }),
          }),
          () =>
            Effect.tryPromise({
              try: () => checkDetachedWorkspaceJobs(NodePath.resolve(workspace), root),
              catch: (error) =>
                new DetachedWorkspaceFenceError({
                  message: "Workspace mutation blocked by Terminal MCP jobs",
                  cause: error,
                }),
            }).pipe(Effect.andThen(effect)),
          (lock) => Effect.promise(() => NodeFSP.rmdir(lock)),
        ),
  );
