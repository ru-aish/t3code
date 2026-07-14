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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

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
import {
  ChatGPTDesktopBridge,
  ChatGPTDesktopBridgeError,
  reconcileAssistantText,
  type ChatGPTDesktopActivity,
} from "./ChatGPTDesktopBridge.ts";
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
>()("t3/chatgptAgent/ChatGPTAgentReactor") {}

const now = Effect.map(DateTime.now, DateTime.formatIso);
const envelope = (workspace: string) =>
  `Workspace: ${workspace}. This folder is the working space.`;

type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type InterruptEvent = Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>;
type SessionStopEvent = Extract<OrchestrationEvent, { type: "thread.session-stop-requested" }>;

const isChatGPTDesktopBridgeError = Schema.is(ChatGPTDesktopBridgeError);
const toBridgeError = (cause: unknown) =>
  isChatGPTDesktopBridgeError(cause)
    ? cause
    : new ChatGPTDesktopBridgeError({
        kind: "unavailable",
        detail: "Could not communicate with ChatGPT Desktop.",
      });

type ChatGPTAgentStreamOutcome = "succeeded" | "interrupted" | "failed";

type ChatGPTLateRecovery = {
  readonly conversationId: string;
  readonly turnId: TurnId;
  readonly assistantMessageId: MessageId;
  assistantText: string;
  latestReasoning: string;
  reasoningActivityStarted: boolean;
};

export function chatGPTActivityMatchesUser(activityUserText: string, t3UserText: string): boolean {
  const activity = activityUserText.trim();
  const user = t3UserText.trim();
  return activity === user || activity.endsWith(`\n\n${user}`);
}

/** A projected partial response must never remain permanently streaming. */
export function shouldFinalizeChatGPTAssistantMessage(input: {
  readonly assistantMessageStarted: boolean;
  readonly outcome: ChatGPTAgentStreamOutcome;
}): boolean {
  return input.outcome === "succeeded" || input.assistantMessageStarted;
}

export function shouldUpdateChatGPTConversationBinding(
  existingConversationId: string | undefined,
  nextConversationId: string | undefined,
): boolean {
  return Boolean(nextConversationId && nextConversationId !== existingConversationId);
}

