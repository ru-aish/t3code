import type { ChatGPTActionError } from "./actions.ts";
import {
  ChatGPTSettings,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  type ThreadId,
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type { ProviderAdapterDriverCreateInput } from "@t3tools/provider-core/server/adapterDriver";
import type * as ChatGPTMcpBridge from "./mcpBridge.ts";
import { mergeFinalAnswer } from "./protocol.ts";
import {
  ChatGPTConnection,
  type ChatGPTUpdate,
  type ChatGPTImage,
  type TerminalBinding,
  type TerminalEvent,
} from "./connection.ts";

export const CHATGPT_DRIVER = ProviderDriverKind.make("chatgpt");

const capabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "weak",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

type ActiveTurn = {
  input: ProviderAdapter.ProviderAdapterV2TurnInput;
  turn: OrchestrationV2ProviderTurn;
  generation: number;
  requestId: string;
};

type Update = { kind: "chat"; update: ChatGPTUpdate } | { kind: "terminal"; event: TerminalEvent };

export const makeChatGPTAdapter = (
  options: ProviderAdapterDriverCreateInput<ChatGPTSettings>,
  transport: {
    readonly token: string;
    readonly environmentId: string;
    readonly cacheDir: string;
    readonly attachMcp: Effect.Success<typeof ChatGPTMcpBridge.make>;
    readonly resolveAttachmentPath?: (attachment: ChatAttachment) => string | null;
    readonly linkPullRequest?: (
      threadId: ThreadId,
      url: string,
      eventId: string,
    ) => Effect.Effect<void, ChatGPTActionError>;
  },
) =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CHATGPT_DRIVER,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cwd = input.runtimePolicy.cwd;
        if (!cwd)
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: CHATGPT_DRIVER,
            providerSessionId: input.providerSessionId,
          });
        const orchestration = yield* transport.attachMcp(input.threadId, transport.cacheDir);
        const connection = new ChatGPTConnection({
          cdpEndpoint: options.config.cdpEndpoint,
          controlEndpoint: options.config.terminalEndpoint,
          token: transport.token,
          environmentId: transport.environmentId,
          providerId: options.instanceId,
          threadId: input.threadId,
          cacheDir: transport.cacheDir,
          orchestrationCommand: orchestration?.command,
        });
        const incoming = yield* Queue.unbounded<Update>();
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const abort = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            abort.abort();
            connection.close();
          }),
        );
        const attempt = <A>(operation: () => Promise<A>) =>
          Effect.tryPromise({
            try: operation,
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CHATGPT_DRIVER,
                detail: "ChatGPT connection operation failed",
                cause,
              }),
          });
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event);
        const session = {
          id: input.providerSessionId,
          driver: CHATGPT_DRIVER,
          providerInstanceId: options.instanceId,
          status: "ready" as const,
          cwd,
          model: input.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        yield* attempt(() => connection.load());
        let binding = yield* attempt(() =>
          connection.control<TerminalBinding>("register", {
            cwd,
            model: input.modelSelection.model,
          }),
        );
        if (
          binding.conversation_id &&
          connection.conversationId &&
          binding.conversation_id !== connection.conversationId
        ) {
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: CHATGPT_DRIVER,
            providerSessionId: input.providerSessionId,
          });
        }
        if (binding.conversation_id)
          yield* attempt(() => connection.adoptConversation(binding.conversation_id!));
        let thread: OrchestrationV2ProviderThread | null = null;
        let active: ActiveTurn | null = null;
        const outputTurns = new Map<string, ActiveTurn>();
        const messages = new Map<string, OrchestrationV2ConversationMessage>();
        const finalFragments = new Map<string, Map<string, string>>();
        const reasoningKeys = new Set<string>();
        let streamComplete = false;
        let completionRecoveryRequestId: string | null = null;
        let usedTerminalTools = false;
        let generation = 0;
        let nextOrdinal = 0;
        const itemOrdinals = new Map<string, number>();
        const nativeMessageIds = new Map<string, string>();
        connection.onUpdate((update) => {
          Queue.offerUnsafe(incoming, { kind: "chat", update });
        });
        const ref = (id: string) => ({
          driver: CHATGPT_DRIVER,
          nativeId: id,
          strength: "strong" as const,
        });
        const settleReasoning = Effect.fnUntraced(function* (turn: ActiveTurn) {
          const timestamp = yield* DateTime.now;
          for (const key of reasoningKeys) {
            if (!key.startsWith(`${turn.generation}:`)) continue;
            const item = messages.get(key);
            if (!item?.streaming) continue;
            messages.set(key, { ...item, streaming: false, updatedAt: timestamp });
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_DRIVER,
              turnItem: {
                id: TurnItemId.make(`chatgpt:${input.threadId}:${key}`),
                threadId: input.threadId,
                runId: turn.input.runId,
                nodeId: turn.input.rootNodeId,
                providerThreadId: turn.turn.providerThreadId,
                providerTurnId: turn.turn.id,
                nativeItemRef: ref(nativeMessageIds.get(key) ?? key),
                parentItemId: null,
                ordinal: itemOrdinals.get(key)!,
                status: "completed",
                title: null,
                startedAt: item.createdAt,
                completedAt: timestamp,
                updatedAt: timestamp,
                type: "reasoning",
                text: item.text,
                streaming: false,
              },
            });
          }
        });
        const finish = Effect.fnUntraced(function* (
          status: "completed" | "interrupted" | "cancelled",
        ) {
          if (!active || !thread) return;
          const completed = active;
          active = null;
          yield* settleReasoning(completed);
          const timestamp = yield* DateTime.now;
          const finalKey = String(completed.generation) + ":final";
          const finalMessage = messages.get(finalKey);
          if (finalMessage?.streaming) {
            const message = { ...finalMessage, streaming: false, updatedAt: timestamp };
            messages.set(finalKey, message);
            yield* emit({ type: "message.updated", driver: CHATGPT_DRIVER, message });
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_DRIVER,
              turnItem: {
                id: TurnItemId.make("chatgpt:" + input.threadId + ":" + finalKey),
                threadId: input.threadId,
                runId: completed.input.runId,
                nodeId: completed.input.rootNodeId,
                providerThreadId: thread.id,
                providerTurnId: completed.turn.id,
                nativeItemRef: ref(nativeMessageIds.get(finalKey) ?? "final"),
                parentItemId: null,
                ordinal: itemOrdinals.get(finalKey)!,
                status: "completed",
                title: null,
                startedAt: message.createdAt,
                completedAt: timestamp,
                updatedAt: timestamp,
                type: "assistant_message",
                messageId: message.id,
                text: message.text,
                streaming: false,
              },
            });
          }
          yield* emit({
            type: "provider_turn.updated",
            driver: CHATGPT_DRIVER,
            threadId: input.threadId,
            providerTurn: { ...completed.turn, status, completedAt: timestamp },
          });
          yield* emit({
            type: "turn.terminal",
            driver: CHATGPT_DRIVER,
            providerThreadId: thread.id,
            providerTurnId: completed.turn.id,
            runOrdinal: completed.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        });
        const recoverMissingCompletion = Effect.fnUntraced(function* (requestId: string) {
          if (completionRecoveryRequestId === requestId) return;
          completionRecoveryRequestId = requestId;
          for (let probe = 0; probe < 20; probe++) {
            if (
              !active ||
              active.requestId !== requestId ||
              streamComplete ||
              binding.state !== "done"
            )
              break;
            const idle = yield* attempt(() => connection.isConversationIdle()).pipe(
              Effect.catch(() => Effect.succeed(false)),
            );
            if (idle) {
              streamComplete = true;
              yield* finish("completed");
              break;
            }
            yield* Effect.sleep("250 millis");
          }
          if (completionRecoveryRequestId === requestId) completionRecoveryRequestId = null;
        });
        const acceptUpdate = Effect.fnUntraced(function* (update: ChatGPTUpdate) {
          if (
            update.role === "assistant" &&
            (update.recipient?.includes("fedora_t3code") ||
              (update.recipient === "api_tool.call_tool" && update.text?.includes("fedora_t3code")))
          )
            usedTerminalTools = true;
          if (update.conversationId && update.conversationId !== binding.conversation_id) {
            binding = yield* attempt(() =>
              connection.control<TerminalBinding>("bind", {
                conversationId: update.conversationId,
              }),
            );
            if (thread) {
              thread = {
                ...thread,
                nativeThreadRef: ref(update.conversationId),
                updatedAt: yield* DateTime.now,
              };
              yield* emit({
                type: "provider_thread.updated",
                driver: CHATGPT_DRIVER,
                providerThread: thread,
              });
            }
          }
          if (update.kind === "complete") {
            if (active && update.requestId === active.requestId) {
              yield* settleReasoning(active);
              streamComplete = true;
              if (!usedTerminalTools && binding.state !== "done") {
                // Stop Terminal MCP inactivity recovery for reply-only runs.
                // The next turn reactivates the binding; no completion tool is needed.
                yield* attempt(() =>
                  connection.control("pause", { requestId: `reply-only-${update.requestId}` }),
                ).pipe(Effect.ignore);
              }
              if (binding.state === "done" || !usedTerminalTools) yield* finish("completed");
            }
            // Tool-using turns require Terminal MCP confirmation; reply-only turns
            // finish on the normal ChatGPT stream completion.
            return;
          }
          const isFinalAnswer =
            update.role === "assistant" &&
            (!update.channel || update.channel === "final") &&
            (!update.recipient || update.recipient === "all") &&
            update.hidden !== true;
          const isReasoning =
            update.role === "assistant" &&
            (update.channel === "analysis" || update.channel === "commentary") &&
            (!update.recipient || update.recipient === "all");
          if (update.kind === "error" || update.hidden) return;
          const outputTurn = update.requestId ? outputTurns.get(update.requestId) : undefined;
          if (
            !outputTurn ||
            !thread ||
            !update.messageId ||
            update.role !== "assistant" ||
            !update.text
          )
            return;
          const timestamp = yield* DateTime.now;
          // GenUI can replace an in-progress final message's native ID with a
          // canonical full-answer ID. Keep one final answer per submission.
          const key = `${outputTurn.generation}:${(!update.channel || update.channel === "final") && (!update.recipient || update.recipient === "all") ? "final" : update.messageId}`;
          if (isFinalAnswer) yield* settleReasoning(outputTurn);
          const id = MessageId.make(`chatgpt:${input.threadId}:${key}`);
          const existing = messages.get(key);
          let text = update.text;
          if (isFinalAnswer) {
            const fragments = finalFragments.get(key) ?? new Map<string, string>();
            fragments.set(update.messageId, update.text);
            finalFragments.set(key, fragments);
            text = [...fragments.values()].reduce<string>(
              (merged, fragment) => mergeFinalAnswer(merged, fragment),
              "",
            );
          }
          const streaming = update.status !== "finished_successfully";
          if (existing?.text === text && existing.streaming === streaming) return;
          const message: OrchestrationV2ConversationMessage = {
            id,
            threadId: input.threadId,
            runId: outputTurn.input.runId,
            nodeId: outputTurn.input.rootNodeId,
            role: "assistant",
            text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          messages.set(key, message);
          nativeMessageIds.set(key, update.messageId);
          const ordinal = itemOrdinals.get(key) ?? ++nextOrdinal;
          itemOrdinals.set(key, ordinal);

          const base = {
            id: TurnItemId.make(`chatgpt:${input.threadId}:${key}`),
            threadId: input.threadId,
            runId: outputTurn.input.runId,
            nodeId: outputTurn.input.rootNodeId,
            providerThreadId: thread.id,
            providerTurnId: outputTurn.turn.id,
            nativeItemRef: ref(update.messageId),
            parentItemId: null,
            ordinal,
            status: streaming ? ("running" as const) : ("completed" as const),
            title: null,
            startedAt: message.createdAt,
            completedAt: streaming ? null : timestamp,
            updatedAt: timestamp,
          };
          if (isReasoning) {
            reasoningKeys.add(key);
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_DRIVER,
              turnItem: { ...base, type: "reasoning", text: update.text, streaming },
            });
          } else if (!update.recipient || update.recipient === "all") {
            yield* emit({ type: "message.updated", driver: CHATGPT_DRIVER, message });
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_DRIVER,
              turnItem: {
                ...base,
                type: "assistant_message",
                messageId: id,
                text,
                streaming,
              },
            });
          }
        });
        const controlEvents = Effect.tryPromise({
          try: async () => {
            for await (const event of connection.terminalEvents(abort.signal))
              Queue.offerUnsafe(incoming, { kind: "terminal", event });
          },
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CHATGPT_DRIVER,
              detail: "Terminal MCP event connection failed",
              cause,
            }),
        }).pipe(
          Effect.catch(() => Effect.sleep("2 seconds")),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* controlEvents;
        yield* Stream.fromQueue(incoming).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.kind === "chat") {
                yield* acceptUpdate(event.update);
                return;
              }
              const control = event.event;
              if (control.epoch !== binding.epoch) {
                yield* attempt(() => connection.acknowledge(control));
                return;
              }
              if (control.kind === "link_pr" && control.payload.url && transport.linkPullRequest) {
                yield* transport.linkPullRequest(
                  input.threadId,
                  control.payload.url,
                  control.event_id,
                );
              } else if (control.kind === "state" && control.payload.state === "done") {
                binding = { ...binding, state: "done" };
                if (streamComplete) yield* finish("completed");
                else if (active)
                  yield* recoverMissingCompletion(active.requestId).pipe(Effect.forkScoped);
              } else if (control.kind === "continue" && active) {
                const claim = yield* attempt(() =>
                  connection.control<{ valid: boolean }>("claim", { eventId: control.event_id }),
                );
                if (claim.valid) {
                  if (!streamComplete) yield* attempt(() => connection.stop());
                  generation++;
                  active = { ...active, generation, requestId: control.event_id };
                  outputTurns.set(control.event_id, active);
                  streamComplete = false;
                  yield* attempt(() =>
                    connection.send(
                      control.event_id,
                      control.payload.prompt ?? "continue",
                      active!.input.modelSelection.model,
                      cwd,
                      active!.input.modelSelection.options?.find(
                        (option) => option.id === "reasoningEffort",
                      )?.value as string | undefined,
                    ),
                  );
                }
              }
              yield* attempt(() => connection.acknowledge(control));
            }).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  if (event.kind === "terminal")
                    yield* attempt(() => connection.acknowledge(event.event)).pipe(Effect.ignore);
                  yield* Effect.logWarning(
                    "ChatGPT control event failed; Terminal MCP retains task authority.",
                  );
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        const unsupported = () =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CHATGPT_DRIVER,
              detail: "This operation is unavailable for ChatGPT conversations",
            }),
          );
        const ensureThread = Effect.fnUntraced(function* (
          request: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        ) {
          if (thread) return thread;
          const timestamp = yield* DateTime.now;
          thread = request.existingProviderThread
            ? {
                ...request.existingProviderThread,
                providerSessionId: input.providerSessionId,
                updatedAt: timestamp,
              }
            : {
                id: ProviderThreadId.make(`chatgpt:${input.threadId}`),
                driver: CHATGPT_DRIVER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: input.threadId,
                ownerNodeId: null,
                nativeThreadRef: binding.conversation_id ? ref(binding.conversation_id) : null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: null,
                goal: null,
                createdAt: timestamp,
                updatedAt: timestamp,
              };
          return thread;
        });
        const startTurn = Effect.fnUntraced(function* (
          request: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          if (active)
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: CHATGPT_DRIVER,
              threadId: input.threadId,
              providerThreadId: request.providerThread.id,
              runId: request.runId,
            });
          const images: ChatGPTImage[] = [];
          for (const attachment of request.message.attachments) {
            const path = transport.resolveAttachmentPath?.(attachment);
            if (attachment.type !== "image" || !path)
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CHATGPT_DRIVER,
                detail: "ChatGPT requires an available image attachment",
              });
            images.push({
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              path,
            });
          }
          yield* (orchestration?.refresh ?? Effect.void).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CHATGPT_DRIVER,
                  detail: "Failed to refresh the ChatGPT orchestration bridge credential",
                  cause,
                }),
            ),
          );
          thread = request.providerThread;
          binding = yield* attempt(() =>
            connection.control<TerminalBinding>("activate", {
              requestId: request.message.messageId,
            }),
          );
          const timestamp = yield* DateTime.now;
          const turn: OrchestrationV2ProviderTurn = {
            id: ProviderTurnId.make(`chatgpt:${request.attemptId}`),
            providerThreadId: thread.id,
            nodeId: request.rootNodeId,
            runAttemptId: request.attemptId,
            nativeTurnRef: { ...ref(request.attemptId), strength: "weak" },
            ordinal: request.providerTurnOrdinal,
            status: "running",
            startedAt: timestamp,
            completedAt: null,
          };
          active = {
            input: request,
            turn,
            generation: ++generation,
            requestId: request.message.messageId,
          };
          outputTurns.set(request.message.messageId, active);
          streamComplete = false;
          usedTerminalTools = false;
          yield* emit({
            type: "provider_turn.updated",
            driver: CHATGPT_DRIVER,
            threadId: input.threadId,
            providerTurn: turn,
          });
          yield* attempt(() =>
            connection.send(
              request.message.messageId,
              request.message.text,
              request.modelSelection.model,
              cwd,
              request.modelSelection.options?.find((option) => option.id === "reasoningEffort")
                ?.value as string | undefined,
              images,
              request.modelSelection.options?.find((option) => option.id === "chatgptProjectId")
                ?.value === "general"
                ? null
                : (request.modelSelection.options?.find(
                    (option) => option.id === "chatgptProjectId",
                  )?.value as string | undefined),
            ),
          ).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* attempt(() =>
                  connection.control("pause", { requestId: `failed-${request.message.messageId}` }),
                ).pipe(Effect.ignore);
                active = null;
              }),
            ),
          );
        });
        return {
          instanceId: options.instanceId,
          driver: CHATGPT_DRIVER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: Stream.fromQueue(events),
          ensureThread,
          resumeThread: ({ providerThread }) =>
            Effect.sync(() => {
              thread = providerThread;
              return providerThread;
            }),
          startTurn,
          steerTurn: () =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver: CHATGPT_DRIVER,
                providerThreadId: thread?.id ?? ProviderThreadId.make(`chatgpt:${input.threadId}`),
              }),
            ),
          interruptTurn: () =>
            Effect.gen(function* () {
              const timestamp = yield* DateTime.now;
              yield* attempt(() =>
                connection.control("pause", {
                  requestId: `stop-${input.threadId}-${DateTime.toEpochMillis(timestamp)}`,
                }),
              );
              if (!streamComplete) yield* attempt(() => connection.stop());
              yield* finish("interrupted");
            }),
          respondToRuntimeRequest: unsupported,
          readThreadSnapshot: ({ providerThread }) =>
            Effect.succeed({
              providerThread,
              providerTurns: [],
              messages: [...messages.values()],
              runtimeRequests: [],
            }),
          rollbackThread: unsupported,
          forkThread: unsupported,
          injectHistory: () => Effect.succeed(false),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: CHATGPT_DRIVER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
