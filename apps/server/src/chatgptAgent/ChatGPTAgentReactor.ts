import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ChatGPTDesktopBridge,
  ChatGPTDesktopBridgeError,
} from "./ChatGPTDesktopBridge.ts";
import { ChatGPTAgentThreadBindings } from "./ThreadBinding.ts";

export const CHATGPT_AGENT_INSTANCE_ID =
  ProviderInstanceId.make("chatgptAgent");
export const CHATGPT_AGENT_MODEL = "desktop";
export const isChatGPTAgentSelection = (
  selection: { readonly instanceId: ProviderInstanceId } | undefined,
): boolean => selection?.instanceId === CHATGPT_AGENT_INSTANCE_ID;

export class ChatGPTAgentReactor extends Context.Service<
  ChatGPTAgentReactor,
  { readonly start: () => Effect.Effect<void, never> }
>()("t3/chatgptAgent/Reactor") {}

const now = Effect.map(DateTime.now, DateTime.formatIso);
const envelope = (workspace: string) =>
  `Workspace: ${workspace}. This folder is the working space.`;

export const ChatGPTAgentReactorLive = Layer.effect(
  ChatGPTAgentReactor,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const bridge = yield* ChatGPTDesktopBridge;
    const bindings = yield* ChatGPTAgentThreadBindings;
    const crypto = yield* Crypto.Crypto;
    const commandId = (label: string) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((id) => CommandId.make(`chatgpt-agent:${label}:${id}`)),
      );
    const eventId = crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
    const activity = (
      threadId: ThreadId,
      tone: "info" | "error",
      summary: string,
      detail: string,
    ) =>
      Effect.gen(function* () {
        const createdAt = yield* now;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId("activity"),
          threadId,
          createdAt,
          activity: {
            id: yield* eventId,
            kind: "chatgpt-agent",
            tone,
            summary,
            payload: { detail },
            turnId: null,
            createdAt,
          },
        });
      });
    const process = Effect.fn("ChatGPTAgentReactor.process")(function* (
      event: Extract<
        OrchestrationEvent,
        { type: "thread.turn-start-requested" }
      >,
    ) {
      const config = yield* settings.getSettings;
      if (!config.chatgptAgent.enabled)
        return yield* activity(
          event.payload.threadId,
          "error",
          "ChatGPT Agent unavailable",
          "Enable ChatGPT Agent in Settings and connect the local desktop app.",
        );
      const thread = yield* snapshots.getThreadDetailById(
        event.payload.threadId,
      );
      if (Option.isNone(thread)) return;
      if (
        !isChatGPTAgentSelection(event.payload.modelSelection) &&
        !isChatGPTAgentSelection(thread.value.modelSelection)
      ) {
        return;
      }
      const user = thread.value.messages.find(
        (message) =>
          message.id === event.payload.messageId && message.role === "user",
      );
      if (!user)
        return yield* activity(
          event.payload.threadId,
          "error",
          "ChatGPT Agent turn failed",
          "The requested user message was not found.",
        );
      if ((user.attachments?.length ?? 0) > 0)
        return yield* activity(
          event.payload.threadId,
          "error",
          "ChatGPT Agent turn failed",
          "ChatGPT Agent currently supports text messages only.",
        );
      const snapshot = yield* snapshots.getSnapshot();
      const project = snapshot.projects.find(
        (candidate) => candidate.id === thread.value.projectId,
      );
      const workspace = resolveThreadWorkspaceCwd({
        thread: thread.value,
        projects: project ? [project] : [],
      });
      if (!workspace)
        return yield* activity(
          event.payload.threadId,
          "error",
          "ChatGPT Agent turn failed",
          "No workspace path could be resolved for this thread.",
        );
      const existing = yield* bindings.get(event.payload.threadId);
      const binding = Option.getOrUndefined(existing);
      const text =
        binding?.workspaceEnvelopeSentAt === null || binding === undefined
          ? `${envelope(workspace)}\n\n${user.text}`
          : user.text;
      yield* activity(
        event.payload.threadId,
        "info",
        "ChatGPT Agent started",
        binding
          ? "Reopening the bound ChatGPT conversation."
          : "Creating a ChatGPT conversation.",
      );
      const assistantMessageId = MessageId.make(yield* crypto.randomUUIDv4);
      let conversationId = binding?.conversationId;
      const streamed = yield* Stream.fromAsyncIterable(
        bridge.send({
          endpoint: config.chatgptAgent.cdpEndpoint,
          ...(conversationId ? { conversationId } : {}),
          text,
        }),
        (cause) =>
          cause instanceof ChatGPTDesktopBridgeError
            ? cause
            : new ChatGPTDesktopBridgeError({
                kind: "unavailable",
                detail: "Could not communicate with ChatGPT Desktop.",
              }),
      ).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            conversationId = chunk.conversationId;
            if (binding === undefined && conversationId) {
              const createdAt = yield* now;
              yield* bindings.upsert({
                threadId: event.payload.threadId,
                conversationId,
                workspaceEnvelopeSentAt: null,
                createdAt,
                updatedAt: createdAt,
              });
            }
            if (chunk.text.length > 0)
              yield* engine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: yield* commandId("delta"),
                threadId: event.payload.threadId,
                messageId: assistantMessageId,
                delta: chunk.text,
                createdAt: yield* now,
              });
          }),
        ),
        Effect.as(true),
        Effect.catchTag("ChatGPTDesktopBridgeError", (error) =>
          activity(
            event.payload.threadId,
            "error",
            "ChatGPT Agent turn failed",
            error.detail,
          ).pipe(Effect.as(false)),
        ),
      );
      if (
        streamed &&
        conversationId &&
        (binding === undefined || binding.workspaceEnvelopeSentAt === null)
      )
        yield* bindings.markWorkspaceEnvelopeSent(
          event.payload.threadId,
          yield* now,
        );
      if (streamed)
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* commandId("complete"),
          threadId: event.payload.threadId,
          messageId: assistantMessageId,
          createdAt: yield* now,
        });
    });
    const start = Effect.fn("ChatGPTAgentReactor.start")(function* () {
      yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.turn-start-requested"
          ? process(event).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logWarning("chatgpt agent reactor failed", {
                      cause: Cause.pretty(cause),
                    }),
              ),
            )
          : Effect.void,
      ).pipe(Effect.forkScoped);
    });
    return { start };
  }),
);
