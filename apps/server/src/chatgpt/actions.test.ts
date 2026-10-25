import { expect, it } from "@effect/vitest";
import {
  ChatGPTThreadRefreshError,
  ThreadId,
  RunId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
  type ThreadPullRequestLink,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Actions from "./actions.ts";
import * as ThreadSync from "./threadSync.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { messageQuestionArtifacts } from "../orchestration-v2/userInputArtifacts.ts";

it.effect(
  "reports active child work and queued results without waiting on already acknowledged results",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("parent-wait-state");
        const runId = RunId.make("parent-run");
        const initial = idleThreadProjection(liveThreadShell(threadId));
        const child: OrchestrationV2Subagent = {
          id: NodeId.make("child-task"),
          threadId,
          runId,
          parentNodeId: NodeId.make("parent-node"),
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("chatgpt"),
          providerInstanceId: ProviderInstanceId.make("chatgpt"),
          providerThreadId: null,
          childThreadId: ThreadId.make("child-thread"),
          nativeTaskRef: null,
          prompt: "Review changes",
          title: "Review",
          model: null,
          status: "running",
          result: null,
          startedAt: initial.updatedAt,
          completedAt: null,
          updatedAt: initial.updatedAt,
        };
        let projection: OrchestrationV2ThreadProjection = { ...initial, subagents: [child] };
        const base = Layer.mergeAll(
          Actions.layer,
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.sync(() => projection),
          }),
          Layer.mock(ThreadSync.ChatGPTThreadSync)({}),
        );
        yield* Effect.gen(function* () {
          const actions = yield* Actions.ChatGPTActions;
          expect(
            yield* actions.readWaitState(threadId, RunId.make("later-parent-run")),
          ).toMatchObject({ kind: "subagents", message: expect.stringContaining("Waiting") });
          projection = {
            ...initial,
            subagents: [
              {
                ...child,
                status: "completed",
                completionDelivery: { state: "pending", observedByRunId: null },
              },
            ],
          };
          expect(yield* actions.readWaitState(threadId, runId)).toMatchObject({
            kind: "subagents",
            message: expect.stringContaining("ready"),
          });
          projection = {
            ...initial,
            subagents: [
              {
                ...child,
                status: "completed",
                completionDelivery: { state: "acknowledged", observedByRunId: runId },
              },
            ],
          };
          expect(yield* actions.readWaitState(threadId, runId)).toBeNull();
          projection = { ...initial, subagents: [{ ...child, origin: "provider_native" }] };
          expect(yield* actions.readWaitState(threadId, runId)).toBeNull();
          const question = messageQuestionArtifacts({
            threadId,
            runId,
            rootNodeId: NodeId.make("parent-root"),
            providerThreadId: null,
            providerTurnId: null,
            requestId: RuntimeRequestId.make("phone-question"),
            questions: [{ id: "phone", header: "Phone", question: "Which phone?", options: [] }],
            ordinal: 1,
            now: initial.updatedAt,
          });
          projection = { ...initial, nodes: [question.node], runtimeRequests: [question.request] };
          expect(yield* actions.readWaitState(threadId, RunId.make("later-run"))).toMatchObject({
            kind: "user_input",
          });
          projection = {
            ...projection,
            runtimeRequests: [
              { ...question.request, status: "resolved", resolvedAt: initial.updatedAt },
            ],
          };
          expect(yield* actions.readWaitState(threadId, runId)).toMatchObject({
            kind: "user_input",
            message: expect.stringContaining("finished"),
          });
          expect(yield* actions.readWaitState(threadId, RunId.make("later-run"))).toBeNull();
          const at = "2026-10-25T10:00:00Z";
          const link: ThreadPullRequestLink = {
            host: "github.com",
            repository: "ru-aish/t3code",
            number: 1,
            url: "https://github.com/ru-aish/t3code/pull/1",
            source: "agent",
            linkedAt: at,
            snapshot: null,
            stack: null,
            watch: {
              startedAt: at,
              headSha: null,
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: at,
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          };
          projection = { ...initial, thread: { ...initial.thread, pullRequests: [link] } };
          expect(yield* actions.readWaitState(threadId, runId)).toMatchObject({
            kind: "pull_request",
          });
          projection = initial;
          expect(yield* actions.readWaitState(threadId, runId)).toBeNull();
        }).pipe(Effect.provide(Layer.merge(base, Actions.layerWorker.pipe(Layer.provide(base)))));
      }),
    ),
);

it.effect("runtime recovery waits for the Refresh service to persist a thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const threadId = ThreadId.make("runtime-recovered-thread");
      let returned = false;
      const base = Layer.mergeAll(
        Actions.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(threadId))),
        }),
        Layer.mock(ThreadSync.ChatGPTThreadSync)({
          refresh: (target) =>
            Effect.gen(function* () {
              expect(target).toBe(threadId);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(commit);
              return { messageCount: 1 };
            }),
        }),
      );
      const layer = Layer.merge(base, Actions.layerWorker.pipe(Layer.provide(base)));
      yield* Effect.gen(function* () {
        const actions = yield* Actions.ChatGPTActions;
        const recovery = yield* actions.refreshThread(threadId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              returned = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        expect(returned).toBe(false);
        expect(yield* actions.readWaitState(threadId, RunId.make("refreshing-run"))).toBeNull();
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(recovery);
        expect(returned).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a failed refresh does not stop later recovery requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("offline-thread");
      let reads = 0;
      const base = Layer.mergeAll(
        Actions.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ThreadSync.ChatGPTThreadSync)({
          refresh: () =>
            Effect.suspend(() =>
              ++reads === 1
                ? Effect.fail(new ChatGPTThreadRefreshError({ threadId }))
                : Effect.succeed({ messageCount: 1 }),
            ),
        }),
      );
      const layer = Layer.merge(base, Actions.layerWorker.pipe(Layer.provide(base)));
      yield* Effect.gen(function* () {
        const actions = yield* Actions.ChatGPTActions;
        expect((yield* Effect.exit(actions.refreshThread(threadId)))._tag).toBe("Failure");
        yield* actions.refreshThread(threadId);
        expect(reads).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
