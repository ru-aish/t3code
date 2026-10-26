import {
  ChatGPTThreadRefreshError,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { messageQuestionArtifacts } from "../orchestration-v2/userInputArtifacts.ts";
import * as ProjectService from "../project/ProjectService.ts";

const isRefreshError = Schema.is(ChatGPTThreadRefreshError);

export class ChatGPTThreadSync extends Context.Service<
  ChatGPTThreadSync,
  {
    readonly refresh: (
      threadId: ThreadId,
    ) => Effect.Effect<{ messageCount: number }, ChatGPTThreadRefreshError>;
  }
>()("t3/chatgpt/threadSync/ChatGPTThreadSync") {}

export const layer = Layer.effect(
  ChatGPTThreadSync,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const sink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectService.ProjectService;
    return ChatGPTThreadSync.of({
      refresh: (threadId) =>
        Effect.gen(function* () {
          const projection = yield* projections.getThreadProjection(threadId);
          const providerThread = projection.providerThreads.find(
            (thread) => thread.id === projection.thread.activeProviderThreadId,
          );
          const savedSession = projection.providerSessions.find(
            (session) => session.id === providerThread?.providerSessionId,
          );
          if (!providerThread || providerThread.driver !== "chatgpt")
            return yield* new ChatGPTThreadRefreshError({ threadId });
          const providerSessionId = providerThread.providerSessionId;
          if (!providerSessionId) return yield* new ChatGPTThreadRefreshError({ threadId });
          const modelSelection = [...projection.runs]
            .reverse()
            .find((run) => run.providerThreadId === providerThread.id)?.modelSelection;
          if (!modelSelection) return yield* new ChatGPTThreadRefreshError({ threadId });
          const live = yield* sessions.get(providerSessionId);
          const cwd = savedSession?.cwd ?? projection.thread.worktreePath;
          const project = cwd
            ? Option.none()
            : yield* projects.getById(projection.thread.projectId);
          const workspace = cwd ?? Option.getOrUndefined(project)?.workspaceRoot;
          if (!workspace) return yield* new ChatGPTThreadRefreshError({ threadId });
          const runtime = Option.isSome(live)
            ? live.value
            : yield* sessions.open({
                threadId,
                providerSessionId,
                modelSelection,
                runtimePolicy: {
                  cwd: workspace,
                  runtimeMode: projection.thread.runtimeMode,
                  interactionMode: projection.thread.interactionMode,
                },
                ...(savedSession ? { resumeFromSession: savedSession } : {}),
              });
          const snapshot = yield* runtime.readThreadSnapshot({
            providerThread,
            existingProjection: projection,
          });
          // Idle threads have no run subscriber to persist adapter events.
          // Commit the reconciled transcript before acknowledging a refresh.
          const current = yield* projections.getThreadProjection(threadId);
          const knownMessages = new Map(current.messages.map((message) => [message.id, message]));
          const knownItems = new Map(current.turnItems.map((item) => [item.id, item]));
          const knownRequests = new Set(current.runtimeRequests.map((request) => request.id));
          const changes: ProviderAdapter.ProviderAdapterV2Event[] = [];
          for (const request of snapshot.runtimeRequests) {
            if (
              knownRequests.has(request.id) ||
              request.kind !== "user_input" ||
              request.status !== "pending" ||
              request.responseCapability.type !== "message"
            )
              continue;
            const item = snapshot.turnItems?.find(
              (item) => item.type === "user_input_request" && item.requestId === request.id,
            );
            if (item?.type !== "user_input_request") continue;
            const run = current.runs.find((run) => run.id === item.runId);
            if (!run?.rootNodeId) continue;
            const { node } = messageQuestionArtifacts({
              threadId,
              runId: run.id,
              rootNodeId: run.rootNodeId,
              providerThreadId: item.providerThreadId,
              providerTurnId: item.providerTurnId,
              requestId: request.id,
              questions: item.questions,
              ordinal: item.ordinal,
              now: request.createdAt,
            });
            if (node.id !== request.nodeId || node.id !== item.nodeId) continue;
            if (!current.nodes.some((saved) => saved.id === node.id))
              changes.push({ type: "node.updated", driver: runtime.driver, node });
            changes.push({
              type: "runtime_request.updated",
              driver: runtime.driver,
              runtimeRequest: request,
            });
          }
          for (const message of snapshot.messages) {
            const previous = knownMessages.get(message.id);
            if (previous?.text === message.text && previous.streaming === message.streaming)
              continue;
            changes.push({ type: "message.updated", driver: runtime.driver, message });
          }
          for (const item of snapshot.turnItems ?? []) {
            const previous = knownItems.get(item.id);
            // Answers are app-owned; a native snapshot cannot reopen a saved question.
            if (
              item.type === "user_input_request" &&
              (previous || knownRequests.has(item.requestId))
            )
              continue;
            if (
              previous &&
              (previous.type === "reasoning" || previous.type === "assistant_message") &&
              (item.type === "reasoning" || item.type === "assistant_message") &&
              previous.type === item.type &&
              previous.text === item.text &&
              previous.streaming === item.streaming &&
              previous.status === item.status &&
              previous.nativeItemRef?.nativeId === item.nativeItemRef?.nativeId
            )
              continue;
            changes.push({ type: "turn_item.updated", driver: runtime.driver, turnItem: item });
          }
          const events: OrchestrationV2DomainEvent[] = [];
          for (const event of changes) {
            const normalized = yield* ingestor.normalize({
              providerSessionId,
              providerInstanceId: runtime.instanceId,
              threadId,
              event,
            });
            events.push(...normalized);
          }
          if (events.length) yield* sink.write({ events });
          return { messageCount: snapshot.messages.length };
        }).pipe(
          Effect.mapError((cause) =>
            isRefreshError(cause) ? cause : new ChatGPTThreadRefreshError({ threadId, cause }),
          ),
        ),
    });
  }),
);
