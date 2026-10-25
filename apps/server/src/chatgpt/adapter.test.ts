import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ChatGPTSettings,
  ThreadId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  TurnItemId,
  OrchestrationV2AppThread,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  ChatGPTSubmissionNotStartedError,
  type ChatGPTUpdate,
  type TerminalEvent,
} from "./connection.ts";

const decodeThreadProjection = Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection);

const fakes = vi.hoisted(() => ({
  failNextSend: false,
  rejectNextSendBeforeSubmission: false,
  failNextStop: false,
  failNextPause: false,
  failNextReset: false,
  nextConversationId: null as string | null,
  nextSubmittedIds: null as string[] | null,
  connections: [] as Array<{
    callback?: (update: ChatGPTUpdate) => void;
    publish: (event: TerminalEvent) => void;
    sent: string[];
    sentProjectIds: Array<string | null | undefined>;
    stops: number;
    controls: string[];
    acknowledged: string[];
    idle: boolean;
    idleChecks: number;
    onCompletionRead?: () => void;
    onDoneAcknowledged?: () => void;
    onStop?: () => void | Promise<void>;
    onControl?: (action: string) => void | Promise<void>;
    onSend?: (id: string) => void;
    onClaim?: () => void;
    claimGate?: Promise<void>;
    state: string;
    conversationId: string | null;
    conversationReads: number;
    resumeRequests: Array<string | undefined>;
    conversationFailures: number;
    onConversationRead?: () => void;
    conversationReadGate?: Promise<void>;
    recoveredTerminalTools: boolean;
    options: { orchestrationCommand?: string | undefined };
  }>,
}));
vi.mock("./connection.ts", () => ({
  ChatGPTSubmissionNotStartedError: class ChatGPTSubmissionNotStartedError extends Error {},
  ChatGPTConnection: class {
    conversationId: string | null = null;
    messages = [];
    callback?: (update: ChatGPTUpdate) => void;
    sent: string[] = [];
    sentProjectIds: Array<string | null | undefined> = [];
    stops = 0;
    controls: string[] = [];
    acknowledged: string[] = [];
    idle = false;
    idleChecks = 0;
    epoch = 0;
    state = "working";
    conversationReads = 0;
    conversationFailures = 0;
    onConversationRead?: () => void;
    conversationReadGate?: Promise<void>;
    recoveredTerminalTools = false;
    pending: Array<TerminalEvent> = [];
    wake?: () => void;
    readonly options: { orchestrationCommand?: string | undefined };
    constructor(options: { orchestrationCommand?: string | undefined }) {
      this.options = options;
      this.conversationId = fakes.nextConversationId;
      fakes.nextConversationId = null;
      if (fakes.nextSubmittedIds) this.sent = [...fakes.nextSubmittedIds];
      fakes.nextSubmittedIds = null;
      fakes.connections.push(this);
    }
    async load() {}
    close() {}
    async adoptConversation(conversationId: string) {
      this.conversationId = conversationId;
    }
    async resetNativeConversation() {
      if (fakes.failNextReset) {
        fakes.failNextReset = false;
        throw new Error("Native reset unavailable");
      }
      this.conversationId = null;
      this.controls.push("reset");
      return { conversation_id: null, epoch: ++this.epoch, state: "idle" };
    }
    onUpdate(callback: (update: ChatGPTUpdate) => void) {
      this.callback = callback;
    }
    async control(action: string) {
      this.controls.push(action);
      if (action === "pause" && fakes.failNextPause) {
        fakes.failNextPause = false;
        throw new Error("Pause failed");
      }
      await this.onControl?.(action);
      if (action === "activate") {
        this.epoch++;
        this.state = "working";
      }
      if (action === "claim") {
        this.onClaim?.();
        if (this.claimGate) await this.claimGate;
        return { valid: true };
      }
      return {
        thread_id: "test-thread",
        terminal_id: "test-thread",
        conversation_id: this.conversationId,
        epoch: this.epoch,
        state: this.state,
        paused: 0,
        cwd: "/tmp",
        model: "test-model",
      };
    }
    async send(
      id: string,
      _text: string,
      _model: string,
      _cwd: string,
      _reasoningEffort?: string,
      _images?: unknown[],
      projectId?: string | null,
    ) {
      if (fakes.rejectNextSendBeforeSubmission) {
        fakes.rejectNextSendBeforeSubmission = false;
        throw new ChatGPTSubmissionNotStartedError("Native turn was never submitted");
      }
      this.sent.push(id);
      this.sentProjectIds.push(projectId);
      this.onSend?.(id);
      if (fakes.failNextSend) {
        fakes.failNextSend = false;
        throw new Error("Image upload failed");
      }
    }
    onStop?: () => void | Promise<void>;
    onControl?: (action: string) => void | Promise<void>;
    onSend?: (id: string) => void;
    onClaim?: () => void;
    claimGate?: Promise<void>;
    async stop() {
      this.stops++;
      await this.onStop?.();
      if (fakes.failNextStop) {
        fakes.failNextStop = false;
        throw new Error("Stop failed");
      }
    }
    get submittedRequestIds() {
      return [...this.sent];
    }
    readonly resumeRequests: Array<string | undefined> = [];
    async readConversation(resumeRequestId?: string) {
      this.resumeRequests.push(resumeRequestId);
      this.conversationReads++;
      this.onConversationRead?.();
      await this.conversationReadGate;
      if (this.conversationFailures-- > 0) throw new Error("ChatGPT is offline");
      const requestId = this.sent.at(-1)!;
      return {
        updates: [
          {
            kind: "update" as const,
            requestId,
            conversationId: null,
            role: "assistant",
            channel: "final",
            messageId: "recovered-final",
            text: "Recovered final answer",
            status: "finished_successfully",
          },
        ],
        idle: this.idle,
        complete: this.idle,
        latestRequestId: requestId,
        usesTerminalTools: this.recoveredTerminalTools,
      };
    }
    get latestSubmittedRequestId() {
      return this.sent.at(-1);
    }
    onCompletionRead?: () => void;
    onDoneAcknowledged?: () => void;
    async readCompletion(requestId: string): Promise<ChatGPTUpdate[] | null> {
      this.idleChecks++;
      this.onCompletionRead?.();
      return this.idle
        ? [
            {
              kind: "update",
              requestId,
              conversationId: null,
              role: "assistant",
              channel: "final",
              messageId: "recovered-final",
              text: "Recovered final answer",
              status: "finished_successfully",
            },
            { kind: "complete", requestId, conversationId: null },
          ]
        : null;
    }
    async acknowledge(event: TerminalEvent) {
      this.acknowledged.push(event.event_id);
      if (event.kind === "state" && event.payload.state === "done") this.onDoneAcknowledged?.();
    }
    publish(event: TerminalEvent) {
      this.pending.push(event);
      this.wake?.();
    }
    async *terminalEvents(signal: AbortSignal) {
      while (!signal.aborted) {
        if (!this.pending.length)
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        const event = this.pending.shift();
        if (event) yield event;
      }
    }
  },
}));
import { makeChatGPTAdapter } from "./adapter.ts";

