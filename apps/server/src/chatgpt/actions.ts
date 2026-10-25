import { CommandId, ThreadId, isOrchestrationV2WorkActive, type RunId } from "@t3tools/contracts";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
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
export type ChatGPTWaitState = {
  kind: "user_input" | "subagents" | "pull_request";
  message: string;
};
type WaitStateRequest = {
  threadId: ThreadId;
  runId: RunId;
  result: Deferred.Deferred<ChatGPTWaitState | null, ChatGPTActionError>;
};
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
  readonly readWaitState: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<ChatGPTWaitState | null, ChatGPTActionError>;
  readonly takeWaitState: Effect.Effect<WaitStateRequest>;
  readonly take: Effect.Effect<Request>;
}>("t3/chatgpt/ChatGPTActions", {
  defaultValue: () => ({
    linkPullRequest: () => Effect.fail(new ChatGPTActionError({})),
    refreshThread: () => Effect.fail(new ChatGPTActionError({})),
    readWaitState: () => Effect.succeed(null),
    takeWaitState: Effect.never,
    take: Effect.never,
  }),
}) {}
export const layer = Layer.effect(
  ChatGPTActions,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Request>();
    const waitStates = yield* Queue.unbounded<WaitStateRequest>();
    return {
      readWaitState: (threadId, runId) =>
        Effect.gen(function* () {
          const result = yield* Deferred.make<ChatGPTWaitState | null, ChatGPTActionError>();
          yield* Queue.offer(waitStates, { threadId, runId, result });
          return yield* Deferred.await(result);
        }),
      takeWaitState: Queue.take(waitStates),
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
    // Refresh can wait on the adapter actor. Read wait state independently so
    // an actor reconciling that refresh cannot wait on the refresh's own queue.
    yield* Effect.gen(function* () {
      const request = yield* actions.takeWaitState;
      yield* Effect.gen(function* () {
        const projection = yield* orchestrator.getThreadRecords(request.threadId, [
          "nodes",
          "runtimeRequests",
          "subagents",
        ]);
        const nodes = new Set(
          projection.nodes.filter((node) => node.runId === request.runId).map((node) => node.id),
        );
        if (
          projection.runtimeRequests.some(
            (item) =>
              item.kind === "user_input" &&
              item.status === "pending" &&
              item.responseCapability.type === "message",
          )
        ) {
          return { kind: "user_input", message: "Waiting for your answer." } as const;
        }
        if (
          projection.runtimeRequests.some(
            (item) =>
              item.kind === "user_input" &&
              item.responseCapability.type === "message" &&
              nodes.has(item.nodeId),
          )
        ) {
          return { kind: "user_input", message: "User input request finished." } as const;
        }
        const delegated = projection.subagents.filter((item) => item.origin === "app_owned");
        if (delegated.some((item) => isOrchestrationV2WorkActive(item.status))) {
          return {
            kind: "subagents",
            message:
              "Waiting for delegated task results. T3 will resume this thread when they arrive.",
          } as const;
        }
        if (
          delegated.some(
            (item) =>
              item.runId === request.runId &&
              (item.completionDelivery?.state === "pending" ||
                item.completionDelivery?.state === "claimed"),
          )
        ) {
          return {
            kind: "subagents",
            message: "Delegated task results are ready. T3 will resume this thread to read them.",
          } as const;
        }
        if (threadPullRequestsOf(projection.thread).some((link) => link.watch !== undefined)) {
          return {
            kind: "pull_request",
            message:
              "Watching the pull request for check and review updates. T3 will resume this thread when something changes.",
          } as const;
        }
        return null;
      }).pipe(
        Effect.flatMap((state) => Deferred.succeed(request.result, state)),
        Effect.catch((cause) => Deferred.fail(request.result, new ChatGPTActionError({ cause }))),
      );
    }).pipe(Effect.forever, Effect.forkScoped);
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
