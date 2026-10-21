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

type TerminalToolItem = Extract<
  OrchestrationV2TurnItem,
  { type: "dynamic_tool" | "command_execution" | "file_change" }
>;

function terminalToolName(toolName: string): string {
  return toolName.replace(/^fedora_t3code\./u, "");
}

function terminalToolInputRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function terminalToolText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const rendered = value.flatMap((entry) => {
      const text = terminalToolText(entry);
      return text === undefined ? [] : [text];
    });
    const unique = [...new Set(rendered)];
    return unique.length > 0 ? unique.join("\n") : undefined;
  }
  const record = terminalToolInputRecord(value);
  if (!record) return undefined;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (typeof record.preview === "string") return record.preview;
  if (typeof record.result === "string") return record.result;
  return Array.isArray(record.content) ? terminalToolText(record.content) : undefined;
}

function terminalPatchPaths(input: unknown): string[] {
  const patch = terminalToolInputRecord(input)?.patch;
  if (typeof patch !== "string") return [];
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\+\+\+\s+(?<path>\S+)\s*$/gmu)) {
    const raw = match.groups?.path;
    if (!raw || raw === "/dev/null") continue;
    const path = raw.startsWith("b/") ? raw.slice(2) : raw;
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function terminalFileChangePath(toolName: string, input: unknown): string | undefined {
  const record = terminalToolInputRecord(input);
  const direct = toolName === "copy_path" || toolName === "move_path" ? record?.dst : record?.path;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return toolName === "apply_patch" ? terminalPatchPaths(input)[0] : undefined;
}

function terminalFileChangeOperation(toolName: string): string {
  switch (toolName) {
    case "copy_path":
      return "copy";
    case "make_dir":
      return "create";
    case "move_path":
      return "move";
    default:
      return "update";
  }
}

function terminalToolProjection(
  toolName: string,
): "command" | "edit" | "read" | "javascript" | "tool" {
  switch (toolName) {
    case "run_command":
    case "start_process":
    case "run_codex_yolo":
    case "start_codex_yolo":
    case "run_agy_yolo":
    case "start_agy_yolo":
      return "command";
    case "apply_patch":
    case "copy_path":
    case "make_dir":
    case "move_path":
    case "replace_in_file":
    case "write_file":
      return "edit";
    case "list_dir":
    case "read_file":
    case "stat_path":
    case "watch_image":
      return "read";
    case "node_repl_js":
      return "javascript";
    default:
      return "tool";
  }
}

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
        let interrupting = false;
        let nextOrdinal = 0;
        const itemOrdinals = new Map<string, number>();
        const itemIds = new Map<string, TurnItemId>();
        const restoredItems = new Map<string, OrchestrationV2TurnItem>();
        const terminalToolItems = new Map<string, TerminalToolItem>();
        const terminalToolInputs = new Map<string, unknown>();
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
        const hasRunningTerminalTools = (turn: ActiveTurn | null) =>
          turn !== null &&
          [...terminalToolItems.values()].some(
            (item) => item.providerTurnId === turn.turn.id && item.status === "running",
          );
        const acceptTerminalToolEvent = Effect.fnUntraced(function* (control: TerminalEvent) {
          if (control.kind !== "tool_started" && control.kind !== "tool_completed") return;
          const operationId = control.payload.operationId;
          const fullToolName = control.payload.toolName;
          if (!operationId || !fullToolName) return;
          usedTerminalTools = true;
          const toolName = terminalToolName(fullToolName);
          const existing = terminalToolItems.get(operationId);
          if (!existing && (!active || !thread)) return;
          const timestamp = yield* DateTime.now;
          const eventTime =
            typeof control.created === "number" && Number.isFinite(control.created)
              ? DateTime.makeUnsafe(control.created * 1000)
              : timestamp;
          const owner = existing
            ? {
                runId: existing.runId,
                nodeId: existing.nodeId,
                providerThreadId: existing.providerThreadId,
                providerTurnId: existing.providerTurnId,
              }
            : {
                runId: active!.input.runId,
                nodeId: active!.input.rootNodeId,
                providerThreadId: thread!.id,
                providerTurnId: active!.turn.id,
              };
          const status =
            control.kind === "tool_started"
              ? ("running" as const)
              : control.payload.status === "failed"
                ? ("failed" as const)
                : control.payload.status === "cancelled"
                  ? ("cancelled" as const)
                  : ("completed" as const);
          if (control.kind === "tool_started")
            terminalToolInputs.set(operationId, control.payload.input ?? null);
          const rawInput =
            terminalToolInputs.get(operationId) ??
            (existing?.type === "dynamic_tool"
              ? existing.input
              : existing?.type === "command_execution"
                ? { command: existing.input }
                : existing?.type === "file_change"
                  ? { path: existing.fileName }
                  : null);
          const base = {
            id:
              existing?.id ??
              TurnItemId.make(`chatgpt:${input.threadId}:terminal-tool:${operationId}`),
            threadId: input.threadId,
            ...owner,
            nativeItemRef: ref(operationId),
            parentItemId: null,
            ordinal: existing?.ordinal ?? ++nextOrdinal,
            status,
            title: null,
            startedAt: existing?.startedAt ?? eventTime,
            completedAt: control.kind === "tool_started" ? null : eventTime,
            updatedAt: eventTime,
          } as const;
          const projection = terminalToolProjection(toolName);
          let item: TerminalToolItem;
          if (projection === "command") {
            const record = terminalToolInputRecord(rawInput);
            const command =
              typeof record?.command === "string" && record.command.trim().length > 0
                ? record.command.trim()
                : existing?.type === "command_execution"
                  ? existing.input
                  : toolName.replaceAll("_", " ");
            const output =
              control.kind === "tool_completed"
                ? terminalToolText(control.payload.output)
                : existing?.type === "command_execution"
                  ? existing.output
                  : undefined;
            const exitCodeMatch = output?.match(/\bExit Code:\s*(-?\d+)/u);
            const exitCode =
              exitCodeMatch?.[1] === undefined ? undefined : Number(exitCodeMatch[1]);
            item = {
              ...base,
              type: "command_execution",
              input: command,
              ...(output === undefined ? {} : { output }),
              ...(exitCode === undefined || !Number.isInteger(exitCode) ? {} : { exitCode }),
              ...(control.kind === "tool_completed" && status === "failed"
                ? { outputIndicatesFailure: true }
                : {}),
            };
          } else if (projection === "edit") {
            const retained = existing?.type === "file_change" ? existing : null;
            const record = terminalToolInputRecord(rawInput);
            const patchPaths = toolName === "apply_patch" ? terminalPatchPaths(rawInput) : [];
            const fileName =
              terminalFileChangePath(toolName, rawInput) ??
              retained?.fileName ??
              toolName.replaceAll("_", " ");
            const oldPath =
              (toolName === "copy_path" || toolName === "move_path") &&
              typeof record?.src === "string" &&
              record.src.trim().length > 0
                ? record.src.trim()
                : undefined;
            const changes =
              patchPaths.length > 0
                ? patchPaths.map((path) => ({ operation: "update", path }))
                : [
                    {
                      operation: terminalFileChangeOperation(toolName),
                      path: fileName,
                      ...(oldPath === undefined ? {} : { oldPath }),
                      ...(toolName === "make_dir" ? { fileType: "directory" } : {}),
                    },
                  ];
            const diffStr =
              toolName === "apply_patch" && typeof record?.patch === "string"
                ? record.patch
                : retained?.diffStr;
            const oldStr =
              toolName === "replace_in_file" && typeof record?.old === "string"
                ? record.old
                : retained?.oldStr;
            const newStr =
              toolName === "replace_in_file" && typeof record?.new === "string"
                ? record.new
                : toolName === "write_file" && typeof record?.content === "string"
                  ? record.content
                  : retained?.newStr;
            item = {
              ...retained,
              ...base,
              type: "file_change",
              fileName,
              changes:
                retained?.changes && patchPaths.length === 0 && record === null
                  ? retained.changes
                  : changes,
              ...(diffStr === undefined ? {} : { diffStr }),
              ...(oldStr === undefined ? {} : { oldStr }),
              ...(newStr === undefined ? {} : { newStr }),
            };
          } else {
            const displayToolName =
              projection === "read"
                ? "Read"
                : projection === "javascript"
                  ? "node_repl.js"
                  : toolName;
            const inputRecord = terminalToolInputRecord(rawInput);
            const viewedImagePath =
              toolName === "watch_image" && typeof inputRecord?.path === "string"
                ? inputRecord.path
                : undefined;
            item = {
              ...base,
              type: "dynamic_tool",
              toolName: displayToolName,
              ...(viewedImagePath === undefined ? {} : { viewedImagePath }),
              input: rawInput,
              ...(control.kind === "tool_completed"
                ? { output: control.payload.output ?? null }
                : existing?.type === "dynamic_tool" && existing.output !== undefined
                  ? { output: existing.output }
                  : {}),
            };
          }
          terminalToolItems.set(operationId, item);
          yield* emit({
            type: "turn_item.updated",
            driver: CHATGPT_DRIVER,
            turnItem: item,
          });
          if (control.kind === "tool_completed") yield* completeWithToolRecovery();
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
          for (const [operationId, item] of terminalToolItems) {
            if (item.providerTurnId !== completed.turn.id || item.status !== "running") continue;
            const settled: TerminalToolItem = {
              ...item,
              status: status === "completed" ? "failed" : "cancelled",
              completedAt: timestamp,
              updatedAt: timestamp,
            };
            terminalToolItems.set(operationId, settled);
            yield* emit({ type: "turn_item.updated", driver: CHATGPT_DRIVER, turnItem: settled });
          }
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
        let staleToolRecoveryRequestId: string | null = null;
        const recoverStaleTerminalTools = Effect.fnUntraced(function* (
          requestId: string,
          providerTurnId: string,
        ) {
          if (staleToolRecoveryRequestId === requestId) return;
          staleToolRecoveryRequestId = requestId;
          yield* Effect.sleep("30 seconds");
          if (
            active?.requestId !== requestId ||
            active.turn.id !== providerTurnId ||
            !streamComplete ||
            binding.state !== "done" ||
            !hasRunningTerminalTools(active)
          )
            return;
          yield* Effect.logWarning("Terminal tool completion was not observed after task done", {
            threadId: input.threadId,
            requestId,
          });
          yield* finish("completed");
        });
        const completeWithToolRecovery = Effect.fnUntraced(function* () {
          if (!active || !streamComplete || binding.state !== "done") return;
          if (hasRunningTerminalTools(active)) {
            yield* recoverStaleTerminalTools(active.requestId, active.turn.id).pipe(
              Effect.forkScoped,
            );
            return;
          }
          yield* finish("completed");
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
              yield* attempt(() => connection.stop(requestId)).pipe(
                Effect.timeout("10 seconds"),
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
            ).pipe(
              Effect.timeout("5 seconds"),
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Failed to pause orphaned Terminal activation before closing its recovered final",
                  { threadId: input.threadId, cause },
                ),
              ),
            );
            // The native final is already completed: stopCompletion is unnecessary
            // and can hang after a renderer restart (or stop a later generation).
            // Do not let an unresponsive Terminal endpoint prevent terminalization.
            binding = yield* attempt(() => connection.control<TerminalBinding>("get")).pipe(
              Effect.timeout("5 seconds"),
              Effect.catch(() => Effect.succeed(binding)),
            );
            // A Terminal continuation or newer provider generation may have won
            // while pause/read was in flight.
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
              if (binding.state === "done") yield* completeWithToolRecovery();
              else if (!usedTerminalTools && !hasRunningTerminalTools(active))
                yield* finish("completed");
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
                    // The Refresh service persists recovered output even when no
                    // live run subscriber exists. It may, however, reconcile via
                    // another provider-session instance, so it is not sufficient
                    // to update this actor's active generation by itself.
                    yield* transport.refreshThread(input.threadId);
                  }
                  // Always reconcile the original live adapter actor as well.
                  // This is where generation fencing, Terminal task state, and the
                  // recovered-final forced-completion timer are owned.
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
            const nativeItemId = item.nativeItemRef?.nativeId;
            if (
              nativeItemId &&
              item.id ===
                TurnItemId.make(`chatgpt:${input.threadId}:terminal-tool:${nativeItemId}`) &&
              (item.type === "dynamic_tool" ||
                item.type === "command_execution" ||
                item.type === "file_change")
            ) {
              terminalToolItems.set(nativeItemId, item);
              terminalToolInputs.set(
                nativeItemId,
                item.type === "dynamic_tool"
                  ? item.input
                  : item.type === "command_execution"
                    ? { command: item.input }
                    : { path: item.fileName },
              );
            }
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
              if (control.kind === "tool_started" || control.kind === "tool_completed") {
                yield* acceptTerminalToolEvent(control);
              } else if (
                control.kind === "link_pr" &&
                control.payload.url &&
                transport.linkPullRequest
              ) {
                yield* transport.linkPullRequest(
                  input.threadId,
                  control.payload.url,
                  control.event_id,
                );
              } else if (control.kind === "state" && control.payload.state === "done") {
                binding = { ...binding, state: "done" };
                if (streamComplete) yield* completeWithToolRecovery();
                else if (active)
                  yield* recoverMissingCompletion(active.requestId).pipe(Effect.forkScoped);
              } else if (control.kind === "continue" && active && !interrupting) {
                const activeRequestId = active.requestId;
                const claim = yield* attempt(() =>
                  connection.control<{ valid: boolean }>("claim", { eventId: control.event_id }),
                );
                if (claim.valid && !interrupting && active?.requestId === activeRequestId) {
                  if (!streamComplete) yield* attempt(() => connection.stop(activeRequestId));
                  if (!interrupting && active?.requestId === activeRequestId) {
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
              interrupting = true;
              cancelRecovery();
              const timestamp = yield* DateTime.now;
              const requestId = active?.requestId;
              if (!streamComplete && requestId) yield* attempt(() => connection.stop(requestId));
              if (requestId) retiredRequestIds.add(requestId);
              yield* attempt(() =>
                connection.control("pause", {
                  requestId: `stop-${input.threadId}-${DateTime.toEpochMillis(timestamp)}`,
                }),
              ).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to pause Terminal MCP after interrupting ChatGPT", {
                    threadId: input.threadId,
                    cause,
                  }),
                ),
              );
              yield* finish("interrupted");
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interrupting = false;
                }),
              ),
            ),
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
