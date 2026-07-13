import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  CHATGPT_AGENT_INSTANCE_ID,
  isChatGPTAgentThread,
  isChatGPTAgentTurnStart,
  normalizeChatGPTAgentModel,
} from "./ChatGPTAgentRouter.ts";
import { ChatGPTDesktopBridge, ChatGPTDesktopBridgeError } from "./ChatGPTDesktopBridge.ts";
import { ChatGPTDesktopController } from "./ChatGPTDesktopController.ts";
import {
  makeChatGPTAgentTurnCoordinator,
  type ChatGPTAgentActiveTurn,
  type ChatGPTAgentTurnTerminalState,
} from "./ChatGPTAgentTurnCoordinator.ts";
import { ChatGPTAgentThreadBindings } from "./ThreadBinding.ts";

export {
  CHATGPT_AGENT_INSTANCE_ID,
  CHATGPT_AGENT_MODEL,
  isChatGPTAgentSelection,
} from "./ChatGPTAgentRouter.ts";

export class ChatGPTAgentReactor extends Context.Service<
  ChatGPTAgentReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/chatgptAgent/Reactor") {}

const now = Effect.map(DateTime.now, DateTime.formatIso);
const envelope = (workspace: string) =>
  `Workspace: ${workspace}. This folder is the working space.`;

type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type InterruptEvent = Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>;
type SessionStopEvent = Extract<OrchestrationEvent, { type: "thread.session-stop-requested" }>;

const toBridgeError = (cause: unknown) =>
  cause instanceof ChatGPTDesktopBridgeError
    ? cause
    : new ChatGPTDesktopBridgeError({
        kind: "unavailable",
        detail: "Could not communicate with ChatGPT Desktop.",
      });