const fixtureWithProject = (
  linkedProject: string | null = null,
  selectedProject?: string,
) => Effect.gen(function* () {
  const threadId = ThreadId.make("test-thread");
  const now = yield* DateTime.now;
  const selection = {
    instanceId: ProviderInstanceId.make("chatgpt"),
    model: "test-model",
    ...(selectedProject === undefined
      ? {}
      : { options: [{ id: "chatgptProjectId", value: selectedProject }] }),
  };
  const policy = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: "/tmp",
  };
  const refreshMcp = vi.fn();
  const attachMcp = vi.fn<Parameters<typeof makeChatGPTAdapter>[1]["attachMcp"]>(() =>
    Effect.succeed({
      command: "test-orchestration-command",
      refresh: Effect.sync(refreshMcp),
    }),
  );
  const refreshThread = vi.fn((): Effect.Effect<void> => Effect.void);
  const adapter = makeChatGPTAdapter(
    {
      instanceId: selection.instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: yield* Schema.decodeEffect(ChatGPTSettings)({}),
    },
    {
      token: "test-token",
      environmentId: "test-environment",
      cacheDir: "/tmp/test-chatgpt",
      attachMcp,
      resolveLinkedProject: () => Effect.succeed(linkedProject),
      // Production recovery persists through the Refresh service first. Keep the
      // unit harness on that path so local reconciliation cannot silently drift.
      refreshThread,
    },
  );
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("test-session"),
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const events =
    yield* Queue.unbounded<
      import("@t3tools/provider-core/server/ProviderAdapter").ProviderAdapterV2Event
    >();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const appThread = yield* Schema.decodeUnknownEffect(OrchestrationV2AppThread)({
    id: threadId,
    projectId: "project",
    title: "Test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const turnInput = {
    appThread,
    threadId,
    runId: RunId.make("run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt"),
    rootNodeId: NodeId.make("root"),
    providerThread,
    message: {
      messageId: MessageId.make("request-one"),
      text: "test",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
    modelSelection: selection,
    runtimePolicy: policy,
  };
  yield* session.startTurn(turnInput);
  return {
    adapter,
    attachMcp,
    refreshMcp,
    refreshThread,
    turnInput,
    session,
    events,
    fake: fakes.connections.at(-1)!,
    requestId: turnInput.message.messageId,
  };
});

const fixture = fixtureWithProject();

// Persisted runs retain the first user message while Terminal MCP's continuation
// IDs are only present in the native submission history.
const runningProjection = (
  fixtureValue: Effect.Success<typeof fixture>,
  turnItems: ReadonlyArray<unknown> = [],
) => {
  const { turnInput } = fixtureValue;
  const now = turnInput.appThread.updatedAt;
  return decodeThreadProjection({
    thread: turnInput.appThread,
    runs: [
      {
        id: turnInput.runId,
        threadId: turnInput.threadId,
        ordinal: turnInput.runOrdinal,
        providerInstanceId: turnInput.modelSelection.instanceId,
        modelSelection: turnInput.modelSelection,
        providerThreadId: turnInput.providerThread.id,
        userMessageId: turnInput.message.messageId,
        rootNodeId: turnInput.rootNodeId,
        activeAttemptId: turnInput.attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [
      {
        id: ProviderTurnId.make(`chatgpt:${turnInput.attemptId}`),
        providerThreadId: turnInput.providerThread.id,
        nodeId: turnInput.rootNodeId,
        runAttemptId: turnInput.attemptId,
        nativeTurnRef: null,
        ordinal: turnInput.providerTurnOrdinal,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  });
};

const terminal = (kind: string, state?: string, epoch = 1): TerminalEvent => ({
  seq: 1,
  event_id: `${kind}-${epoch}`,
  thread_id: "test-thread",
  epoch,
  kind,
  payload: state ? { state } : {},
});

const terminalTool = (
  kind: "tool_started" | "tool_completed",
  payload: TerminalEvent["payload"],
  epoch = 1,
): TerminalEvent => ({
  seq: 1,
  event_id: `${kind}-${String(payload.operationId)}-${epoch}`,
  thread_id: "test-thread",
  epoch,
  kind,
  created: 1,
  payload,
});

describe("ChatGPT task authority", () => {
  it.live("applies the linked ChatGPT project when no project was selected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake } = yield* fixtureWithProject("g-p-linked");
        expect(fake.sentProjectIds).toEqual(["g-p-linked"]);
      }),
    ),
  );

  it.live("lets an explicit General ChatGPT selection override the link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake } = yield* fixtureWithProject("g-p-linked", "general");
        expect(fake.sentProjectIds).toEqual([null]);
      }),
    ),
  );

  it.live("keeps inline handoff support when the orchestration bridge is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, attachMcp, turnInput } = yield* fixture;
        attachMcp.mockImplementation(() => Effect.succeed(undefined));
        const session = yield* adapter.openSession({
          threadId: turnInput.threadId,
          providerSessionId: ProviderSessionId.make("session-without-bridge"),
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId: turnInput.threadId,
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
        });
        yield* session.startTurn({ ...turnInput, providerThread });
        const fake = fakes.connections.at(-1)!;
        expect(fake.sent).toEqual([turnInput.message.messageId]);
        expect(fake.options.orchestrationCommand).toBeUndefined();
        expect(session.contextHandoffDelivery).toBeUndefined();
      }),
    ),
  );

  it.live("recovers a resumed thread's native identity from its registered conversation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, turnInput } = yield* fixture;
        fakes.nextConversationId = "existing-chatgpt-conversation";
        const session = yield* adapter.openSession({
          threadId: turnInput.threadId,
          providerSessionId: ProviderSessionId.make("restored-session"),
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
        });
        const restored = yield* session.resumeThread({
          providerThread: { ...turnInput.providerThread, nativeThreadRef: null },
        });
        expect(restored.id).toBe(turnInput.providerThread.id);
        expect(restored.nativeThreadRef?.nativeId).toBe("existing-chatgpt-conversation");
      }),
    ),
  );

  it.live("retains the connection's conversation when resuming a row with no native ID", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, session, turnInput } = yield* fixture;
        fake.conversationId = "cached-chatgpt-conversation";
        const resumed = yield* session.resumeThread({
          providerThread: { ...turnInput.providerThread, nativeThreadRef: null },
        });
        expect(resumed.nativeThreadRef?.nativeId).toBe("cached-chatgpt-conversation");
      }),
    ),
  );

  it.live("automatically refreshes a lost stream without submitting or stopping work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, events, fake, requestId } = yield* fixture;
        fake.idle = true;
        fake.callback?.({ kind: "error", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.findLast((event) => event.type === "message.updated")?.message.text).toBe(
          "Recovered final answer",
        );
        expect(recorded.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(fake.sent).toEqual([requestId]);
        expect(fake.stops).toBe(0);
        expect(fake.conversationReads).toBe(1);
        expect(fake.resumeRequests).toEqual([requestId]);
        for (const [status, message] of [
          ["running", "ChatGPT stream interrupted. Recovering this turn."],
          ["completed", "ChatGPT output recovered."],
        ])
          expect(recorded).toContainEqual(
            expect.objectContaining({
              type: "turn_item.updated",
              turnItem: expect.objectContaining({ type: "system_notice", status, message }),
            }),
          );
        expect(session.providerSessionId).toBe(ProviderSessionId.make("test-session"));
      }),
    ),
  );

  it.live("resumes the latest Terminal continuation after a provider-session restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureValue = yield* fixture;
        const { adapter, fake, turnInput, requestId } = fixtureValue;
        fake.publish(terminal("continue"));
        yield* Effect.sleep("20 millis");
        expect(fake.sent).toEqual([requestId, "continue-1"]);
        const projection = yield* runningProjection(fixtureValue);

        // A native connection reloads its persisted submissions, while the T3
        // run row still points to its original user message.
        fakes.nextSubmittedIds = [...fake.sent];
        const resumed = yield* adapter.openSession({
          threadId: turnInput.threadId,
          providerSessionId: ProviderSessionId.make("restarted-after-continue"),
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
        });
        const restoredFake = fakes.connections.at(-1)!;
        yield* resumed.readThreadSnapshot({
          providerThread: turnInput.providerThread,
          existingProjection: projection,
        });
        expect(restoredFake.resumeRequests).toEqual(["continue-1"]);
      }),
    ),
  );

  it.live("completes the original recovery notice when a continuation finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        fake.callback?.({ kind: "error", requestId, conversationId: null });
        const pending = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "system_notice" &&
              event.turnItem.status === "running",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const original = pending[0];
        if (original?.type !== "turn_item.updated") throw new Error("Missing recovery notice");
        fake.publish(terminal("continue"));
        yield* Effect.sleep("20 millis");
        expect(fake.sent).toContain("continue-1");
        fake.callback?.({
          kind: "update",
          requestId: "continue-1",
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "continued-response",
          text: "Done after recovery",
          status: "finished_successfully",
        });
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId: "continue-1", conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded).toContainEqual(
          expect.objectContaining({
            type: "turn_item.updated",
            turnItem: expect.objectContaining({
              id: original.turnItem.id,
              ordinal: original.turnItem.ordinal,
              status: "completed",
              message: "ChatGPT output recovered.",
            }),
          }),
        );
      }),
    ),
  );

  it.live("settles a persisted recovery notice after replacing the provider session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureValue = yield* fixture;
        const { adapter, events, fake, requestId, turnInput } = fixtureValue;
        fake.callback?.({ kind: "error", requestId, conversationId: null });
        const pending = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "system_notice" &&
              event.turnItem.status === "running",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const original = pending[0];
        if (original?.type !== "turn_item.updated") throw new Error("Missing recovery notice");
        const projection = yield* runningProjection(fixtureValue, [original.turnItem]);

        fakes.nextSubmittedIds = [requestId];
        const resumed = yield* adapter.openSession({
          threadId: turnInput.threadId,
          providerSessionId: ProviderSessionId.make("restarted-with-recovery-notice"),
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
        });
        const restoredFake = fakes.connections.at(-1)!;
        restoredFake.idle = true;
        restoredFake.state = "done";
        const restoredEvents =
          yield* Queue.unbounded<
            import("@t3tools/provider-core/server/ProviderAdapter").ProviderAdapterV2Event
          >();
        yield* resumed.events.pipe(
          Stream.runForEach((event) => Queue.offer(restoredEvents, event)),
          Effect.forkScoped,
        );
        yield* resumed.readThreadSnapshot({
          providerThread: turnInput.providerThread,
          existingProjection: projection,
        });
        const recorded = yield* Stream.fromQueue(restoredEvents).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded).toContainEqual(
          expect.objectContaining({
            type: "turn_item.updated",
            turnItem: expect.objectContaining({
              id: original.turnItem.id,
              ordinal: original.turnItem.ordinal,
              status: "completed",
              message: "ChatGPT output recovered.",
            }),
          }),
        );
      }),
    ),
  );

  it.live("completes a recovered final when Terminal MCP already marked the task done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        fake.idle = true;
        fake.recoveredTerminalTools = true;
        fake.state = "done";
        fake.callback?.({ kind: "disconnected", conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(recorded.findLast((event) => event.type === "message.updated")?.message.text).toBe(
          "Recovered final answer",
        );
        expect(fake.resumeRequests).toEqual([requestId]);
        expect(fake.stops).toBe(0);
        expect(fake.sent).toEqual([requestId]);
      }),
    ),
  );

  it.live("reuses the snapshot when Refresh reconciles through the live actor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, events, fake, requestId, refreshThread, turnInput } = yield* fixture;
        const projection = yield* decodeThreadProjection({
          thread: turnInput.appThread,
          runs: [],
          attempts: [],
          nodes: [],
          subagents: [],
          providerSessions: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          messages: [],
          plans: [],
          turnItems: [],
          checkpointScopes: [],
          checkpoints: [],
          contextHandoffs: [],
          contextTransfers: [],
          visibleTurnItems: [],
          updatedAt: turnInput.appThread.updatedAt,
        });
        refreshThread.mockImplementation(() =>
          session
            .readThreadSnapshot({
              providerThread: turnInput.providerThread,
              existingProjection: projection,
            })
            .pipe(Effect.asVoid, Effect.orDie),
        );
        fake.callback?.({ kind: "error", requestId, conversationId: null });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "system_notice" &&
              event.turnItem.message ===
                "Conversation state recovered; waiting for ChatGPT to finish.",
          ),
          Stream.runDrain,
        );
        expect(fake.conversationReads).toBe(1);
        expect(fake.resumeRequests).toEqual([requestId]);
      }),
    ),
  );

  it.effect("does not start recovery for an idle thread after a connection change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId, refreshThread } = yield* fixture;
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* TestClock.adjust("1 minute");
        expect(refreshThread).not.toHaveBeenCalled();
        expect(fake.conversationReads).toBe(0);
      }),
    ),
  );

  it.effect("waits through a runtime outage beyond the forced-completion deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const acknowledged = Promise.withResolvers<void>();
        const read = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.onConversationRead = () => read.resolve();
        fake.conversationFailures = 100;
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Effect.promise(() => read.promise);
        expect(yield* Queue.take(events)).toMatchObject({
          type: "turn_item.updated",
          turnItem: { type: "system_notice", status: "running" },
        });
        yield* TestClock.adjust("4 minutes");
        expect(fake.stops).toBe(0);
        expect(fake.sent).toEqual([requestId]);
        expect(yield* Queue.size(events)).toBe(0);
        fake.conversationFailures = 0;
        fake.idle = true;
        fake.state = "done";
        yield* TestClock.adjust("30 seconds");
        const recovered = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recovered.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(fake.stops).toBe(0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("refreshes a still-running native generation again instead of sending continue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "message.updated"),
          Stream.runDrain,
        );
        expect(fake.stops).toBe(0);
        expect(fake.sent).toEqual([requestId]);
        fake.idle = true;
        yield* TestClock.adjust("1 second");
        const recovered = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recovered.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(fake.conversationReads).toBe(2);
        expect(fake.sent).toEqual([requestId]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("keeps Terminal MCP task authority when recovered history reveals offline tool use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        fake.idle = true;
        fake.recoveredTerminalTools = true;
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "message.updated"),
          Stream.runDrain,
        );
        fake.publish(terminal("state", "done"));
        const recovered = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(fake.controls).not.toContain("pause");
        expect(recovered.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      }),
    ),
  );

  it.effect("forces a recovered final whose native status and Terminal task stay stuck", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const read = Promise.withResolvers<void>();
        fake.onConversationRead = () => read.resolve();
        fake.idle = false;
        fake.recoveredTerminalTools = true;
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Effect.promise(() => read.promise);
        yield* TestClock.adjust("179 seconds");
        expect(fake.stops).toBe(0);
        yield* TestClock.adjust("1 second");
        const recovered = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recovered.at(-1)).toMatchObject({ type: "turn.terminal", status: "forced" });
        expect(fake.controls).toContain("pause");
        expect(fake.stops).toBe(0);
        expect(fake.sent).toEqual([requestId]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forces a recovered final even if pausing the orphaned task never returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        yield* Queue.take(events);
        const read = Promise.withResolvers<void>();
        fake.onConversationRead = () => read.resolve();
        fake.idle = false;
        fake.recoveredTerminalTools = true;
        fake.onControl = (action) => (action === "pause" ? new Promise<void>(() => {}) : undefined);
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Effect.promise(() => read.promise);
        yield* TestClock.adjust("3 minutes");
        yield* TestClock.adjust("5 seconds");
        const recovered = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recovered.at(-1)).toMatchObject({ type: "turn.terminal", status: "forced" });
        expect(fake.stops).toBe(0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels outage retries even when native Stop fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, turnInput, fake, requestId } = yield* fixture;
        const read = Promise.withResolvers<void>();
        fake.onConversationRead = () => read.resolve();
        fake.conversationFailures = 100;
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Effect.promise(() => read.promise);
        fakes.failNextStop = true;
        const stopped = yield* Effect.exit(
          session.interruptTurn({
            providerThread: turnInput.providerThread,
            providerTurnId: ProviderTurnId.make("chatgpt:attempt"),
          }),
        );
        expect(stopped._tag).toBe("Failure");
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* TestClock.adjust("4 minutes");
        expect(fake.conversationReads).toBe(1);
        expect(fake.sent).toEqual([requestId]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("drops a restart snapshot that returns after Stop and a replacement turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, turnInput, events, fake, requestId } = yield* fixture;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        fake.onConversationRead = () => entered.resolve();
        fake.conversationReadGate = release.promise;
        fake.callback?.({ kind: "disconnected", conversationId: null });
        yield* Effect.promise(() => entered.promise);
        yield* session.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: ProviderTurnId.make("chatgpt:attempt"),
        });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        const nextId = MessageId.make("post-outage-replacement");
        yield* session.startTurn({
          ...turnInput,
          attemptId: RunAttemptId.make("post-outage-attempt"),
          message: { ...turnInput.message, messageId: nextId },
        });
        release.resolve();
        fake.callback?.({ kind: "complete", requestId: nextId, conversationId: null });
        const recovered = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recovered.filter((event) => event.type === "message.updated")).toEqual([]);
        expect(fake.sent).toEqual([requestId, nextId]);
      }),
    ),
  );

  it.live("ignores late output and completion from a steering-interrupted request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, fake, turnInput, requestId, events } = yield* fixture;
        yield* session.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: ProviderTurnId.make("chatgpt:attempt"),
        });
        for (;;) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal") break;
        }
        const replacementId = MessageId.make("steering-request");
        yield* session.startTurn({
          ...turnInput,
          attemptId: RunAttemptId.make("steering-attempt"),
          rootNodeId: NodeId.make("steering-root"),
          providerTurnOrdinal: 2,
          message: { ...turnInput.message, messageId: replacementId },
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: "retired-conversation",
          messageId: "late-old-final",
          role: "assistant",
          channel: "final",
          text: "Retired answer",
          status: "finished_successfully",
          endTurn: true,
        });
        fake.callback?.({ kind: "complete", requestId, conversationId: "retired-conversation" });
        fake.callback?.({
          kind: "update",
          requestId: replacementId,
          conversationId: "replacement-conversation",
          messageId: "replacement-final",
          role: "assistant",
          channel: "final",
          text: "Steered answer",
          status: "finished_successfully",
          endTurn: true,
        });
        fake.callback?.({
          kind: "complete",
          requestId: replacementId,
          conversationId: "replacement-conversation",
        });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(
          recorded
            .filter((event) => event.type === "message.updated")
            .map((event) => event.message.text),
        ).toEqual(["Steered answer"]);
        expect(
          new Set(
            recorded
              .filter((event) => event.type === "provider_thread.updated")
              .map((event) => event.providerThread.nativeThreadRef?.nativeId),
          ),
        ).toEqual(new Set(["replacement-conversation"]));
        expect(recorded.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
      }),
    ),
  );

  it.live("replaces a poisoned cached native conversation but fences active generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, fake, turnInput, requestId, events } = yield* fixture;
        fake.conversationId = "poisoned";
        const oldThread = {
          ...turnInput.providerThread,
          nativeThreadRef: {
            driver: turnInput.providerThread.driver,
            nativeId: "poisoned",
            strength: "strong" as const,
          },
        };
        const request = {
          threadId: turnInput.threadId,
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
          existingProviderThread: {
            ...oldThread,
            nativeThreadRef: null,
          },
        };
        const refused = yield* Effect.flip(session.ensureThread(request));
        expect(refused._tag).toBe("ProviderAdapterTurnStartError");
        expect(fake.controls).not.toContain("reset");
        fake.callback?.({ kind: "complete", requestId, conversationId: "poisoned" });
        for (;;) {
          const event = yield* Queue.take(events);
          if (event.type === "provider_turn.updated" && event.providerTurn.status === "completed")
            break;
        }
        const replacement = yield* session.ensureThread(request);
        expect(fake.controls).toContain("reset");
        expect(replacement.id).toBe(oldThread.id);
        expect(replacement.nativeThreadRef).toBeNull();
        expect(fake.conversationId).toBeNull();
        const repeated = yield* session.ensureThread(request);
        expect(repeated.id).toBe(replacement.id);
        expect(fake.controls.filter((action) => action === "reset")).toHaveLength(1);
      }),
    ),
  );

  it.live(
    "fences a failed reset and starts the following turn only on the rotated native identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { session, fake, turnInput, requestId, events } = yield* fixture;
          fake.conversationId = "uncertain-native-conversation";
          const oldThread = {
            ...turnInput.providerThread,
            nativeThreadRef: {
              driver: turnInput.providerThread.driver,
              nativeId: "uncertain-native-conversation",
              strength: "strong" as const,
            },
          };
          const freshRequest = {
            threadId: turnInput.threadId,
            modelSelection: turnInput.modelSelection,
            runtimePolicy: turnInput.runtimePolicy,
            existingProviderThread: { ...oldThread, nativeThreadRef: null },
          };
          // A still-active old submission cannot be reused or rotated.
          const activeRejection = yield* Effect.flip(session.ensureThread(freshRequest));
          expect(activeRejection._tag).toBe("ProviderAdapterTurnStartError");
          expect(fake.controls).not.toContain("reset");
          fake.callback?.({
            kind: "complete",
            requestId,
            conversationId: "uncertain-native-conversation",
          });
          for (;;) {
            const event = yield* Queue.take(events);
            if (event.type === "turn.terminal") break;
          }
          fakes.failNextReset = true;
          const resetRejection = yield* Effect.exit(session.ensureThread(freshRequest));
          expect(resetRejection._tag).toBe("Failure");
          expect(fake.conversationId).toBe("uncertain-native-conversation");
          expect(fake.controls).not.toContain("reset");
          const replacement = yield* session.ensureThread(freshRequest);
          expect(replacement.id).toBe(oldThread.id);
          expect(replacement.nativeThreadRef).toBeNull();
          expect(fake.controls.filter((control) => control === "reset")).toHaveLength(1);
          const nextTurn = {
            ...turnInput,
            runId: RunId.make("next-run"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
            attemptId: RunAttemptId.make("next-attempt"),
            providerThread: replacement,
            message: {
              ...turnInput.message,
              messageId: MessageId.make("next-request"),
              text: "Continue with restored history",
            },
          };
          yield* session.startTurn(nextTurn);
          expect(fake.sent).toEqual([requestId, "next-request"]);
          fake.callback?.({
            kind: "complete",
            requestId,
            conversationId: "uncertain-native-conversation",
          });
          fake.callback?.({ kind: "complete", requestId: "next-request", conversationId: null });
          const terminalEvents = yield* Stream.fromQueue(events).pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal" && event.runOrdinal === 2),
            Stream.runCollect,
          );
          expect(
            terminalEvents
              .filter((event) => event.type === "turn.terminal")
              .map((event) => event.runOrdinal),
          ).toEqual([2]);
          const reused = yield* session.ensureThread(freshRequest);
          expect(reused.id).toBe(replacement.id);
          expect(fake.controls.filter((control) => control === "reset")).toHaveLength(1);
        }),
      ),
  );

  it.live("attaches the orchestration command and refreshes credentials before a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, attachMcp, refreshMcp, session } = yield* fixture;
        expect(attachMcp).toHaveBeenCalledWith(ThreadId.make("test-thread"), "/tmp/test-chatgpt");
        expect(fake.options.orchestrationCommand).toBe("test-orchestration-command");
        expect(session.contextHandoffDelivery).toBe("reference");
        expect(refreshMcp).toHaveBeenCalledOnce();
      }),
    ),
  );
  it.live("projects Terminal MCP commands into the native Codex command item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(
          terminalTool("tool_started", {
            operationId: "tool-one",
            toolName: "fedora_t3code.run_command",
            input: { command: "pwd" },
          }),
        );
        const startedEvents = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const started = startedEvents[0];
        if (started?.type !== "turn_item.updated" || started.turnItem.type !== "command_execution")
          throw new Error("Missing started tool item");
        expect(started.turnItem.status).toBe("running");
        expect(started.turnItem.input).toBe("pwd");

        fake.publish(
          terminalTool("tool_completed", {
            operationId: "tool-one",
            toolName: "fedora_t3code.run_command",
            status: "completed",
            output: [[{ type: "text", text: "ok" }], { type: "text", text: "ok" }],
          }),
        );
        const completedEvents = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const completed = completedEvents[0];
        if (
          completed?.type !== "turn_item.updated" ||
          completed.turnItem.type !== "command_execution"
        )
          throw new Error("Missing completed tool item");
        expect(completed.turnItem.id).toBe(started.turnItem.id);
        expect(completed.turnItem.ordinal).toBe(started.turnItem.ordinal);
        expect(completed.turnItem.status).toBe("completed");
        expect(completed.turnItem.input).toBe("pwd");
        expect(completed.turnItem.output).toBe("ok");
      }),
    ),
  );

  it.live("restores terminal tool identity for operation IDs without a tool- prefix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, turnInput } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(
          terminalTool("tool_started", {
            operationId: "tool-template",
            toolName: "fedora_t3code.run_command",
            input: { command: "pwd" },
          }),
        );
        const original = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const first = original[0];
        if (first?.type !== "turn_item.updated" || first.turnItem.type !== "command_execution")
          throw new Error("Missing initial command item");

        const operationId = "a1234567-89ab-4cde-8123-456789abcdef";
        const restored = {
          ...first.turnItem,
          id: TurnItemId.make(`chatgpt:test-thread:terminal-tool:${operationId}`),
          nativeItemRef: { ...first.turnItem.nativeItemRef!, nativeId: operationId },
          ordinal: 42,
        };
        const projection = yield* Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection)({
          thread: turnInput.appThread,
          runs: [],
          attempts: [],
          nodes: [],
          subagents: [],
          providerSessions: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          messages: [],
          plans: [],
          turnItems: [restored],
          checkpointScopes: [],
          checkpoints: [],
          contextHandoffs: [],
          contextTransfers: [],
          visibleTurnItems: [],
          updatedAt: turnInput.appThread.updatedAt,
        });
        yield* session.readThreadSnapshot({
          providerThread: turnInput.providerThread,
          existingProjection: projection,
        });
        fake.publish(
          terminalTool("tool_completed", {
            operationId,
            toolName: "fedora_t3code.run_command",
            status: "completed",
            output: { result: "ok" },
          }),
        );
        const updated = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === operationId,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const result = updated[0];
        if (result?.type !== "turn_item.updated" || result.turnItem.type !== "command_execution")
          throw new Error("Missing restored command item");
        expect(result.turnItem.id).toBe(restored.id);
        expect(result.turnItem.ordinal).toBe(42);
        expect(result.turnItem.input).toBe("pwd");
        expect(result.turnItem.output).toBe("ok");
        expect(result.turnItem.status).toBe("completed");
      }),
    ),
  );

  it.live("settles running Terminal MCP tool items when a turn is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, turnInput } = yield* fixture;
        const startedTurn = yield* Queue.take(events);
        if (startedTurn.type !== "provider_turn.updated")
          throw new Error("Expected the provider turn to start");
        fake.publish(
          terminalTool("tool_started", {
            operationId: "interrupt-tool",
            toolName: "fedora_t3code.run_command",
            input: { command: "sleep 60" },
          }),
        );
        const initial = yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const startedItem = initial[0];
        if (startedItem?.type !== "turn_item.updated") throw new Error("Missing running tool item");

        yield* session.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: startedTurn.providerTurn.id,
        });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const settled = recorded.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.id === startedItem.turnItem.id,
        );
        if (settled?.type !== "turn_item.updated") throw new Error("Missing settled tool item");
        expect(settled.turnItem.status).toBe("cancelled");
        expect(settled.turnItem.completedAt).not.toBeNull();
        expect(recorded.at(-1)?.type).toBe("turn.terminal");
      }),
    ),
  );

  it.live("bounds completion recovery when a tool completion event is lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(
          terminalTool("tool_started", {
            operationId: "missing-completion",
            toolName: "fedora_t3code.run_command",
            input: { command: "pwd" },
          }),
        );
        const initial = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "turn_item.updated"),
          Stream.take(1),
          Stream.runCollect,
        );
        const startedItem = initial[0];
        if (startedItem?.type !== "turn_item.updated") throw new Error("Missing running tool item");

        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        yield* TestClock.adjust("29 seconds");
        expect(yield* Queue.size(events)).toBe(0);
        yield* TestClock.adjust("1 second");
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const settled = recorded.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.id === startedItem.turnItem.id,
        );
        if (settled?.type !== "turn_item.updated") throw new Error("Missing settled tool item");
        expect(settled.turnItem.status).toBe("failed");
        expect(settled.turnItem.completedAt).not.toBeNull();
        const final = recorded.at(-1);
        expect(final?.type).toBe("turn.terminal");
        if (final?.type === "turn.terminal") expect(final.status).toBe("completed");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("projects file reads and edits through the same native Codex item types", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        yield* Queue.take(events);

        fake.publish(
          terminalTool("tool_started", {
            operationId: "read-one",
            toolName: "fedora_t3code.read_file",
            input: { path: "src/example.ts" },
          }),
        );
        const readEvents = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "turn_item.updated"),
          Stream.take(1),
          Stream.runCollect,
        );
        const read = readEvents[0];
        if (read?.type !== "turn_item.updated" || read.turnItem.type !== "dynamic_tool")
          throw new Error("Missing read tool item");
        expect(read.turnItem.toolName).toBe("Read");
        expect(read.turnItem.input).toEqual({ path: "src/example.ts" });

        fake.publish(
          terminalTool("tool_completed", {
            operationId: "read-one",
            toolName: "fedora_t3code.read_file",
            status: "completed",
            output: { result: "const value = 1;" },
          }),
        );
        yield* Stream.fromQueue(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.id === read.turnItem.id,
          ),
          Stream.take(1),
          Stream.runDrain,
        );

        fake.publish(
          terminalTool("tool_started", {
            operationId: "edit-one",
            toolName: "fedora_t3code.write_file",
            input: { path: "src/example.ts", content: "const value = 2;" },
          }),
        );
        const editEvents = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "turn_item.updated"),
          Stream.take(1),
          Stream.runCollect,
        );
        const edit = editEvents[0];
        if (edit?.type !== "turn_item.updated" || edit.turnItem.type !== "file_change")
          throw new Error("Missing edit tool item");
        expect(edit.turnItem.status).toBe("running");
        expect(edit.turnItem.fileName).toBe("src/example.ts");
        expect(edit.turnItem.changes).toEqual([{ operation: "update", path: "src/example.ts" }]);
      }),
    ),
  );

  it.live.each([false, true])(
    "completes a tool item when task done precedes stream completion: %s",
    (doneFirst) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { events, fake, requestId } = yield* fixture;
          yield* Queue.take(events);
          fake.publish(
            terminalTool("tool_started", {
              operationId: "complete-tool",
              toolName: "fedora_t3code.thread_task",
              input: { action: "complete" },
            }),
          );
          const startedEvents = yield* Stream.fromQueue(events).pipe(
            Stream.filter(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
            ),
            Stream.take(1),
            Stream.runCollect,
          );
          const started = startedEvents[0];
          if (started?.type !== "turn_item.updated" || started.turnItem.type !== "dynamic_tool")
            throw new Error("Missing started completion tool item");

          const acknowledged = Promise.withResolvers<void>();
          fake.onDoneAcknowledged = () => acknowledged.resolve();
          if (doneFirst) {
            fake.publish(terminal("state", "done"));
            yield* Effect.promise(() => acknowledged.promise);
          }
          fake.callback?.({ kind: "complete", requestId, conversationId: null });
          if (!doneFirst) {
            fake.publish(terminal("state", "done"));
            yield* Effect.promise(() => acknowledged.promise);
          }

          fake.publish(
            terminalTool("tool_completed", {
              operationId: "complete-tool",
              toolName: "fedora_t3code.thread_task",
              status: "completed",
              output: { state: "done" },
            }),
          );
          const completedSequence = yield* Stream.fromQueue(events).pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          const completed = completedSequence.find(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
          );
          if (completed?.type !== "turn_item.updated" || completed.turnItem.type !== "dynamic_tool")
            throw new Error("Missing completed completion tool item");
          expect(completed.turnItem.id).toBe(started.turnItem.id);
          expect(completed.turnItem.status).toBe("completed");
          expect(completed.turnItem.output).toEqual({ state: "done" });
          expect(completedSequence.at(-1)?.type).toBe("turn.terminal");
        }),
      ),
  );

  it.live("reports an empty aliased tool ending as a retryable failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId, turnInput } = yield* fixture;
        yield* Queue.take(events);
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          recipient: "api_tool.call_tool",
          text: JSON.stringify({
            path: "/asdk_app_test/link_test/bootstrap_thread",
            args: { thread_id: turnInput.threadId },
          }),
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "tool",
          recipient: "assistant",
          text: "",
          endTurn: true,
          status: "finished_successfully",
        });
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)).toMatchObject({
          type: "turn.terminal",
          status: "failed",
          failure: { code: "chatgpt_empty_tool_completion", retryable: true },
        });
        expect(fake.controls).not.toContain("pause");
      }),
    ),
  );

  it.live("does not fail an empty tool ending after Terminal MCP reports done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId, turnInput } = yield* fixture;
        yield* Queue.take(events);
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          recipient: "api_tool.call_tool",
          text: JSON.stringify({
            path: "/asdk_app_test/link_test/bootstrap_thread",
            args: { thread_id: turnInput.threadId },
          }),
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "tool",
          recipient: "assistant",
          text: "",
          endTurn: true,
          status: "finished_successfully",
        });
        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)).toMatchObject({
          type: "turn.terminal",
          status: "completed",
          failure: null,
        });
      }),
    ),
  );

  it.live("keeps aliased tool turns active until Terminal MCP confirms completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId, turnInput } = yield* fixture;
        yield* Queue.take(events);
        const updatesHandled = Promise.withResolvers<void>();
        fake.onControl = (action) => {
          if (action === "bind") updatesHandled.resolve();
        };
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          recipient: "api_tool.call_tool",
          text: JSON.stringify({
            path: "/asdk_app_test/link_test/run_command",
            args: { session_id: turnInput.threadId, command: "pwd" },
          }),
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "tool",
          text: "",
          endTurn: true,
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "answer",
          text: "Work complete.",
        });
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        // Binding this later update is a barrier after the completion callback.
        fake.callback?.({ kind: "update", requestId, conversationId: "native-conversation" });
        yield* Effect.promise(() => updatesHandled.promise);
        const beforeDone = yield* Queue.takeAll(events);
        expect(beforeDone.some((event) => event.type === "turn.terminal")).toBe(false);
        expect(fake.controls).not.toContain("pause");
        fake.publish(terminal("state", "done"));
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      }),
    ),
  );

  it.live("finishes a reply-only stream with no Terminal MCP done event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "answer",
          text: "Y",
          status: "in_progress",
        });
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const finalMessages = recorded.filter((event) => event.type === "message.updated");
        expect(finalMessages.at(-1)?.message.text).toBe("Y");
        expect(finalMessages.at(-1)?.message.streaming).toBe(false);
        expect(recorded.at(-1)?.type).toBe("turn.terminal");
        expect(fake.controls).toEqual(["register", "activate", "pause"]);
      }),
    ),
  );

  it.live("routes commentary through reasoning before showing one canonical final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "analysis",
          messageId: "thinking",
          text: "Checking the request",
          status: "in_progress",
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "commentary",
          recipient: "all",
          messageId: "progress",
          text: "Still checking",
          status: "finished_successfully",
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "final-draft",
          text: "The result is Y.",
          status: "in_progress",
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "final-canonical",
          text: "The result is Y.",
          status: "finished_successfully",
          hidden: true,
        });
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const items = recorded.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        const reasoning = items.filter((item) => item.type === "reasoning");
        expect(reasoning.map((item) => item.text)).toContain("Still checking");
        expect(reasoning.findLast((item) => item.text === "Checking the request")?.streaming).toBe(
          false,
        );
        const finalMessages = recorded.filter((event) => event.type === "message.updated");
        expect(finalMessages.some((event) => event.message.text === "Still checking")).toBe(false);
        expect(new Set(finalMessages.map((event) => event.message.id)).size).toBe(1);
        expect(finalMessages.at(-1)?.message.text).toBe("The result is Y.");
        expect(items.at(-1)?.type).toBe("assistant_message");
      }),
    ),
  );

  it.live("settles reasoning from an earlier submission when a continued run completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "analysis",
          messageId: "old-reasoning",
          text: "Reasoning before continue",
          status: "in_progress",
        });
        fake.publish(terminal("continue"));
        yield* Effect.sleep("20 millis");
        expect(fake.sent).toContain("continue-1");
        fake.callback?.({
          kind: "update",
          requestId: "continue-1",
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "continued-final",
          text: "Continued work finished",
          status: "finished_successfully",
        });
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId: "continue-1", conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const reasoning = recorded.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "reasoning" &&
          event.turnItem.text === "Reasoning before continue"
            ? [event.turnItem]
            : [],
        );
        expect(reasoning.at(-1)?.status).toBe("completed");
        expect(reasoning.at(-1)?.streaming).toBe(false);
      }),
    ),
  );

  it.live("does not pause an uncertain submission failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        fakes.failNextSend = true;
        const result = yield* Effect.result(fixture);
        expect(result._tag).toBe("Failure");
        expect(fakes.connections.at(-1)?.controls).toEqual(["register", "activate"]);
      }),
    ),
  );

  it.live("pauses recovery after a proven pre-submission failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        fakes.rejectNextSendBeforeSubmission = true;
        const result = yield* Effect.result(fixture);
        expect(result._tag).toBe("Failure");
        expect(fakes.connections.at(-1)?.controls).toEqual(["register", "activate", "pause"]);
      }),
    ),
  );

  it.live("does not pause the binding when interrupt cancellation fails completely", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, turnInput } = yield* fixture;
        const started = yield* Queue.take(events);
        if (started.type !== "provider_turn.updated")
          throw new Error("Expected the provider turn to start");
        fakes.failNextStop = true;

        const result = yield* Effect.result(
          session.interruptTurn({
            providerThread: turnInput.providerThread,
            providerTurnId: started.providerTurn.id,
          }),
        );

        expect(result._tag).toBe("Failure");
        expect(fake.stops).toBe(1);
        expect(fake.controls).toEqual(["register", "activate"]);
      }),
    ),
  );

  it.live("finishes the interrupted turn when pause fails after a successful stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, turnInput } = yield* fixture;
        const started = yield* Queue.take(events);
        if (started.type !== "provider_turn.updated")
          throw new Error("Expected the provider turn to start");
        fakes.failNextPause = true;

        const result = yield* Effect.result(
          session.interruptTurn({
            providerThread: turnInput.providerThread,
            providerTurnId: started.providerTurn.id,
          }),
        );
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminalEvent = recorded.at(-1);

        expect(result._tag).toBe("Success");
        expect(fake.stops).toBe(1);
        expect(fake.controls).toEqual(["register", "activate", "pause"]);
        expect(terminalEvent?.type).toBe("turn.terminal");
        if (terminalEvent?.type !== "turn.terminal")
          throw new Error("Expected interrupted terminal event");
        expect(terminalEvent.status).toBe("interrupted");
      }),
    ),
  );

  it.live("does not submit a continuation that was claimed while an interrupt completed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, turnInput, requestId } = yield* fixture;
        const started = yield* Queue.take(events);
        if (started.type !== "provider_turn.updated")
          throw new Error("Expected the provider turn to start");

        const claimStarted = Promise.withResolvers<void>();
        const claimGate = Promise.withResolvers<void>();
        fake.onClaim = () => claimStarted.resolve();
        fake.claimGate = claimGate.promise;
        fake.publish(terminal("continue"));
        yield* Effect.promise(() => claimStarted.promise);

        yield* session.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: started.providerTurn.id,
        });
        claimGate.resolve();
        yield* Effect.sleep("20 millis");

        expect(fake.sent).toEqual([requestId]);
        expect(fake.stops).toBe(1);
      }),
    ),
  );

  it.live("ignores late stream updates after an interrupted turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, turnInput, requestId } = yield* fixture;
        const started = yield* Queue.take(events);
        if (started.type !== "provider_turn.updated")
          throw new Error("Expected the provider turn to start");

        yield* session.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: started.providerTurn.id,
        });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );

        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "late-after-interrupt",
          text: "This should be ignored.",
          status: "in_progress",
        });
        yield* Effect.sleep("20 millis");

        expect(yield* Queue.size(events)).toBe(0);
      }),
    ),
  );

  it.live("ignores late ChatGPT updates after an interrupted terminal turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, requestId, turnInput } = yield* fixture;
        const started = yield* Queue.take(events);
        if (started.type !== "provider_turn.updated")
          throw new Error("Expected the provider turn to start");

        yield* session.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: started.providerTurn.id,
        });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        expect(yield* Queue.size(events)).toBe(0);

        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "late-final",
          text: "This must not appear after interruption.",
          status: "finished_successfully",
        });
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        yield* Effect.sleep("10 millis");

        expect(yield* Queue.size(events)).toBe(0);
      }),
    ),
  );

  it.live("replaces revisions of the same visible final message and ignores hidden copies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const base = {
          kind: "update" as const,
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "progressive-final",
          status: "in_progress",
        };
        fake.callback?.({ ...base, text: "The cause is a race." });
        fake.callback?.({ ...base, text: "The cause is a scheduling race." });
        fake.callback?.({
          ...base,
          messageId: "second-part",
          text: "## Resolution\nApplied.",
          status: "finished_successfully",
          hidden: true,
        });
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const messages = recorded.filter((event) => event.type === "message.updated");
        expect(messages.at(-1)?.message.text).toBe("The cause is a scheduling race.");
        expect(messages.at(-1)?.message.text.includes("The cause is a race.")).toBe(false);
      }),
    ),
  );

  it.live("ignores hidden final-answer copies as well as hidden tool and reasoning output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const base = {
          kind: "update" as const,
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          recipient: "all",
        };
        fake.callback?.({
          ...base,
          messageId: "draft-one",
          text: "Intro\n\n## Findings\nEvidence.",
          status: "in_progress",
        });
        fake.callback?.({
          ...base,
          messageId: "canonical-one",
          text: "Intro\n\n## Findings\nEvidence.",
          status: "finished_successfully",
          hidden: true,
        });
        fake.callback?.({
          ...base,
          messageId: "final-second-section",
          text: "## Download\nThe verified AppImage.",
          status: "finished_successfully",
          hidden: true,
        });
        fake.callback?.({
          ...base,
          channel: "analysis",
          messageId: "private-reasoning",
          text: "Hidden analysis must never appear",
          hidden: true,
        });
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const messages = recorded.filter((event) => event.type === "message.updated");
        expect(new Set(messages.map((event) => event.message.id)).size).toBe(1);
        expect(messages.at(-1)?.message.text).toBe("Intro\n\n## Findings\nEvidence.");
        expect(messages.at(-1)?.message.streaming).toBe(false);
        expect(
          recorded.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "reasoning" &&
              event.turnItem.text.includes("Hidden analysis"),
          ),
        ).toBe(false);
      }),
    ),
  );

  it.live(
    "keeps the whole canonical answer once when GenUI replaces its draft and emits a hidden ending",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { events, fake, requestId } = yield* fixture;
          yield* Queue.take(events);
          const base = {
            kind: "update" as const,
            requestId,
            conversationId: null,
            role: "assistant",
            channel: "final",
            recipient: "all",
          };
          fake.callback?.({
            ...base,
            messageId: "draft",
            text: "First paragraph",
            status: "in_progress",
          });
          const full =
            "First paragraph\n\n## Findings\nAll the evidence.\n\n## Conclusion\nComplete.";
          fake.callback?.({
            ...base,
            messageId: "canonical",
            text: full,
            status: "finished_successfully",
          });
          fake.callback?.({
            ...base,
            messageId: "hidden-ending",
            text: "## Conclusion\nComplete.",
            status: "finished_successfully",
            hidden: true,
          });
          fake.publish(terminal("state", "done"));
          fake.callback?.({ kind: "complete", requestId, conversationId: null });
          const recorded = yield* Stream.fromQueue(events).pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          const messages = recorded.filter((event) => event.type === "message.updated");
          expect(new Set(messages.map((event) => event.message.id)).size).toBe(1);
          expect(messages.at(-1)?.message.text).toBe(full);
          expect(
            recorded.filter((event) => event.type === "turn_item.updated").at(-1)?.turnItem.status,
          ).toBe("completed");
        }),
      ),
  );
  it.live("finishes an incomplete final message only after both stream and task are done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "streaming-final",
          text: "Incomplete final text",
          status: "in_progress",
        });
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const messages = recorded.filter((event) => event.type === "message.updated");
        expect(messages.at(-1)?.message.text).toBe("Incomplete final text");
        expect(messages.at(-1)?.message.streaming).toBe(false);
        const items = recorded.filter(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        );
        const lastItem = items.at(-1);
        if (
          lastItem?.type !== "turn_item.updated" ||
          lastItem.turnItem.type !== "assistant_message"
        )
          throw new Error("Missing final assistant turn item");
        expect(lastItem.turnItem.status).toBe("completed");
        expect(lastItem.turnItem.streaming).toBe(false);
      }),
    ),
  );

  it.live("does not cut off an unfinished stream five seconds after task completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(terminal("state", "done"));
        yield* Effect.sleep("5.2 seconds");
        expect(yield* Queue.size(events)).toBe(0);
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const terminalEvents = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(terminalEvents[0]?.status).toBe("completed");
      }),
    ),
  );

  it.effect("recovers an idle ChatGPT completion at three minutes after done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          recipient: "api_tool.call_tool",
          text: "fedora_t3code.thread_task",
        });
        fake.idle = true;
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        yield* TestClock.adjust("179 seconds");
        expect(fake.idleChecks).toBe(0);
        yield* TestClock.adjust("1 second");
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)?.type).toBe("turn.terminal");
        const terminalEvent = recorded.at(-1);
        if (terminalEvent?.type !== "turn.terminal") throw new Error("Missing completion");
        expect(terminalEvent.status).toBe("completed");
        expect(fake.idleChecks).toBe(1);
        expect(fake.sent).toEqual([requestId]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forces an unconfirmed ChatGPT completion closed at three minutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.onStop = () => fake.callback?.({ kind: "complete", requestId, conversationId: null });
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        yield* TestClock.adjust("179 seconds");
        expect(fake.idleChecks).toBe(0);
        expect(fake.stops).toBe(0);
        yield* TestClock.adjust("1 second");
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const forced = recorded.at(-1);
        expect(forced?.type).toBe("turn.terminal");
        if (forced?.type !== "turn.terminal") throw new Error("Missing forced terminal event");
        expect(forced.status).toBe("forced");
        expect(forced.failure).toBeNull();
        expect(fake.idleChecks).toBe(1);
        expect(fake.stops).toBe(1);
        expect(fake.sent).toEqual([requestId]);
        yield* TestClock.adjust("5 minutes");
        expect(fake.idleChecks).toBe(1);
        expect(fake.stops).toBe(1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forces an unconfirmed completion even when the native stop never returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        yield* Queue.take(events);
        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.onStop = () => new Promise<void>(() => {});
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        yield* TestClock.adjust("3 minutes");
        yield* TestClock.adjust("10 seconds");
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)).toMatchObject({ type: "turn.terminal", status: "forced" });
        expect(fake.stops).toBe(1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not force-close a replacement generation while an old stop is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        yield* Queue.take(events);
        const doneAcknowledged = Promise.withResolvers<void>();
        const continuationSent = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => doneAcknowledged.resolve();
        fake.onSend = (id) => {
          if (id === "new-generation") continuationSent.resolve();
        };
        fake.onStop = () => {
          if (fake.stops !== 1) return;
          fake.publish({
            ...terminal("continue"),
            event_id: "new-generation",
            payload: { prompt: "continue" },
          });
          return continuationSent.promise;
        };
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => doneAcknowledged.promise);
        yield* TestClock.adjust("3 minutes");
        yield* Effect.promise(() => continuationSent.promise);
        // The original recovery can now exit, but may not close the replacement.
        yield* Effect.yieldNow;
        expect(fake.sent).toContain("new-generation");
        expect(fake.stops).toBe(2);
        expect(yield* Queue.size(events)).toBe(0);
        fake.callback?.({ kind: "complete", requestId: "new-generation", conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminalEvent = recorded.at(-1);
        expect(terminalEvent?.type).toBe("turn.terminal");
        if (terminalEvent?.type !== "turn.terminal") throw new Error("Missing completion");
        expect(terminalEvent.status).toBe("completed");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still forces the turn when native stop fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake } = yield* fixture;
        yield* Queue.take(events);
        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fakes.failNextStop = true;
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        yield* TestClock.adjust("3 minutes");
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const forced = recorded.at(-1);
        expect(forced?.type).toBe("turn.terminal");
        if (forced?.type !== "turn.terminal") throw new Error("Missing forced terminal event");
        expect(forced.status).toBe("forced");
        expect(fake.stops).toBe(1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels delayed refresh when the real stream finishes first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const acknowledged = Promise.withResolvers<void>();
        fake.onDoneAcknowledged = () => acknowledged.resolve();
        fake.publish(terminal("state", "done"));
        yield* Effect.promise(() => acknowledged.promise);
        yield* TestClock.adjust("2 minutes");
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(recorded.at(-1)?.type).toBe("turn.terminal");
        const terminalEvent = recorded.at(-1);
        if (terminalEvent?.type !== "turn.terminal") throw new Error("Missing completion");
        expect(terminalEvent.status).toBe("completed");
        yield* TestClock.adjust("10 minutes");
        expect(fake.idleChecks).toBe(0);
        expect(yield* Queue.size(events)).toBe(0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forces restart reconciliation after the immediate and three-minute reads miss", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, requestId, turnInput } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );

        let reads = 0;
        const firstRead = Promise.withResolvers<void>();
        fake.onCompletionRead = () => {
          reads += 1;
          if (reads === 1) firstRead.resolve();
        };
        fake.idle = false;
        yield* session.startTurn({
          ...turnInput,
          runId: RunId.make("restart-forced-run"),
          runOrdinal: 2,
          attemptId: RunAttemptId.make("restart-forced-attempt"),
          message: {
            ...turnInput.message,
            messageId: MessageId.make("message:restart-continuation:forced"),
            createdBy: "agent",
            creationSource: "server",
          },
        });

        yield* Effect.promise(() => firstRead.promise);
        expect(fake.idleChecks).toBe(1);
        expect(fake.stops).toBe(0);
        yield* TestClock.adjust("179 seconds");
        expect(fake.idleChecks).toBe(1);
        expect(fake.stops).toBe(0);
        yield* TestClock.adjust("1 second");

        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const forced = recorded.at(-1);
        expect(forced?.type).toBe("turn.terminal");
        if (forced?.type !== "turn.terminal") throw new Error("Missing forced terminal event");
        expect(forced.status).toBe("forced");
        expect(fake.idleChecks).toBe(2);
        expect(fake.stops).toBe(1);
        expect(fake.sent).toEqual([requestId]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("reconciles a done task on restart without activating or submitting it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, session, requestId, turnInput } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId, conversationId: null });
        yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        fake.idle = true;
        yield* session.startTurn({
          ...turnInput,
          runId: RunId.make("restart-run"),
          runOrdinal: 2,
          attemptId: RunAttemptId.make("restart-attempt"),
          message: {
            ...turnInput.message,
            messageId: MessageId.make("message:restart-continuation:run"),
            createdBy: "agent",
            creationSource: "server",
          },
        });
        const recorded = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(fake.sent).toEqual([requestId]);
        expect(fake.controls.filter((action) => action === "activate")).toHaveLength(1);
        expect(
          recorded.filter((event) => event.type === "message.updated").at(-1)?.message.runId,
        ).toBe("restart-run");
      }),
    ),
  );

  it.live(
    "manual refresh imports one snapshot and completes a done task without another prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { events, fake, session, turnInput } = yield* fixture;
          yield* Queue.take(events);
          fake.state = "done";
          fake.idle = true;
          const projection = yield* Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection)({
            thread: turnInput.appThread,
            runs: [],
            attempts: [],
            nodes: [],
            subagents: [],
            providerSessions: [],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
            messages: [],
            plans: [],
            turnItems: [],
            checkpointScopes: [],
            checkpoints: [],
            contextHandoffs: [],
            contextTransfers: [],
            visibleTurnItems: [],
            updatedAt: turnInput.appThread.updatedAt,
          });
          const snapshot = yield* session.readThreadSnapshot({
            providerThread: turnInput.providerThread,
            existingProjection: projection,
          });
          expect(snapshot.messages.at(-1)?.text).toBe("Recovered final answer");
          const recorded = yield* Stream.fromQueue(events).pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          expect(recorded.at(-1)?.type).toBe("turn.terminal");
          const again = yield* session.readThreadSnapshot({
            providerThread: turnInput.providerThread,
            existingProjection: projection,
          });
          expect(again.messages).toHaveLength(1);
          expect(again.messages[0]?.id).toBe(snapshot.messages[0]?.id);
          expect(fake.sent).toHaveLength(1);
          expect(fake.conversationReads).toBe(2);
        }),
      ),
  );

  it.live(
    "keeps tool-using runs active after stream completion until Terminal MCP marks done",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { events, fake, requestId } = yield* fixture;
          yield* Queue.take(events);
          fake.callback?.({
            kind: "update",
            requestId,
            conversationId: null,
            role: "assistant",
            recipient: "api_tool.call_tool",
            text: "fedora_t3code.run_command",
          });
          fake.callback?.({ kind: "complete", requestId, conversationId: null });
          fake.publish(terminal("continue"));
          yield* Effect.sleep("15 millis");
          expect(fake.sent).toEqual([requestId, "continue-1"]);
          expect(fake.stops).toBe(0);
          fake.publish(terminal("state", "done"));
          fake.callback?.({ kind: "complete", requestId: "continue-1", conversationId: null });
          const ended = yield* Stream.fromQueue(events).pipe(
            Stream.filter((e) => e.type === "turn.terminal"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(ended[0]?.status).toBe("completed");
        }),
      ),
  );
  it.live("ignores old task completion and stops an unfinished generation before recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        fake.publish(terminal("state", "done", 0));
        fake.publish(terminal("continue"));
        yield* Effect.sleep("15 millis");
        expect(fake.stops).toBe(1);
        expect(fake.sent).toEqual([requestId, "continue-1"]);
        fake.publish(terminal("state", "done"));
        fake.callback?.({ kind: "complete", requestId: "continue-1", conversationId: null });
        const ended = yield* Stream.fromQueue(events).pipe(
          Stream.filter((e) => e.type === "turn.terminal"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(ended[0]?.status).toBe("completed");
      }),
    ),
  );
});
