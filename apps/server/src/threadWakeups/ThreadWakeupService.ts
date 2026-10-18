import {
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  OrchestratorMcpContinueAfterProcessInput,
  type OrchestratorMcpContinueResult,
  OrchestratorMcpScheduleContinueInput,
  type OrchestrationV2PendingThreadWakeup,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProcessIdentity from "./ProcessIdentity.ts";

export class ThreadWakeupError extends Schema.TaggedError<ThreadWakeupError>()(
  "ThreadWakeupError",
  {
    reason: Schema.Literals(["invalid_schedule", "thread_unavailable", "storage", "delivery"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_schedule":
        return "Provide exactly one valid afterSeconds or timezone-aware wakeAt within the supported date range.";
      case "thread_unavailable":
        return "The calling thread no longer exists or is archived.";
      case "storage":
        return "Unable to persist the thread wakeup.";
      case "delivery":
        return "Unable to deliver the thread wakeup; the scheduler will retry.";
    }
  }
}

type WakeupFailure = ThreadWakeupError | ProcessIdentity.ProcessIdentityError;

export interface PendingThreadWakeupEntry {
  readonly threadId: ThreadId;
  readonly wakeup: OrchestrationV2PendingThreadWakeup;
}

export function decorateShellsWithPendingWakeups(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  entries: ReadonlyArray<PendingThreadWakeupEntry>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const byThread = new Map<ThreadId, Array<OrchestrationV2PendingThreadWakeup>>();
  for (const entry of entries) {
    const current = byThread.get(entry.threadId) ?? [];
    current.push(entry.wakeup);
    byThread.set(entry.threadId, current);
  }
  return shells.map((shell) => ({
    ...shell,
    pendingWakeups: byThread.get(shell.id) ?? [],
  }));
}

export function decorateShellWithPendingWakeups(
  shell: OrchestrationV2ThreadShell,
  entries: ReadonlyArray<PendingThreadWakeupEntry>,
): OrchestrationV2ThreadShell {
  return decorateShellsWithPendingWakeups([shell], entries)[0]!;
}

export class ThreadWakeupService extends Context.Service<
  ThreadWakeupService,
  {
    readonly scheduleContinue: (
      threadId: ThreadId,
      input: OrchestratorMcpScheduleContinueInput,
    ) => Effect.Effect<OrchestratorMcpContinueResult, ThreadWakeupError>;
    readonly continueAfterProcess: (
      threadId: ThreadId,
      input: OrchestratorMcpContinueAfterProcessInput,
      originatingRunId?: RunId | null,
    ) => Effect.Effect<OrchestratorMcpContinueResult, WakeupFailure>;
    readonly readPendingWakeups: Effect.Effect<
      ReadonlyArray<PendingThreadWakeupEntry>,
      ThreadWakeupError
    >;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<ThreadId>, never, Scope.Scope>;
    readonly runDueWork: Effect.Effect<void, ThreadWakeupError>;
  }
>()("t3/threadWakeups/ThreadWakeupService") {}

interface WakeupRow {
  readonly wakeup_id: string;
  readonly thread_id: string;
  readonly kind: "time" | "process";
  readonly due_at: string | null;
  readonly pid: number | null;
  readonly process_identity: string | null;
  readonly originating_run_id: string | null;
  readonly status: OrchestratorMcpContinueResult["status"];
}

const result = (row: WakeupRow): OrchestratorMcpContinueResult => ({
  wakeupId: row.wakeup_id,
  status: row.status,
  dueAt: row.due_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const processes = yield* ProcessIdentity.ProcessIdentity;
  const scheduler = yield* Scheduler.Scheduler;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const permit = yield* Semaphore.make(1);
  const storageError = (cause: unknown) => new ThreadWakeupError({ reason: "storage", cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const findDuplicate = (threadId: ThreadId, kind: WakeupRow["kind"], key?: string) =>
    key === undefined
      ? Effect.succeed(undefined)
      : sql<WakeupRow>`SELECT * FROM thread_wakeups
          WHERE thread_id = ${threadId} AND kind = ${kind} AND idempotency_key = ${key}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError(storageError),
        );

  const setStatus = (row: WakeupRow, status: "delivered" | "stale") =>
    Effect.gen(function* () {
      const updatedAt = yield* now;
      yield* sql`UPDATE thread_wakeups SET status = ${status}, updated_at = ${updatedAt}
        WHERE wakeup_id = ${row.wakeup_id} AND status IN ('scheduled', 'due')`;
      yield* PubSub.publish(changes, ThreadId.make(row.thread_id));
    }).pipe(Effect.mapError(storageError));

  const deliver = Effect.fn("ThreadWakeupService.deliver")(function* (row: WakeupRow) {
    const threadId = ThreadId.make(row.thread_id);
    const commandId = CommandId.make(`thread-wakeup:${row.wakeup_id}`);
    // A crash can leave the row due after the message committed. The receipt
    // is authoritative even if the thread was subsequently archived/deleted.
    const receipt = yield* receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError((cause) => new ThreadWakeupError({ reason: "delivery", cause })));
    if (Option.isSome(receipt)) {
      return yield* setStatus(row, receipt.value.status === "accepted" ? "delivered" : "stale");
    }
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new ThreadWakeupError({ reason: "delivery", cause })));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
      return yield* setStatus(row, "stale");
    }
    let mode: ThreadManagement.ThreadManagementSendMode = "queue";
    if (row.kind === "process" && row.originating_run_id !== null) {
      if (shell.activeRunId !== null && shell.activeRunId !== row.originating_run_id) {
        return yield* setStatus(row, "stale");
      }
      if (shell.activeRunId === row.originating_run_id) mode = "auto";
    }
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        threadId,
        commandId,
        messageId: MessageId.make(`thread-wakeup:${row.wakeup_id}`),
        text: "continue",
        attachments: [],
        mode,
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          ThreadManagementThreadNotFoundError: () => setStatus(row, "stale"),
          ThreadManagementThreadArchivedError: () => setStatus(row, "stale"),
        }),
        Effect.mapError((cause) => new ThreadWakeupError({ reason: "delivery", cause })),
      );
    // A stale transition above is terminal and cannot be overwritten here.
    yield* setStatus(row, "delivered");
  });

  const check = Effect.fn("ThreadWakeupService.check")(function* (row: WakeupRow) {
    const timestamp = yield* now;
    if (row.status === "scheduled") {
      if (row.kind === "time") {
        if (row.due_at === null || row.due_at > timestamp) return;
      } else if ((yield* processes.read(row.pid!)) === row.process_identity) {
        return;
      }
      yield* sql`UPDATE thread_wakeups SET status = 'due', due_at = COALESCE(due_at, ${timestamp}), updated_at = ${timestamp}
        WHERE wakeup_id = ${row.wakeup_id} AND status = 'scheduled'`.pipe(
        Effect.mapError(storageError),
      );
      yield* PubSub.publish(changes, ThreadId.make(row.thread_id));
    }
    yield* deliver(row);
  });

  const runDueWork = Effect.gen(function* () {
    const timestamp = yield* now;
    const rows = yield* sql<WakeupRow>`SELECT * FROM thread_wakeups
      WHERE status = 'due' OR (status = 'scheduled' AND (kind = 'process' OR due_at <= ${timestamp}))
      ORDER BY created_at, wakeup_id`.pipe(Effect.mapError(storageError));
    for (const row of rows) {
      yield* check(row).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Thread wakeup remains pending", { wakeupId: row.wakeup_id, cause }),
        ),
      );
    }
  }).pipe(permit.withPermits(1));

  const readPendingWakeups = sql<WakeupRow>`SELECT * FROM thread_wakeups
    WHERE status IN ('scheduled', 'due')
    ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at, wakeup_id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        threadId: ThreadId.make(row.thread_id),
        wakeup: {
          wakeupId: row.wakeup_id,
          kind: row.kind,
          dueAt: row.due_at === null ? null : DateTime.makeUnsafe(row.due_at),
          pid: row.pid,
          status: row.status === "due" ? ("due" as const) : ("scheduled" as const),
        } satisfies OrchestrationV2PendingThreadWakeup,
      })),
    ),
    Effect.mapError(storageError),
  );

  const insert = Effect.fn("ThreadWakeupService.insert")(function* (
    threadId: ThreadId,
    kind: WakeupRow["kind"],
    dueAt: string | null,
    pid: number | null,
    identity: string | null,
    originatingRunId: RunId | null,
    key?: string,
  ) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new ThreadWakeupError({ reason: "delivery", cause })));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
      return yield* new ThreadWakeupError({ reason: "thread_unavailable" });
    }
    const timestamp = yield* now;
    const wakeupId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    // The unique index resolves concurrent registrations, including retries
    // from separate MCP requests, without changing the first registration.
    const row = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO thread_wakeups ${sql.insert({
            wakeup_id: wakeupId,
            thread_id: threadId,
            kind,
            due_at: dueAt,
            pid,
            process_identity: identity,
            originating_run_id: originatingRunId,
            status: kind === "process" && identity === null ? "due" : "scheduled",
            idempotency_key: key ?? null,
            created_at: timestamp,
            updated_at: timestamp,
          })} ON CONFLICT DO NOTHING`;
          const rows =
            yield* sql<WakeupRow>`SELECT * FROM thread_wakeups WHERE wakeup_id = ${wakeupId}
        OR (thread_id = ${threadId} AND kind = ${kind} AND idempotency_key = ${key ?? null})`;
          return rows[0]!;
        }),
      )
      .pipe(Effect.mapError(storageError));
    yield* PubSub.publish(changes, threadId);
    if (
      row.status === "due" ||
      (row.status === "scheduled" && row.kind === "time" && row.due_at! <= timestamp)
    ) {
      yield* check(row).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Thread wakeup awaits scheduler retry", {
            wakeupId: row.wakeup_id,
            cause,
          }),
        ),
      );
    }
    const updated =
      yield* sql<WakeupRow>`SELECT * FROM thread_wakeups WHERE wakeup_id = ${row.wakeup_id}`.pipe(
        Effect.mapError(storageError),
      );
    return result(updated[0]!);
  });

  const scheduleContinue = Effect.fn("ThreadWakeupService.scheduleContinue")(function* (
    threadId: ThreadId,
    input: OrchestratorMcpScheduleContinueInput,
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(OrchestratorMcpScheduleContinueInput)(
      input,
    ).pipe(Effect.mapError(() => new ThreadWakeupError({ reason: "invalid_schedule" })));
    const duplicate = yield* findDuplicate(threadId, "time", decoded.idempotencyKey);
    if (duplicate !== undefined) return result(duplicate);
    const current = yield* DateTime.now;
    const millis =
      decoded.afterSeconds === undefined
        ? Date.parse(decoded.wakeAt!)
        : DateTime.toEpochMillis(current) + decoded.afterSeconds * 1000;
    if (!Number.isFinite(millis) || millis < 0 || millis > 253_402_300_799_999) {
      return yield* new ThreadWakeupError({ reason: "invalid_schedule" });
    }
    return yield* insert(
      threadId,
      "time",
      DateTime.formatIso(DateTime.makeUnsafe(millis)),
      null,
      null,
      null,
      decoded.idempotencyKey,
    );
  }, permit.withPermits(1));

  const continueAfterProcess = Effect.fn("ThreadWakeupService.continueAfterProcess")(function* (
    threadId: ThreadId,
    input: OrchestratorMcpContinueAfterProcessInput,
    originatingRunId: RunId | null = null,
  ) {
    yield* Schema.decodeUnknownEffect(OrchestratorMcpContinueAfterProcessInput)(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProcessIdentity.ProcessIdentityError({
            pid: input.pid,
            reason: "invalid_stat",
            cause,
          }),
      ),
    );
    const duplicate = yield* findDuplicate(threadId, "process", input.idempotencyKey);
    if (duplicate !== undefined) return result(duplicate);
    const identity = yield* processes.read(input.pid);
    return yield* insert(
      threadId,
      "process",
      identity === null ? yield* now : null,
      input.pid,
      identity,
      originatingRunId,
      input.idempotencyKey,
    );
  }, permit.withPermits(1));

  yield* scheduler.register("thread-wakeups", runDueWork);
  return ThreadWakeupService.of({
    scheduleContinue,
    continueAfterProcess,
    readPendingWakeups,
    subscribeChanges: PubSub.subscribe(changes),
    runDueWork,
  });
});

export const layer = Layer.effect(ThreadWakeupService, make);