export function chatGPTBindingWorkspaceEnvelopeSentAt(input: {
  readonly initialSend: boolean;
  readonly conversationReplaced: boolean;
  readonly existingWorkspaceEnvelopeSentAt: string | null | undefined;
  readonly updatedAt: string;
}): string | null {
  if (input.initialSend || input.conversationReplaced) return null;
  return input.existingWorkspaceEnvelopeSentAt ?? input.updatedAt;
}

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
    const fs = yield* FileSystem.FileSystem;
    const coordinator = yield* makeChatGPTAgentTurnCoordinator;
    const claimedStartEvents = new Set<string>();
    const lateRecoveries = new Map<string, ChatGPTLateRecovery>();
    const ignoredConversationsUntilIdle = new Set<string>();

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

    const reasoningActivity = (
      threadId: ThreadId,
      turnId: TurnId,
      phase: "updated" | "completed",
      detail: string,
      status: "inProgress" | "completed" | "failed" | "stopped",
    ) =>
      Effect.gen(function* () {
        const createdAt = yield* now;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId(`reasoning-${phase}`),
          threadId,
          createdAt,
          activity: {
            id: yield* eventId,
            kind: phase === "updated" ? "tool.updated" : "tool.completed",
            tone: "tool",
            summary: phase === "updated" ? "ChatGPT Agent thinking" : "ChatGPT Agent thought",
            payload: {
              itemType: "dynamic_tool_call",
              title: "ChatGPT Agent thinking",
              status,
              detail: detail.slice(-12_000),
              data: { toolCallId: `chatgpt-agent-reasoning:${turnId}` },
            },
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

    const finishLateRecoveryLocked = (
      thread: { readonly id: ThreadId; readonly runtimeMode: OrchestrationSession["runtimeMode"] },
      recovery: ChatGPTLateRecovery,
      state: "ready" | ChatGPTAgentTurnTerminalState,
    ) =>
      Effect.gen(function* () {
        if (recovery.reasoningActivityStarted) {
          yield* reasoningActivity(
            thread.id,
            recovery.turnId,
            "completed",
            recovery.latestReasoning,
            state === "ready" ? "completed" : "stopped",
          );
        }
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* commandId("late-complete"),
          threadId: thread.id,
          messageId: recovery.assistantMessageId,
          turnId: recovery.turnId,
          createdAt: yield* now,
        });
        lateRecoveries.delete(thread.id);
        if (state !== "ready") ignoredConversationsUntilIdle.add(recovery.conversationId);
        yield* terminalState(thread, recovery.turnId, state);
      });

    const settleLateRecovery = (
      threadId: ThreadId,
      state: "ready" | ChatGPTAgentTurnTerminalState,
    ) =>
      coordinator.withThreadLock(
        threadId,
        Effect.gen(function* () {
          const recovery = lateRecoveries.get(threadId);
          if (!recovery) return false;
          const thread = yield* snapshots.getThreadDetailById(threadId);
          if (Option.isNone(thread)) {
            lateRecoveries.delete(threadId);
            return false;
          }
          yield* finishLateRecoveryLocked(thread.value, recovery, state);
          return true;
        }),
      );

    const applyLateDesktopActivity = Effect.fn("ChatGPTAgentReactor.applyLateDesktopActivity")(
      function* (desktopActivity: ChatGPTDesktopActivity) {
        if (ignoredConversationsUntilIdle.has(desktopActivity.conversationId)) {
          if (!desktopActivity.active)
            ignoredConversationsUntilIdle.delete(desktopActivity.conversationId);
          return;
        }
        const binding = yield* bindings.findByConversationId(desktopActivity.conversationId);
        if (Option.isNone(binding)) return;
        const threadId = binding.value.threadId;
        const initialThread = yield* snapshots.getThreadDetailById(threadId);
        if (Option.isNone(initialThread) || !isChatGPTAgentThread(initialThread.value)) return;
        const initialRecovery = lateRecoveries.get(threadId);
        if (
          initialThread.value.session?.status === "running" &&
          (!initialRecovery || initialThread.value.session.activeTurnId !== initialRecovery.turnId)
        )
          return;

        yield* coordinator.withThreadLock(
          threadId,
          Effect.gen(function* () {
            const threadOption = yield* snapshots.getThreadDetailById(threadId);
            if (Option.isNone(threadOption) || !isChatGPTAgentThread(threadOption.value)) return;
            const thread = threadOption.value;
            const existingRecovery = lateRecoveries.get(threadId);
            if (
              thread.session?.status === "running" &&
              (!existingRecovery || thread.session.activeTurnId !== existingRecovery.turnId)
            )
              return;

            if (!desktopActivity.active) {
              if (existingRecovery)
                yield* finishLateRecoveryLocked(thread, existingRecovery, "ready");
              return;
            }

            const latestUser = thread.messages
              .toReversed()
              .find((message) => message.role === "user");
            if (
              !existingRecovery &&
              (!latestUser ||
                !chatGPTActivityMatchesUser(desktopActivity.userText, latestUser.text))
            )
              return;

            let recovery = existingRecovery;
            let started = false;
            if (!recovery) {
              const latestTurn = thread.latestTurn;
              if (!latestTurn) return;
              const existingAssistant = thread.messages
                .toReversed()
                .find(
                  (message) => message.role === "assistant" && message.turnId === latestTurn.turnId,
                );
              recovery = {
                conversationId: desktopActivity.conversationId,
                turnId: latestTurn.turnId,
                assistantMessageId:
                  existingAssistant?.id ?? MessageId.make(yield* crypto.randomUUIDv4),
                assistantText: existingAssistant?.text ?? "",
                latestReasoning: "",
                reasoningActivityStarted: false,
              };
              lateRecoveries.set(threadId, recovery);
              started = true;
              yield* setSession(thread, "running", recovery.turnId);
              yield* activity(
                thread.id,
                recovery.turnId,
                "info",
                "ChatGPT Agent resumed",
                "ChatGPT Desktop resumed producing output for the previously completed turn.",
              );
            }

            const update = reconcileAssistantText(
              recovery.assistantText,
              desktopActivity.assistantText,
            );
            if (started || update.kind !== "none") {
              yield* engine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: yield* commandId("late-delta"),
                threadId: thread.id,
                messageId: recovery.assistantMessageId,
                turnId: recovery.turnId,
                delta: update.kind === "none" ? "" : update.text,
                ...(update.kind === "replace" ? { replace: true } : {}),
                createdAt: yield* now,
              });
              recovery.assistantText = desktopActivity.assistantText;
            }

            if (
              desktopActivity.reasoningText &&
              desktopActivity.reasoningText !== recovery.latestReasoning
            ) {
              recovery.latestReasoning = desktopActivity.reasoningText;
              recovery.reasoningActivityStarted = true;
              yield* reasoningActivity(
                thread.id,
                recovery.turnId,
                "updated",
                recovery.latestReasoning,
                "inProgress",
              );
            }
          }),
        );
      },
    );

    const watchDesktopActivity = (signal: AbortSignal) =>
      Effect.forever(
        Effect.gen(function* () {
          const config = yield* settings.getSettings;
          if (!config.chatgptAgent.enabled) {
            yield* Effect.sleep("1 second");
            return;
          }
          yield* Stream.fromAsyncIterable(
            bridge.watchCurrent({
              endpoint: config.chatgptAgent.cdpEndpoint,
              signal,
            }),
            toBridgeError,
          ).pipe(Stream.runForEach(applyLateDesktopActivity));
        }).pipe(
          Effect.catchCause((cause) =>
            signal.aborted
              ? Effect.void
              : Effect.logWarning("chatgpt agent desktop activity watcher restarting", {
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.delay("1 second"),
        ),
      );

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
      const imagesOrError = yield* Effect.all(
        (user.attachments ?? []).map((attachment) =>
          Effect.gen(function* () {
            if (attachment.type !== "image" || !attachment.mimeType.startsWith("image/")) {
              return yield* new ChatGPTDesktopBridgeError({
                kind: "incompatible",
                detail: `ChatGPT Agent only supports image attachments (${attachment.name} is unsupported).`,
              });
            }
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) {
              return yield* new ChatGPTDesktopBridgeError({
                kind: "incompatible",
                detail: `Could not resolve image attachment ${attachment.name}.`,
              });
            }
            const bytes = yield* fs.readFile(path).pipe(
              Effect.mapError(
                () =>
                  new ChatGPTDesktopBridgeError({
                    kind: "incompatible",
                    detail: `Could not read image attachment ${attachment.name}.`,
                  }),
              ),
            );
            return {
              name: attachment.name,
              mimeType: attachment.mimeType,
              base64: Buffer.from(bytes).toString("base64"),
            };
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(toBridgeError),
        Effect.match({ onFailure: (error) => error, onSuccess: (images) => images }),
      );
      if (isChatGPTDesktopBridgeError(imagesOrError)) {
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

      const replacementText = `${envelope(workspace)}\n\n${user.text}`;
      const text = initialSend ? replacementText : user.text;
      const ensured = yield* desktopController
        .ensure(config.chatgptAgent.cdpEndpoint)
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
      if (ensured) return yield* terminalState(thread, turnId, "error", ensured.detail);
      const selection = event.payload.modelSelection ?? thread.modelSelection;
      const reasoningEffort = selection?.options?.find(
        (option) => option.id === "reasoningEffort",
      )?.value;
      let conversationId = existing?.conversationId;
      let boundConversationId = existing?.conversationId;
      let conversationReplaced = false;
      let recoveryActivityPublished = false;
      let latestReasoning = "";
      let reasoningActivityStarted = false;
      let assistantMessageStarted = false;
      const streamed: true | ChatGPTDesktopBridgeError = yield* Stream.fromAsyncIterable(
        bridge.send({
          endpoint: config.chatgptAgent.cdpEndpoint,
          ...(conversationId ? { conversationId } : {}),
          text,
          replacementText,
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
            if (chunk.conversationReplaced) conversationReplaced = true;
            if (shouldUpdateChatGPTConversationBinding(boundConversationId, conversationId)) {
              const updatedAt = yield* now;
              yield* bindings.upsert({
                threadId: thread.id,
                conversationId,
                workspaceEnvelopeSentAt: chatGPTBindingWorkspaceEnvelopeSentAt({
                  initialSend,
                  conversationReplaced: chunk.conversationReplaced === true,
                  existingWorkspaceEnvelopeSentAt: existing?.workspaceEnvelopeSentAt,
                  updatedAt,
                }),
                createdAt: existing?.createdAt ?? updatedAt,
                updatedAt,
              });
              boundConversationId = conversationId;
            }
            if (chunk.conversationReplaced && !recoveryActivityPublished) {
              recoveryActivityPublished = true;
              yield* activity(
                thread.id,
                turnId,
                "info",
                "ChatGPT conversation recovered",
                "The saved ChatGPT conversation had been deleted. T3 started a replacement conversation and updated the thread binding.",
              );
            }
            if (chunk.text.length === 0 || task.controller.signal.aborted) return;
            if (chunk.kind === "thinking") {
              if (chunk.text === latestReasoning) return;
              latestReasoning = chunk.text;
              reasoningActivityStarted = true;
              yield* reasoningActivity(thread.id, turnId, "updated", latestReasoning, "inProgress");
              return;
            }
            yield* engine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* commandId("delta"),
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId,
              delta: chunk.text,
              ...(chunk.replace ? { replace: true } : {}),
              createdAt: yield* now,
            });
            assistantMessageStarted = true;
          }),
        ),
        Effect.as(true as const),
        Effect.catchTag("ChatGPTDesktopBridgeError", Effect.succeed),
      );

      if (reasoningActivityStarted) {
        yield* reasoningActivity(
          thread.id,
          turnId,
          "completed",
          latestReasoning,
          task.controller.signal.aborted || (streamed !== true && streamed.kind === "interrupted")
            ? "stopped"
            : streamed === true
              ? "completed"
              : "failed",
        );
      }

      const streamOutcome: ChatGPTAgentStreamOutcome =
        task.controller.signal.aborted || (streamed !== true && streamed.kind === "interrupted")
          ? "interrupted"
          : streamed === true
            ? "succeeded"
            : "failed";
      if (
        shouldFinalizeChatGPTAssistantMessage({
          assistantMessageStarted,
          outcome: streamOutcome,
        })
      ) {
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* commandId("complete"),
          threadId: thread.id,
          messageId: assistantMessageId,
          turnId,
          createdAt: yield* now,
        });
      }
      if (streamOutcome === "interrupted") {
        return yield* terminalState(thread, turnId, task.terminalState);
      }
      if (streamOutcome === "failed" && streamed !== true) {
        return yield* terminalState(thread, turnId, "error", streamed.detail);
      }
      if ((initialSend || conversationReplaced) && conversationId) {
        yield* bindings.markWorkspaceEnvelopeSent(thread.id, yield* now);
      }
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
      yield* settleLateRecovery(event.payload.threadId, "interrupted");
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
        const interruptedTurn = yield* coordinator.interrupt(event.payload.threadId, state);
        if (interruptedTurn === undefined) yield* settleLateRecovery(event.payload.threadId, state);
      });

    const start = Effect.fn("ChatGPTAgentReactor.start")(function* () {
      const watcherController = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => watcherController.abort()));
      yield* watchDesktopActivity(watcherController.signal).pipe(Effect.forkScoped);
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
