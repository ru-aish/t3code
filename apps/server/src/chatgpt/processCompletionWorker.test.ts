import { describe, expect, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  startProcessCompletionWorker,
  type ProcessCompletionTransport,
} from "./processCompletionWorker.ts";
import type { TerminalEvent } from "./connection.ts";

const completed: TerminalEvent = {
  seq: 1,
  event_id: "persisted-completion-1",
  thread_id: "thread-idle-test",
  kind: "process.completed",
  epoch: 1,
  payload: { processId: "process-123", result: "exit_code=0" },
};

function fixture(gate?: Promise<void>) {
  const acknowledgments: string[] = [];
  const claims: string[] = [];
  const source: ProcessCompletionTransport = {
    async *events(signal) {
      // Source events are durable and replay from seq 0 on every connection.
      if (gate) await gate;
      if (!signal.aborted) yield completed;
    },
    claim: async (event) => {
      claims.push(event.event_id);
      return true;
    },
    acknowledge: async (event) => {
      acknowledgments.push(event.event_id);
    },
  };
  return { source, acknowledgments, claims };
}

describe("detached process completion delivery", () => {
  it.effect("delivers immediately after the originating provider session is idle-released", () =>
    Effect.gen(function* () {
      let publish!: () => void;
      const gate = new Promise<void>((resolve) => {
        publish = resolve;
      });
      const { source, acknowledgments, claims } = fixture(gate);
      const offered =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const instanceScope = yield* Scope.make();
      const releasedSessionScope = yield* Scope.make();
      yield* startProcessCompletionWorker(source, {
        offer: (request) => Queue.offer(offered, request).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(Scope.Scope, instanceScope));

      // Simulate ProviderSessionManager's idle release with no virtual 30m delay.
      // The provider-instance consumer must not be scoped to the released session.
      yield* Scope.close(releasedSessionScope, Exit.void);
      publish();
      const delivered = yield* Queue.take(offered);
      expect(delivered.threadId).toBe(completed.thread_id);
      expect(delivered.messageId).toBe(MessageId.make("process:persisted-completion-1"));
      expect(delivered.notification?.outcome).toBe("completed");
      expect(acknowledgments).toEqual([]);
      expect(claims).toEqual([]);
      const dispatch = delivered.dispatchIfCurrent;
      if (!dispatch) throw new Error("No durable completion receipt");
      yield* Effect.exit(dispatch(Effect.fail("simulated persistence failure")));
      expect(acknowledgments).toEqual([]);
      const accepted = yield* dispatch(Effect.succeed("committed"));
      expect(accepted._tag).toBe("Some");
      expect(acknowledgments).toEqual(["persisted-completion-1"]);
      yield* Scope.close(instanceScope, Exit.void);
    }),
  );

  it.effect("reopens durable events after a transient long-poll failure", () =>
    Effect.gen(function* () {
      let ready!: () => void;
      const firstAttempt = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let attempts = 0;
      const source: ProcessCompletionTransport = {
        async *events() {
          attempts++;
          if (attempts === 1) {
            ready();
            throw new Error("transient transport failure");
          }
          yield completed;
        },
        claim: async () => true,
        acknowledge: async () => {},
      };
      const offered =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const scope = yield* Scope.make();
      yield* startProcessCompletionWorker(source, {
        offer: (request) => Queue.offer(offered, request).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Effect.promise(() => firstAttempt);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const delivered = yield* Queue.take(offered);
      expect(delivered.messageId).toBe(MessageId.make("process:persisted-completion-1"));
      expect(attempts).toBe(2);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("reconciles a completion recorded before the T3 consumer starts", () =>
    Effect.gen(function* () {
      const { source, acknowledgments } = fixture();
      const offered =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const instanceScope = yield* Scope.make();
      yield* startProcessCompletionWorker(source, {
        offer: (request) => Queue.offer(offered, request).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(Scope.Scope, instanceScope));
      const restored = yield* Queue.take(offered);
      expect(restored.messageId).toBe(MessageId.make("process:persisted-completion-1"));
      expect(restored.delivery).toBe("message_text");
      expect(acknowledgments).toHaveLength(0);
      yield* restored.dispatchIfCurrent!(Effect.void);
      expect(acknowledgments).toEqual(["persisted-completion-1"]);
      yield* Scope.close(instanceScope, Exit.void);
    }),
  );
});