export const ChatGPTAgentReactorLive = Layer.effect(
  ChatGPTAgentReactor,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const bridge = yield* ChatGPTDesktopBridge;
    const desktopController = yield* ChatGPTDesktopController;
    const bindings = yield* ChatGPTAgentThreadBindings;
    const crypto = yield* Crypto.Crypto;
    const coordinator = yield* makeChatGPTAgentTurnCoordinator;
    const claimedStartEvents = new Set<string>();

    const commandId = (label: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`chatgpt-agent:${label}:${id}`)));
    const eventId = crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

    const activity = (
      threadId: ThreadId,
      turnId: TurnId,
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
            turnId,
            createdAt,
          },
        });
      });

    const setSession = (
      thread: {
        readonly id: ThreadId;
        readonly runtimeMode: OrchestrationSession["runtimeMode"];
      },
      status: OrchestrationSession["status"],
      turnId: TurnId | null,
      lastError: string | null = null,
    ) =>
      Effect.gen(function* () {
        const updatedAt = yield* now;
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: yield* commandId(`session-${status}`),
          threadId: thread.id,
          createdAt: updatedAt,
          session: {
            threadId: thread.id,
            status,
            providerName: "ChatGPT Agent",
            providerInstanceId: CHATGPT_AGENT_INSTANCE_ID,
            runtimeMode: thread.runtimeMode,
            activeTurnId: turnId,
            lastError,
            updatedAt,
          },
        });
      });

    const terminalState = (
      thread: { readonly id: ThreadId; readonly runtimeMode: OrchestrationSession["runtimeMode"] },
      turnId: TurnId,
      state: "ready" | "error" | ChatGPTAgentTurnTerminalState,
      detail?: string,
    ) =>
      Effect.gen(function* () {
        if (state === "error") {
          const message = detail ?? "ChatGPT Agent request failed.";
          yield* activity(thread.id, turnId, "error", "ChatGPT Agent turn failed", message);
          yield* setSession(thread, "error", null, message);
          return;
        }
        if (state === "ready") {
          yield* setSession(thread, "ready", null);
          return;
        }
        yield* activity(
          thread.id,
          turnId,
          "info",
          state === "stopped" ? "ChatGPT Agent stopped" : "ChatGPT Agent turn interrupted",
          "The ChatGPT Desktop request was cancelled; late response deltas were discarded.",
        );
        yield* setSession(thread, state, null);
      });

    const process = Effect.fn("ChatGPTAgentReactor.process")(function* (
      event: TurnStartEvent,
      task: ChatGPTAgentActiveTurn,
    ) {
      const threadOption = yield* snapshots.getThreadDetailById(event.payload.threadId);
      if (Option.isNone(threadOption)) return;
      const thread = threadOption.value;
      if (
        !isChatGPTAgentTurnStart({
          thread,
          requestedModelSelection: event.payload.modelSelection,
        })
      ) {
        return;
      }

      const turnId = TurnId.make(yield* crypto.randomUUIDv4);
      const assistantMessageId = MessageId.make(yield* crypto.randomUUIDv4);
      yield* setSession(thread, "running", turnId);
      yield* activity(
        thread.id,
        turnId,
        "info",
        "ChatGPT Agent started",
        "Dispatching the turn through ChatGPT Desktop.",
      );

      if (task.controller.signal.aborted) {
        return yield* terminalState(thread, turnId, task.terminalState);
      }

      const config = yield* settings.getSettings;
      if (!config.chatgptAgent.enabled) {
        return yield* terminalState(
          thread,
          turnId,
          "error",
          "Enable ChatGPT Agent in Settings and connect the local desktop app.",
        );
      }
      const user = thread.messages.find(
        (message) => message.id === event.payload.messageId && message.role === "user",
      );
      if (!user) {
        return yield* terminalState(
          thread,
          turnId,
          "error",
          "The requested user message was not found.",
        );
      }
      const imagesOrError = yield* Effect.tryPromise({
        try: async () =>
          Promise.all(
            (user.attachments ?? []).map(async (attachment) => {
              if (attachment.type !== "image" || !attachment.mimeType.startsWith("image/")) {
                throw new ChatGPTDesktopBridgeError({
                  kind: "incompatible",
                  detail: `ChatGPT Agent only supports image attachments (${attachment.name} is unsupported).`,
                });
              }
              const path = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!path) {
                throw new ChatGPTDesktopBridgeError({
                  kind: "incompatible",
                  detail: `Could not resolve image attachment ${attachment.name}.`,
                });
              }
              let bytes: Buffer;
              try {
                bytes = await NodeFSP.readFile(path);
              } catch {
                throw new ChatGPTDesktopBridgeError({
                  kind: "incompatible",
                  detail: `Could not read image attachment ${attachment.name}.`,
                });
              }
              return {
                name: attachment.name,
                mimeType: attachment.mimeType,
                base64: bytes.toString("base64"),
              };
            }),
          ),
        catch: toBridgeError,
      }).pipe(Effect.match({ onFailure: (error) => error, onSuccess: (images) => images }));
      if (imagesOrError instanceof ChatGPTDesktopBridgeError) {
        return yield* terminalState(thread, turnId, "error", imagesOrError.detail);
      }
      const images = imagesOrError;

      const snapshot = yield* snapshots.getSnapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
      const workspace = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      });
      if (!workspace) {
        return yield* terminalState(
          thread,
          turnId,
          "error",
          "No workspace path could be resolved for this thread.",
        );
      }

      const existing = Option.getOrUndefined(yield* bindings.get(thread.id));
      const envelopeAlreadySent =
        existing?.workspaceEnvelopeSentAt !== null && existing !== undefined;
      let initialSend = !envelopeAlreadySent;
      if (initialSend) {
        const reserved = yield* bindings.reserveInitialSend(thread.id, user.id, yield* now);
        if (!reserved) {
          const reservedMessageId = yield* bindings.getInitialSendMessageId(thread.id);
          if (Option.isSome(reservedMessageId) && reservedMessageId.value === user.id) {
            return yield* terminalState(
              thread,
              turnId,
              "error",
              "The initial ChatGPT Agent request was already dispatched and its delivery is uncertain. It was not resent.",
            );
          }
          // A later user turn may still open a conversation after a previous
          // initial dispatch was interrupted. It must never add that first
          // prompt/envelope again.
          initialSend = false;
        }
      }

      const text = initialSend ? `${envelope(workspace)}\n\n${user.text}` : user.text;
      const ensured = yield* desktopController
        .ensure(config.chatgptAgent.cdpEndpoint)
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
      if (ensured) return yield* terminalState(thread, turnId, "error", ensured.detail);
      const selection = event.payload.modelSelection ?? thread.modelSelection;
      const reasoningEffort = selection?.options?.find(
        (option) => option.id === "reasoningEffort",
      )?.value;
      let conversationId = existing?.conversationId;
      const streamed: true | ChatGPTDesktopBridgeError = yield* Stream.fromAsyncIterable(
        bridge.send({
          endpoint: config.chatgptAgent.cdpEndpoint,
          ...(conversationId ? { conversationId } : {}),
          text,
          model: normalizeChatGPTAgentModel(selection?.model),
          ...(reasoningEffort === "instant" ||
          reasoningEffort === "medium" ||
          reasoningEffort === "high"
            ? { reasoningEffort }
            : {}),
          ...(images.length > 0 ? { images } : {}),
          signal: task.controller.signal,
        }),
        toBridgeError,
      ).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            if (task.controller.signal.aborted) return;
            conversationId = chunk.conversationId;
            if (existing === undefined && conversationId) {
              const createdAt = yield* now;
              yield* bindings.upsert({
                threadId: thread.id,
                conversationId,
                workspaceEnvelopeSentAt: initialSend ? null : createdAt,
                createdAt,
                updatedAt: createdAt,
              });
            }
            if (chunk.text.length > 0 && !task.controller.signal.aborted) {
              yield* engine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: yield* commandId("delta"),
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                delta: chunk.text,
                createdAt: yield* now,
              });
            }
          }),
        ),
        Effect.as(true as const),
        Effect.catchTag("ChatGPTDesktopBridgeError", Effect.succeed),
      );

      if (
        task.controller.signal.aborted ||
        (streamed !== true && streamed.kind === "interrupted")
      ) {
        return yield* terminalState(thread, turnId, task.terminalState);
      }
      if (streamed !== true) {
        return yield* terminalState(thread, turnId, "error", streamed.detail);
      }
      if (initialSend && conversationId) {
        yield* bindings.markWorkspaceEnvelopeSent(thread.id, yield* now);
      }
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: yield* commandId("complete"),
        threadId: thread.id,
        messageId: assistantMessageId,
        turnId,
        createdAt: yield* now,
      });
      yield* terminalState(thread, turnId, "ready");
    });

    const startTurn = Effect.fn("ChatGPTAgentReactor.startTurn")(function* (event: TurnStartEvent) {
      if (claimedStartEvents.has(event.eventId)) return;
      claimedStartEvents.add(event.eventId);
      const thread = yield* snapshots.getThreadDetailById(event.payload.threadId);
      if (
        Option.isNone(thread) ||
        !isChatGPTAgentTurnStart({
          thread: thread.value,
          requestedModelSelection: event.payload.modelSelection,
        })
      ) {
        return;
      }
      const task = yield* coordinator.start(event.payload.threadId);
      yield* coordinator
        .withThreadLock(
          event.payload.threadId,
          process(event, task).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause) || task.controller.signal.aborted)
                return Effect.void;
              return Effect.logWarning("chatgpt agent turn failed before lifecycle settlement", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              });
            }),
            Effect.ensuring(coordinator.finish(event.payload.threadId, task)),
          ),
        )
        .pipe(Effect.forkScoped);
    });

    const interrupt = (
      event: InterruptEvent | SessionStopEvent,
      state: ChatGPTAgentTurnTerminalState,
    ) =>
      Effect.gen(function* () {
        const thread = yield* snapshots.getThreadDetailById(event.payload.threadId);
        if (Option.isNone(thread) || !isChatGPTAgentThread(thread.value)) return;
        yield* coordinator.interrupt(event.payload.threadId, state);
      });

    const start = Effect.fn("ChatGPTAgentReactor.start")(function* () {
      yield* Stream.runForEach(engine.streamDomainEvents, (event) => {
        switch (event.type) {
          case "thread.turn-start-requested":
            return startTurn(event);
          case "thread.turn-interrupt-requested":
            return interrupt(event, "interrupted");
          case "thread.session-stop-requested":
            return interrupt(event, "stopped");
          default:
            return Effect.void;
        }
      }).pipe(Effect.forkScoped);
    });
    return { start };
  }),
);
