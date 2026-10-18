import { ChatGPTThreadRefreshError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

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
          if (!providerThread || providerThread.driver !== "chatgpt" || !savedSession)
            return yield* new ChatGPTThreadRefreshError({ threadId });
          const modelSelection = [...projection.runs].reverse().find(run => run.providerThreadId === providerThread.id)?.modelSelection;
      if (!modelSelection) return yield* new ChatGPTThreadRefreshError({ threadId });
      const live = yield* sessions.get(savedSession.id);
          const runtime = Option.isSome(live)
            ? live.value
            : yield* sessions.open({
                threadId,
                providerSessionId: savedSession.id,
                modelSelection,
                runtimePolicy: {
                  cwd: savedSession.cwd,
                  runtimeMode: projection.thread.runtimeMode,
                  interactionMode: projection.thread.interactionMode,
                },
                resumeFromSession: savedSession,
              });
          const snapshot = yield* runtime.readThreadSnapshot({
            providerThread,
            existingProjection: projection,
          });
          return { messageCount: snapshot.messages.length };
        }).pipe(
          Effect.mapError((cause) =>
            isRefreshError(cause)
              ? cause
              : new ChatGPTThreadRefreshError({ threadId, cause }),
          ),
        ),
    });
  }),
);
