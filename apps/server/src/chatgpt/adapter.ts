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
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type { ProviderAdapterDriverCreateInput } from "@t3tools/provider-core/server/adapterDriver";
import type * as ChatGPTMcpBridge from "./mcpBridge.ts";
import { mergeFinalAnswer } from "./protocol.ts";
import {
  ChatGPTConnection,
  ChatGPTSubmissionNotStartedError,
  type ChatGPTUpdate,
  type ChatGPTImage,
  type ConversationSnapshot,
  type TerminalBinding,
  type TerminalEvent,
} from "./connection.ts";

export class ChatGPTTurnNotSubmittedError extends Error {
  readonly _tag = "ChatGPTTurnNotSubmittedError";
  constructor(cause: unknown) {
    super("ChatGPT turn was not submitted", { cause });
  }
}

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
  input: Pick<
    ProviderAdapter.ProviderAdapterV2TurnInput,
    "runId" | "rootNodeId" | "runOrdinal" | "modelSelection"
  >;
  turn: OrchestrationV2ProviderTurn;
  generation: number;
  requestId: string;
};

type Update =
  | { kind: "chat"; update: ChatGPTUpdate }
  | { kind: "terminal"; event: TerminalEvent }
  | { kind: "recover"; token: number; retry: number }
  | {
      kind: "recover_snapshot";
      token: number;
      result: Deferred.Deferred<boolean, ProviderAdapter.ProviderAdapterProtocolError>;
    }
  | {
      kind: "refresh";
      input: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput;
      result: Deferred.Deferred<
        ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
        ProviderAdapter.ProviderAdapterProtocolError
      >;
    };

