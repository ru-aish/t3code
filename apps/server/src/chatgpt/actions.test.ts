import { expect, it } from "@effect/vitest";
import { ChatGPTThreadRefreshError, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Actions from "./actions.ts";
import * as ThreadSync from "./threadSync.ts";

it.effect("runtime recovery waits for the Refresh service to persist a thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const threadId = ThreadId.make("runtime-recovered-thread");
      let returned = false;
      const base = Layer.mergeAll(
        Actions.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({}),
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
