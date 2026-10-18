import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as DateTime from "effect/DateTime";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProcessIdentity from "./ProcessIdentity.ts";
import * as ThreadWakeupService from "./ThreadWakeupService.ts";

const threadId = ThreadId.make("thread:wakeup");
const harness = Effect.gen(function* () {
  const sent: ThreadManagement.ThreadManagementSendInput[] = [];
  const receipts = new Set<string>();
  const state = {
    identity: "boot:123" as string | null,
    archived: false,
    deleted: false,
    missing: false,
    failAfterCommit: false,
    processError: false,
    activeRunId: RunId.make("run:current") as RunId | null,
  };
  const sources: string[] = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
      getByCommandId: (commandId) =>
        Effect.succeed(
          receipts.has(commandId)
            ? Option.some({
                commandId,
                threadId,
                commandType: "message.dispatch",
                acceptedAt: DateTime.makeUnsafe(0),
                resultSequence: 1,
                status: "accepted" as const,
                error: null,
              })
            : Option.none(),
        ),
    }),
    Layer.succeed(ProcessIdentity.ProcessIdentity, {
      read: () =>
        state.processError
          ? Effect.fail(
              new ProcessIdentity.ProcessIdentityError({ pid: 42, reason: "unsupported" }),
            )
          : Effect.succeed(state.identity),
    }),
    Layer.succeed(Scheduler.Scheduler, {
      register: (name) =>
        Effect.sync(() => {
          sources.push(name);
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          state.missing
            ? null
            : {
                ...liveThreadShell(id, { activeRunId: state.activeRunId }),
                archivedAt: state.archived ? liveThreadShell(id).createdAt : null,
                deletedAt: state.deleted ? liveThreadShell(id).createdAt : null,
              },
        ),
      hasReceipt: (id) => Effect.succeed(receipts.has(id)),
      sendToThread: (input) =>
        Effect.gen(function* () {
          if (!receipts.has(input.commandId)) {
            sent.push(input);
            receipts.add(input.commandId);
          }
          if (state.failAfterCommit) {
            return yield* new ThreadManagement.ThreadManagementDurableRunProjectionError({
              threadId: input.threadId,
              messageId: input.messageId,
            });
          }
          return { delivery: "queued" } as ThreadManagement.ThreadManagementSendResult;
        }),
    }),
  );
  // Each provide builds a new service instance over the same SQLite database.
  const use = <A, E>(
    f: (service: ThreadWakeupService.ThreadWakeupService["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.flatMap(ThreadWakeupService.ThreadWakeupService, f).pipe(
      Effect.provide(ThreadWakeupService.layer.pipe(Layer.provide(dependencies))),
    );
  const rows = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT * FROM thread_wakeups`);
  return { sent, receipts, state, sources, use, rows };
});

it.effect(
  "persists a time wakeup, waits until due, and queues exactly one continue after restart",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.use((s) =>
        s.scheduleContinue(threadId, { afterSeconds: 10, idempotencyKey: "retry" }),
      );
      expect(created).toMatchObject({ status: "scheduled", dueAt: "1970-01-01T00:00:10.000Z" });
      expect(yield* h.use((s) => s.readPendingWakeups)).toMatchObject([
        {
          threadId,
          wakeup: {
            wakeupId: created.wakeupId,
            kind: "time",
            status: "scheduled",
          },
        },
      ]);
      const duplicate = yield* h.use((s) =>
        s.scheduleContinue(threadId, { afterSeconds: 200, idempotencyKey: "retry" }),
      );
      expect(duplicate).toEqual(created);
      yield* TestClock.setTime(9_999);
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(0);
      yield* TestClock.setTime(10_000);
      yield* h.use((s) => s.runDueWork);
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({
        threadId,
        projectId: "project:mcp-test",
        text: "continue",
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: `thread-wakeup:${created.wakeupId}`,
        messageId: `thread-wakeup:${created.wakeupId}`,
      });
      expect((yield* h.rows)[0]).toMatchObject({ status: "delivered", due_at: created.dueAt });
      expect(yield* h.use((s) => s.readPendingWakeups)).toEqual([]);
      expect(h.sources.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "publishes thread changes when wake UI state changes",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.use((service) =>
        Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* service.subscribeChanges;
            yield* service.scheduleContinue(threadId, { afterSeconds: 10 });
            expect(yield* PubSub.take(changes)).toBe(threadId);
          }),
        ),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "recovers a due row after an uncertain committed delivery without dispatching again",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.state.failAfterCommit = true;
      yield* h.use((s) => s.scheduleContinue(threadId, { wakeAt: "1970-01-01T00:00:00Z" }));
      expect((yield* h.rows)[0]?.status).toBe("due");
      expect(h.sent).toHaveLength(1);
      h.state.archived = true;
      yield* h.use((s) => s.runDueWork);
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(1);
      expect((yield* h.rows)[0]?.status).toBe("delivered");
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([null, "boot:456", "new-boot:123"])(
  "observes exact process identity and wakes once on %s",
  (identity) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.use((s) =>
        s.continueAfterProcess(threadId, { pid: 42, idempotencyKey: "process" }),
      );
      expect(created).toMatchObject({ status: "scheduled", dueAt: null });
      expect((yield* h.rows)[0]).toMatchObject({ pid: 42, process_identity: "boot:123" });
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(0);
      h.state.identity = identity;
      expect(
        yield* h.use((s) =>
          s.continueAfterProcess(threadId, { pid: 99, idempotencyKey: "process" }),
        ),
      ).toEqual(created);
      yield* h.use((s) => s.runDueWork);
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(1);
      expect((yield* h.rows)[0]?.status).toBe("delivered");
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "immediately queues an already-gone process once and scopes keys by kind and thread",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.state.identity = null;
      const created = yield* h.use((s) =>
        s.continueAfterProcess(threadId, { pid: 42, idempotencyKey: "same" }),
      );
      expect(created.status).toBe("delivered");
      expect(
        yield* h.use((s) => s.continueAfterProcess(threadId, { pid: 42, idempotencyKey: "same" })),
      ).toEqual(created);
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(1);
      yield* h.use((s) =>
        s.scheduleContinue(threadId, { afterSeconds: 10, idempotencyKey: "same" }),
      );
      yield* h.use((s) =>
        s.scheduleContinue(ThreadId.make("other"), { afterSeconds: 10, idempotencyKey: "same" }),
      );
      expect(yield* h.rows).toHaveLength(3);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("resumes the originating active run when a watched process exits", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const origin = h.state.activeRunId!;
    yield* h.use((s) => s.continueAfterProcess(threadId, { pid: 42 }, origin));
    h.state.identity = null;
    yield* h.use((s) => s.runDueWork);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.mode).toBe("auto");
    expect((yield* h.rows)[0]).toMatchObject({
      originating_run_id: origin,
      status: "delivered",
    });
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("queues a process wake normally when its originating run already ended", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const origin = h.state.activeRunId!;
    yield* h.use((s) => s.continueAfterProcess(threadId, { pid: 42 }, origin));
    h.state.identity = null;
    h.state.activeRunId = null;
    yield* h.use((s) => s.runDueWork);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.mode).toBe("queue");
    expect((yield* h.rows)[0]?.status).toBe("delivered");
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("drops a process wake instead of disturbing a newer active run", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const origin = h.state.activeRunId!;
    yield* h.use((s) => s.continueAfterProcess(threadId, { pid: 42 }, origin));
    h.state.identity = null;
    h.state.activeRunId = RunId.make("run:newer");
    yield* h.use((s) => s.runDueWork);
    expect(h.sent).toHaveLength(0);
    expect((yield* h.rows)[0]?.status).toBe("stale");
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each(["archived", "deleted", "missing"] as const)(
  "makes a due wakeup terminal when the thread is %s",
  (key) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.use((s) => s.scheduleContinue(threadId, { afterSeconds: 1 }));
      h.state[key] = true;
      yield* TestClock.setTime(1000);
      yield* h.use((s) => s.runDueWork);
      yield* h.use((s) => s.runDueWork);
      expect(h.sent).toHaveLength(0);
      expect((yield* h.rows)[0]?.status).toBe("stale");
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("returns typed process failures without creating a registration", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.state.processError = true;
    const error = yield* h
      .use((s) => s.continueAfterProcess(threadId, { pid: 42 }))
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ProcessIdentityError", reason: "unsupported" });
    expect(yield* h.rows).toEqual([]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
