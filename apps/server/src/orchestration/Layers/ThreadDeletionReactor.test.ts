import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  ChatGPTAgentThreadBindings,
  layer as chatGPTAgentThreadBindingsLayer,
} from "../../chatgptAgent/ThreadBinding.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

const EventsForTest = Context.Service<Queue.Queue<OrchestrationEvent>>(
  "ThreadDeletionReactorTest/Events",
);
const ThreadDeletionTestHarness = Context.Service<{
  readonly bindings: ChatGPTAgentThreadBindings["Service"];
  readonly events: Queue.Queue<OrchestrationEvent>;
}>("ThreadDeletionReactorTest/Harness");

const orchestrationEngineTestLayer = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* () {
    const events = yield* EventsForTest;
    return {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("dispatch should not be called during thread cleanup"),
      streamDomainEvents: Stream.fromQueue(events),
    } satisfies OrchestrationEngineShape;
  }),
);

const threadDeletionReactorTestLayer = effectIt.layer(
  Layer.mergeAll(
    ThreadDeletionReactorLive.pipe(Layer.provideMerge(orchestrationEngineTestLayer)),
    Layer.effect(
      ThreadDeletionTestHarness,
      Effect.gen(function* () {
        return {
          bindings: yield* ChatGPTAgentThreadBindings,
          events: yield* EventsForTest,
        };
      }),
    ),
  ).pipe(
    Layer.provideMerge(chatGPTAgentThreadBindingsLayer),
    Layer.provideMerge(Layer.effect(EventsForTest, Queue.unbounded<OrchestrationEvent>())),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.mock(ProviderService, {
        stopSession: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(TerminalManager.TerminalManager, {
        close: () => Effect.void,
      }),
    ),
  ),
);

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

threadDeletionReactorTestLayer("ThreadDeletionReactor", (it) => {
  it.effect("removes the durable ChatGPT Agent binding when a thread is deleted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-delete-chatgpt-binding");
      const { bindings, events } = yield* ThreadDeletionTestHarness;
      const reactor = yield* ThreadDeletionReactor;
      yield* bindings.upsert({
        threadId,
        conversationId: "11111111-1111-4111-8111-111111111111",
        workspaceEnvelopeSentAt: null,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      });
      yield* reactor.start();
      yield* Effect.yieldNow;
      yield* Queue.offer(events, {
        type: "thread.deleted",
        sequence: 1,
        eventId: EventId.make("evt-delete-chatgpt-binding"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-07-13T00:01:00.000Z",
        commandId: CommandId.make("cmd-delete-chatgpt-binding"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-delete-chatgpt-binding"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: "2026-07-13T00:01:00.000Z",
        },
      });
      yield* Effect.yieldNow;
      yield* reactor.drain;

      expect(Option.isNone(yield* bindings.get(threadId))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