export const makeChatGPTAdapter = (
  options: ProviderAdapterDriverCreateInput<ChatGPTSettings>,
  transport: {
    readonly token: string;
    readonly environmentId: string;
    readonly cacheDir: string;
    readonly attachMcp: Effect.Success<typeof ChatGPTMcpBridge.make>;
    readonly recovery?: {
      readonly permit: Semaphore.Semaphore;
      unavailableUntil: number;
    };
    readonly refreshThread?: (threadId: ThreadId) => Effect.Effect<void, ChatGPTActionError>;
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
        const sessionScope = yield* Effect.scope;
        const recoveryGate = transport.recovery ?? {
          permit: yield* Semaphore.make(1),
          unavailableUntil: 0,
        };
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
        const snapshotItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => {
          if (event.type === "turn_item.updated")
            snapshotItems.set(event.turnItem.id, event.turnItem);
          return Queue.offer(events, event);
        };
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
        let recoveredFinalRecoveryRequestId: string | null = null;
        let transportInterrupted = false;
        let recoveryToken = 0;
        let recoveryScheduled = false;
        const cancelRecovery = () => {
          ++recoveryToken;
          recoveryScheduled = false;
        };
        const requestRecovery = Effect.fnUntraced(function* () {
          transportInterrupted = true;
          if (recoveryScheduled || !thread || (active && retiredRequestIds.has(active.requestId)))
            return;
          recoveryScheduled = true;
          yield* Queue.offer(incoming, { kind: "recover", token: ++recoveryToken, retry: 0 });
        });
        const retiredRequestIds = new Set<string>();
        let usedTerminalTools = false;
        let generation = 0;
        let nextOrdinal = 0;
        const itemOrdinals = new Map<string, number>();
        const itemIds = new Map<string, TurnItemId>();
        const restoredItems = new Map<string, OrchestrationV2TurnItem>();
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
            if (!key.startsWith(`${turn.turn.id}:${turn.requestId}:`)) continue;
            const item = messages.get(key);
            if (!item?.streaming) continue;
            messages.set(key, { ...item, streaming: false, updatedAt: timestamp });
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_DRIVER,
              turnItem: {
                id: itemIds.get(key)!,
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
          status: "completed" | "interrupted" | "cancelled" | "forced",
        ) {
          if (!active || !thread) return;
          const completed = active;
          cancelRecovery();
          // Stop acknowledgments can precede late renderer callbacks. Retire the
          // old request before a steering replacement reuses this adapter.
          if (status !== "completed") retiredRequestIds.add(completed.requestId);
          active = null;
          // Interrupted submissions can leave reasoning open in the same run.
          for (const turn of new Set(outputTurns.values())) {
            if (turn.input.runId === completed.input.runId) yield* settleReasoning(turn);
          }
          const timestamp = yield* DateTime.now;
          const finalKey = `${completed.turn.id}:${completed.requestId}:final`;
          const finalMessage = messages.get(finalKey);
          if (finalMessage?.streaming) {
            const message = { ...finalMessage, streaming: false, updatedAt: timestamp };
            messages.set(finalKey, message);
            yield* emit({ type: "message.updated", driver: CHATGPT_DRIVER, message });
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_DRIVER,
              turnItem: {
                id: itemIds.get(finalKey)!,
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
        const recoverMissingCompletion = Effect.fnUntraced(function* (
          requestId: string,
          recoveringAfterRestart = false,
        ) {
          if (transportInterrupted) {
            yield* requestRecovery();
            return;
          }
          if (completionRecoveryRequestId === requestId) return;
          completionRecoveryRequestId = requestId;
          const recoveryGeneration = active?.generation;
          yield* Effect.gen(function* () {
            // Normal streaming wins. Only refresh if Terminal MCP is done and
            // the completion callback is still missing after three minutes.
            // A restarted session has already lost its stream callback; reconcile
            // immediately rather than waiting another three minutes.
            const delays = recoveringAfterRestart
              ? (["0 millis", "3 minutes"] as const)
              : (["3 minutes"] as const);
            for (const delay of delays) {
              yield* Effect.sleep(delay);
              if (
                active?.requestId !== requestId ||
                active.generation !== recoveryGeneration ||
                streamComplete ||
                binding.state !== "done"
              )
                return;
              const updates = yield* attempt(() => connection.readCompletion(requestId)).pipe(
                Effect.catch(() => requestRecovery().pipe(Effect.as(null))),
              );
              if (
                active?.requestId !== requestId ||
                active.generation !== recoveryGeneration ||
                streamComplete ||
                binding.state !== "done"
              )
                return;
              if (updates) {
                // Recovered text must be ingested before the completion event.
                for (const update of updates)
                  yield* Queue.offer(incoming, { kind: "chat", update });
                return;
              }
            }
            if (
              active?.requestId === requestId &&
              active.generation === recoveryGeneration &&
              !streamComplete &&
              binding.state === "done" &&
              !transportInterrupted
            ) {
              yield* Effect.logWarning(
                "ChatGPT completion remained unconfirmed after the recovery refresh; forcing the turn closed",
                {
                  threadId: input.threadId,
                },
              );
              retiredRequestIds.add(requestId);
              yield* attempt(() => connection.stop()).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to stop ChatGPT while forcing the turn closed", {
                    threadId: input.threadId,
                    cause,
                  }),
                ),
              );
              // A newer provider generation may have started while stop() was in flight.
              // Never terminalize that replacement on behalf of this stale recovery.
              if (
                active?.requestId === requestId &&
                active.generation === recoveryGeneration &&
                !streamComplete
              ) {
                yield* finish("forced");
              }
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (completionRecoveryRequestId === requestId) completionRecoveryRequestId = null;
              }),
            ),
          );
        });
        const recoverCompletedProviderWithoutTask = Effect.fnUntraced(function* (
          requestId: string,
        ) {
          if (recoveredFinalRecoveryRequestId === requestId) return;
          recoveredFinalRecoveryRequestId = requestId;
          const recoveryGeneration = active?.generation;
          yield* Effect.gen(function* () {
            // A recovered native final is strong evidence that the provider turn
            // ended, but Terminal MCP may still legitimately issue a continuation.
            // Give it the same three-minute grace period used by missing-stream
            // recovery before treating the orphaned task as stale.
            yield* Effect.sleep("3 minutes");
            if (
              active?.requestId !== requestId ||
              active.generation !== recoveryGeneration ||
              binding.state === "done"
            )
              return;
            yield* Effect.logWarning(
              "Recovered ChatGPT final answer while Terminal MCP remained active; forcing the turn closed",
              { threadId: input.threadId },
            );
            retiredRequestIds.add(requestId);
            // Pause the orphaned Terminal activation so its inactivity recovery
            // cannot revive a provider turn that we are about to terminalize.
            yield* attempt(() =>
              connection.control("pause", { requestId: `recovered-final-${requestId}` }),
            ).pipe(Effect.ignore);
            yield* attempt(() => connection.stop()).pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Failed to stop ChatGPT while forcing a recovered final turn closed",
                  { threadId: input.threadId, cause },
                ),
              ),
            );
            // A Terminal continuation or newer provider generation may have won
            // while pause/stop was in flight. Refresh task state and never close
            // a generation that has since continued or completed normally.
            binding = yield* attempt(() => connection.control<TerminalBinding>("get")).pipe(
              Effect.catch(() => Effect.succeed(binding)),
            );
            if (
              active?.requestId === requestId &&
              active.generation === recoveryGeneration &&
              binding.state !== "done"
            )
              yield* finish("forced");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (recoveredFinalRecoveryRequestId === requestId)
                  recoveredFinalRecoveryRequestId = null;
              }),
            ),
          );
        });
        const acceptUpdate = Effect.fnUntraced(function* (update: ChatGPTUpdate) {
          if (update.requestId && retiredRequestIds.has(update.requestId)) return;
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
          const key = `${outputTurn.turn.id}:${outputTurn.requestId}:${(!update.channel || update.channel === "final") && (!update.recipient || update.recipient === "all") ? "final" : update.messageId}`;
          if (isFinalAnswer) yield* settleReasoning(outputTurn);
          const existing = messages.get(key);
          const streaming = update.status !== "finished_successfully";
          if (existing && !existing.streaming && streaming && existing.text.startsWith(update.text))
            return;
          const restored = restoredItems.get(`${outputTurn.turn.id}:${update.messageId}`);
          const id =
            existing?.id ??
            (restored?.type === "assistant_message"
              ? restored.messageId
              : MessageId.make(`chatgpt:${input.threadId}:${key}`));
          let text = update.text;
          if (isFinalAnswer) {
            const fragments = finalFragments.get(key) ?? new Map<string, string>();
            const previous = fragments.get(update.messageId);
            if (
              previous &&
              previous.length > update.text.length &&
              previous.startsWith(update.text)
            )
              return;
            fragments.set(update.messageId, update.text);
            finalFragments.set(key, fragments);
            text = [...fragments.values()].reduce<string>(
              (merged, fragment) => mergeFinalAnswer(merged, fragment),
              "",
            );
          }
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
            createdAt:
              existing?.createdAt ??
              restored?.startedAt ??
              (typeof update.createdAt === "number" && Number.isFinite(update.createdAt)
                ? DateTime.makeUnsafe(update.createdAt * 1000)
                : timestamp),
            updatedAt: timestamp,
          };
          messages.set(key, message);
          nativeMessageIds.set(key, update.messageId);
          const ordinal = itemOrdinals.get(key) ?? restored?.ordinal ?? ++nextOrdinal;
          itemOrdinals.set(key, ordinal);
          const itemId =
            itemIds.get(key) ?? restored?.id ?? TurnItemId.make(`chatgpt:${input.threadId}:${key}`);
          itemIds.set(key, itemId);

          const base = {
            id: itemId,
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
        const applySnapshot = Effect.fnUntraced(function* (snapshot: ConversationSnapshot) {
          if (active?.requestId === snapshot.latestRequestId && snapshot.usesTerminalTools)
            usedTerminalTools = true;
          for (const update of snapshot.updates) yield* acceptUpdate(update);
          if (
            snapshot.idle &&
            snapshot.complete &&
            active !== null &&
            active.requestId === snapshot.latestRequestId
          )
            yield* acceptUpdate({
              kind: "complete",
              requestId: active.requestId,
              conversationId: binding.conversation_id,
            });
          const recoveredFinal = snapshot.updates.some(
            (update) =>
              update.kind === "update" &&
              update.requestId === snapshot.latestRequestId &&
              update.role === "assistant" &&
              (!update.channel || update.channel === "final") &&
              (!update.recipient || update.recipient === "all") &&
              update.hidden !== true &&
              update.status === "finished_successfully",
          );
          if (
            recoveredFinal &&
            active !== null &&
            active.requestId === snapshot.latestRequestId &&
            binding.state !== "done"
          )
            yield* recoverCompletedProviderWithoutTask(active.requestId).pipe(
              Effect.forkIn(sessionScope),
            );
        });
        const recoverTransport = Effect.fnUntraced(function* (
          event: Extract<Update, { kind: "recover" }>,
        ) {
          if (event.token !== recoveryToken) return;
          let retry = true;
          yield* recoveryGate.permit.withPermits(1)(
            Effect.gen(function* () {
              if (event.token !== recoveryToken) return;
              const now = yield* Clock.currentTimeMillis;
              if (now < recoveryGate.unavailableUntil) return;
              const recovered = yield* Effect.result(
                Effect.gen(function* () {
                  if (transport.refreshThread) {
                    // The same service as Refresh also commits idle threads, which
                    // no longer have a run subscriber to persist adapter events.
                    yield* transport.refreshThread(input.threadId);
                    retry = active !== null && !streamComplete;
                  } else {
                    const result = yield* Deferred.make<
                      boolean,
                      ProviderAdapter.ProviderAdapterProtocolError
                    >();
                    yield* Queue.offer(incoming, {
                      kind: "recover_snapshot",
                      token: event.token,
                      result,
                    });
                    retry = yield* Deferred.await(result);
                  }
                }),
              );
              if (recovered._tag === "Failure") {
                // One unhealthy desktop must not receive a reconnect burst from
                // every thread sharing this provider instance.
                recoveryGate.unavailableUntil = (yield* Clock.currentTimeMillis) + 5_000;
                if (event.retry === 0)
                  yield* Effect.logWarning("ChatGPT refresh waits for the runtime to recover", {
                    threadId: input.threadId,
                  });
              } else recoveryGate.unavailableUntil = 0;
            }),
          );
          if (event.token !== recoveryToken) return;
          if (!retry) {
            recoveryScheduled = false;
            return;
          }
          yield* Effect.sleep(Math.min(30_000, 1_000 * 2 ** Math.min(event.retry, 5))).pipe(
            Effect.andThen(Queue.offer(incoming, { ...event, retry: event.retry + 1 })),
            Effect.forkIn(sessionScope),
          );
        });
        const synchronize = Effect.fnUntraced(function* (
          request: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput,
        ) {
          const projection = request.existingProjection!;
          thread = request.providerThread;
          const snapshot = yield* attempt(() => connection.readConversation());
          binding = yield* attempt(() =>
            connection.control<TerminalBinding>("register", {
              cwd,
              model: input.modelSelection.model,
            }),
          );
          for (const item of projection.turnItems) {
            nextOrdinal = Math.max(nextOrdinal, item.ordinal);
            if (item.nativeItemRef && item.providerTurnId)
              restoredItems.set(`${item.providerTurnId}:${item.nativeItemRef.nativeId}`, item);
          }
          let previous: ActiveTurn | undefined;
          for (const requestId of connection.submittedRequestIds) {
            const known = outputTurns.get(requestId);
            if (known) {
              previous = known;
              continue;
            }
            const run = projection.runs.find(
              (run) => run.userMessageId === requestId && run.providerThreadId === thread!.id,
            );
            const turn = run
              ? projection.providerTurns.find((turn) => turn.runAttemptId === run.activeAttemptId)
              : previous?.turn;
            if (run?.rootNodeId && turn)
              previous = {
                input: {
                  runId: run.id,
                  rootNodeId: run.rootNodeId,
                  runOrdinal: run.ordinal,
                  modelSelection: run.modelSelection,
                },
                turn,
                generation: ++generation,
                requestId,
              };
            else if (!run && previous)
              previous = { ...previous, generation: ++generation, requestId };
            else previous = undefined;
            if (previous) outputTurns.set(requestId, previous);
          }
          if (!active && snapshot.latestRequestId) {
            const candidate = outputTurns.get(snapshot.latestRequestId);
            if (
              candidate?.turn.status === "running" &&
              projection.runs.some(
                (run) => run.id === candidate.input.runId && run.status === "running",
              )
            ) {
              active = candidate;
              streamComplete = false;
              usedTerminalTools = true;
            }
          }
          yield* applySnapshot(snapshot);
          return {
            providerThread: thread,
            providerTurns: [],
            messages: [...messages]
              .filter(([key]) => !reasoningKeys.has(key))
              .map(([, message]) => message),
            turnItems: [...snapshotItems.values()],
            runtimeRequests: [],
          } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
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
                if (
                  event.update.kind === "disconnected" ||
                  (event.update.kind === "error" &&
                    (!event.update.requestId || event.update.requestId === active?.requestId))
                ) {
                  yield* requestRecovery();
                  return;
                }
                yield* acceptUpdate(event.update);
                return;
              }
              if (event.kind === "recover") {
                // Refresh asks this actor for a snapshot; never await it on
                // the actor itself or recovery would wait on its own queue.
                yield* recoverTransport(event).pipe(Effect.forkIn(sessionScope));
                return;
              }
              if (event.kind === "recover_snapshot") {
                yield* Effect.gen(function* () {
                  if (event.token !== recoveryToken) return false;
                  const snapshot = yield* attempt(() => connection.readConversation());
                  const currentBinding = yield* attempt(() =>
                    connection.control<TerminalBinding>("get"),
                  );
                  if (event.token !== recoveryToken) return false;
                  binding = currentBinding;
                  yield* applySnapshot(snapshot);
                  return active !== null && !streamComplete;
                }).pipe(
                  Effect.flatMap((retry) => Deferred.succeed(event.result, retry)),
                  Effect.catch((cause) => Deferred.fail(event.result, cause)),
                );
                return;
              }
              if (event.kind === "refresh") {
                yield* synchronize(event.input).pipe(
                  Effect.flatMap((snapshot) => Deferred.succeed(event.result, snapshot)),
                  Effect.catch((cause) => Deferred.fail(event.result, cause)),
                );
                return;
              }
              const control = event.event;
              // The provider-instance listener owns detached process events
              // independently of the lifetime of this native provider session.
              if (control.kind === "process.completed") return;
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
                  if (event.kind === "terminal" && event.event.kind !== "process.completed")
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
          const freshRequested = request.existingProviderThread?.nativeThreadRef === null;
          if (
            thread &&
            !(
              freshRequested &&
              (thread.nativeThreadRef !== null ||
                connection.conversationId !== null ||
                binding.conversation_id !== null)
            )
          )
            return thread;
          if (
            freshRequested &&
            (connection.conversationId !== null || binding.conversation_id !== null)
          ) {
            if (active)
              return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: CHATGPT_DRIVER,
                threadId: input.threadId,
                providerThreadId: active.turn.providerThreadId,
                runId: active.input.runId,
              });
            binding = yield* attempt(() => connection.resetNativeConversation());
            generation++;
            outputTurns.clear();
            retiredRequestIds.clear();
            messages.clear();
            finalFragments.clear();
            reasoningKeys.clear();
            itemOrdinals.clear();
            itemIds.clear();
            restoredItems.clear();
            nativeMessageIds.clear();
            streamComplete = false;
            thread = null;
          }
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
          const recoveringCompletedTask =
            binding.state === "done" &&
            request.message.createdBy === "agent" &&
            request.message.creationSource === "server" &&
            request.message.messageId.startsWith("message:restart-continuation:");
          const recoveryRequestId = recoveringCompletedTask
            ? connection.latestSubmittedRequestId
            : undefined;
          if (recoveringCompletedTask && !recoveryRequestId)
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CHATGPT_DRIVER,
              detail: "Cannot reconcile the completed ChatGPT task's submission identity",
            });
          if (!recoveringCompletedTask)
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
            requestId: recoveryRequestId ?? request.message.messageId,
          };
          cancelRecovery();
          transportInterrupted = false;
          outputTurns.set(active.requestId, active);
          streamComplete = false;
          usedTerminalTools = false;
          yield* emit({
            type: "provider_turn.updated",
            driver: CHATGPT_DRIVER,
            threadId: input.threadId,
            providerTurn: turn,
          });
          if (recoveryRequestId) {
            yield* recoverMissingCompletion(recoveryRequestId, true).pipe(
              Effect.forkIn(sessionScope),
            );
            return;
          }
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
            Effect.mapError((error) =>
              error.cause instanceof ChatGPTSubmissionNotStartedError
                ? new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CHATGPT_DRIVER,
                    threadId: input.threadId,
                    providerThreadId: request.providerThread.id,
                    runId: request.runId,
                    cause: new ChatGPTTurnNotSubmittedError(error),
                  })
                : error,
            ),
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
              cancelRecovery();
              if (active) retiredRequestIds.add(active.requestId);
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
          readThreadSnapshot: (request) =>
            Effect.gen(function* () {
              if (!request.existingProjection)
                return {
                  providerThread: request.providerThread,
                  providerTurns: [],
                  messages: [...messages]
                    .filter(([key]) => !reasoningKeys.has(key))
                    .map(([, message]) => message),
                  runtimeRequests: [],
                };
              const result = yield* Deferred.make<
                ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
                ProviderAdapter.ProviderAdapterProtocolError
              >();
              yield* Queue.offer(incoming, { kind: "refresh", input: request, result });
              return yield* Deferred.await(result);
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
