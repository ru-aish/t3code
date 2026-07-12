import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

export type ChatGPTAgentTurnTerminalState = "interrupted" | "stopped";

export interface ChatGPTAgentActiveTurn {
  readonly controller: AbortController;
  terminalState: ChatGPTAgentTurnTerminalState;
}

export interface ChatGPTAgentTurnCoordinator {
  readonly withThreadLock: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly start: (
    threadId: ThreadId,
    terminalState?: ChatGPTAgentTurnTerminalState,
  ) => Effect.Effect<ChatGPTAgentActiveTurn>;
  readonly finish: (threadId: ThreadId, task: ChatGPTAgentActiveTurn) => Effect.Effect<void>;
  readonly interrupt: (
    threadId: ThreadId,
    terminalState: ChatGPTAgentTurnTerminalState,
  ) => Effect.Effect<ChatGPTAgentTurnTerminalState | undefined>;
}

/**
 * Per-thread serialization with independently runnable threads. Stop is not
 * serialized: it aborts the current bridge request immediately, while the
 * request itself owns projection of the terminal lifecycle state.
 */
export const makeChatGPTAgentTurnCoordinator = Effect.gen(function* () {
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const active = yield* SynchronizedRef.make(new Map<string, ChatGPTAgentActiveTurn>());

  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = Option.fromNullishOr(current.get(threadId));
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
          ),
        onSome: (lock) => Effect.succeed([lock, current] as const),
      });
    });

  const withThreadLock: ChatGPTAgentTurnCoordinator["withThreadLock"] = (threadId, effect) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));

  const start: ChatGPTAgentTurnCoordinator["start"] = (threadId, terminalState = "interrupted") =>
    SynchronizedRef.modify(active, (current) => {
      const task: ChatGPTAgentActiveTurn = {
        controller: new AbortController(),
        terminalState,
      };
      return [task, new Map(current).set(threadId, task)] as const;
    });

  const finish: ChatGPTAgentTurnCoordinator["finish"] = (threadId, task) =>
    SynchronizedRef.update(active, (current) => {
      if (current.get(threadId) !== task) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  const interrupt: ChatGPTAgentTurnCoordinator["interrupt"] = (threadId, terminalState) =>
    SynchronizedRef.modify(active, (current) => {
      const task = current.get(threadId);
      if (!task) return [undefined, current] as const;
      task.terminalState = terminalState;
      task.controller.abort();
      return [terminalState, current] as const;
    });

  return { withThreadLock, start, finish, interrupt } satisfies ChatGPTAgentTurnCoordinator;
});
