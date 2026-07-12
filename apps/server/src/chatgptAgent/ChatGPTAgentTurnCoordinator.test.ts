import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import { makeChatGPTAgentTurnCoordinator } from "./ChatGPTAgentTurnCoordinator.ts";

describe("ChatGPTAgentTurnCoordinator", () => {
  it.effect("serializes work for one thread while allowing independent threads to run", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const coordinator = yield* makeChatGPTAgentTurnCoordinator;
      const releaseFirst = yield* Deferred.make<void>();
      const first = yield* coordinator
        .withThreadLock(
          ThreadId.make("same-thread"),
          Effect.gen(function* () {
            order.push("same:first:start");
            yield* Deferred.await(releaseFirst);
            order.push("same:first:end");
          }),
        )
        .pipe(Effect.forkScoped);
      const second = yield* coordinator
        .withThreadLock(
          ThreadId.make("same-thread"),
          Effect.sync(() => order.push("same:second")),
        )
        .pipe(Effect.forkScoped);
      const other = yield* coordinator
        .withThreadLock(
          ThreadId.make("other-thread"),
          Effect.sync(() => order.push("other")),
        )
        .pipe(Effect.forkScoped);

      yield* Fiber.join(other);
      expect(order).toEqual(["same:first:start", "other"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["same:first:start", "other", "same:first:end", "same:second"]);
    }).pipe(Effect.scoped),
  );

  it.effect("aborts the active bridge task immediately and never replaces a newer task", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeChatGPTAgentTurnCoordinator;
      const threadId = ThreadId.make("cancel-thread");
      const first = yield* coordinator.start(threadId);
      expect(first.controller.signal.aborted).toBe(false);
      expect(yield* coordinator.interrupt(threadId, "stopped")).toBe("stopped");
      expect(first.controller.signal.aborted).toBe(true);
      expect(first.terminalState).toBe("stopped");

      const second = yield* coordinator.start(threadId);
      yield* coordinator.finish(threadId, first);
      expect(yield* coordinator.interrupt(threadId, "interrupted")).toBe("interrupted");
      expect(second.controller.signal.aborted).toBe(true);
    }),
  );
});
