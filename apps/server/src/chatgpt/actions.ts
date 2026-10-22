import { CommandId, ThreadId } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadSync from "./threadSync.ts";

export class ChatGPTActionError extends Schema.TaggedError<ChatGPTActionError>()(
  "ChatGPTActionError",
  { cause: Schema.optional(Schema.Defect()) },
) {}
type Request =
  | {
      kind: "link_pr";
      threadId: ThreadId;
      url: string;
      eventId: string;
      result: Deferred.Deferred<void, ChatGPTActionError>;
    }
  | { kind: "refresh"; threadId: ThreadId; result: Deferred.Deferred<void, ChatGPTActionError> };
export class ChatGPTActions extends Context.Reference<{
  readonly linkPullRequest: (
    threadId: ThreadId,
    url: string,
    eventId: string,
  ) => Effect.Effect<void, ChatGPTActionError>;
  readonly refreshThread: (threadId: ThreadId) => Effect.Effect<void, ChatGPTActionError>;
  readonly take: Effect.Effect<Request>;
}>("t3/chatgpt/ChatGPTActions", {
  defaultValue: () => ({
    linkPullRequest: () => Effect.fail(new ChatGPTActionError({})),
    refreshThread: () => Effect.fail(new ChatGPTActionError({})),
    take: Effect.never,
  }),
}) {}
export const layer = Layer.effect(
  ChatGPTActions,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Request>();
    return {
      linkPullRequest: (threadId, url, eventId) =>
        Effect.gen(function* () {
          const result = yield* Deferred.make<void, ChatGPTActionError>();
          yield* Queue.offer(queue, { kind: "link_pr", threadId, url, eventId, result });
          yield* Deferred.await(result);
        }),
      refreshThread: (threadId) =>
        Effect.gen(function* () {
          const result = yield* Deferred.make<void, ChatGPTActionError>();
          yield* Queue.offer(queue, { kind: "refresh", threadId, result });
          yield* Deferred.await(result);
        }),
      take: Queue.take(queue),
    };
  }),
);
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const actions = yield* ChatGPTActions;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadSync = yield* ThreadSync.ChatGPTThreadSync;
    yield* Effect.gen(function* () {
      const request = yield* actions.take;
      if (request.kind === "refresh") {
        yield* threadSync.refresh(request.threadId).pipe(
          Effect.andThen(Deferred.succeed(request.result, undefined)),
          Effect.catch((cause) => Deferred.fail(request.result, new ChatGPTActionError({ cause }))),
        );
        return;
      }
      const target = parseChangeRequestUrl(request.url);
      if (!target) {
        yield* Deferred.fail(request.result, new ChatGPTActionError({}));
        return;
      }
      yield* orchestrator
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`terminal-pr:${request.eventId}`),
          threadId: request.threadId,
          host: target.host,
          repository: target.repository,
          number: target.number,
          url: request.url,
          source: "agent",
        })
        .pipe(
          Effect.andThen(Deferred.succeed(request.result, undefined)),
          Effect.catch((cause) => Deferred.fail(request.result, new ChatGPTActionError({ cause }))),
        );
    }).pipe(Effect.forever, Effect.forkScoped);
  }),
);
