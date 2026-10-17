import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ChatGPTSettings,
  ThreadId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  OrchestrationV2AppThread,
} from "@t3tools/contracts";
import type { ChatGPTUpdate, TerminalEvent } from "./connection.ts";

const fakes = vi.hoisted(() => ({
  failNextSend: false,
  connections: [] as Array<{
    callback?: (update: ChatGPTUpdate) => void;
    publish: (event: TerminalEvent) => void;
    sent: string[];
    stops: number;
    controls: string[];
  }>,
}));
vi.mock("./connection.ts", () => ({
  ChatGPTConnection: class {
    conversationId = null;
    messages = [];
    callback?: (update: ChatGPTUpdate) => void;
    sent: string[] = [];
    stops = 0;
    controls: string[] = [];
    epoch = 0;
    pending: Array<TerminalEvent> = [];
    wake?: () => void;
    constructor() {
      fakes.connections.push(this);
    }
    async load() {}
    close() {}
    async adoptConversation() {}
    onUpdate(callback: (update: ChatGPTUpdate) => void) {
      this.callback = callback;
    }
    async control(action: string) {
      this.controls.push(action);
      if (action === "activate") this.epoch++;
      if (action === "claim") return { valid: true };
      return {
        thread_id: "test-thread",
        terminal_id: "test-thread",
        conversation_id: null,
        epoch: this.epoch,
        state: "working",
        paused: 0,
        cwd: "/tmp",
        model: "test-model",
      };
    }
    async send(id: string) {
      this.sent.push(id);
      if (fakes.failNextSend) {
        fakes.failNextSend = false;
        throw new Error("Image upload failed");
      }
    }
    async stop() {
      this.stops++;
    }
    async acknowledge() {}
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

const fixture = Effect.gen(function* () {
  const threadId = ThreadId.make("test-thread");
  const now = yield* DateTime.now;
  const selection = { instanceId: ProviderInstanceId.make("chatgpt"), model: "test-model" };
  const policy = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: "/tmp",
  };
  const adapter = makeChatGPTAdapter(
    {
      instanceId: selection.instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: yield* Schema.decodeEffect(ChatGPTSettings)({}),
    },
    { token: "test-token", environmentId: "test-environment", cacheDir: "/tmp/test-chatgpt" },
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
    session,
    events,
    fake: fakes.connections.at(-1)!,
    requestId: turnInput.message.messageId,
  };
});

const terminal = (kind: string, state?: string, epoch = 1): TerminalEvent => ({
  seq: 1,
  event_id: `${kind}-${epoch}`,
  thread_id: "test-thread",
  epoch,
  kind,
  payload: state ? { state } : {},
});

describe("ChatGPT task authority", () => {
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

  it.live("settles reasoning before showing one canonical final answer", () =>
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
        expect(reasoning.map((item) => item.status)).toEqual(["running", "completed"]);
        expect(reasoning.at(-1)?.streaming).toBe(false);
        const finalMessages = recorded.filter((event) => event.type === "message.updated");
        expect(new Set(finalMessages.map((event) => event.message.id)).size).toBe(1);
        expect(finalMessages.at(-1)?.message.text).toBe("The result is Y.");
        expect(items.at(-1)?.type).toBe("assistant_message");
      }),
    ),
  );

  it.live("pauses recovery when a submission fails before the generation starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        fakes.failNextSend = true;
        const result = yield* Effect.result(fixture);
        expect(result._tag).toBe("Failure");
        expect(fakes.connections.at(-1)?.controls).toEqual(["register", "activate", "pause"]);
      }),
    ),
  );

  it.live("replaces revisions of the same final message instead of duplicating them", () =>
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
        expect(messages.at(-1)?.message.text).toBe(
          "The cause is a scheduling race.\n\n## Resolution\nApplied.",
        );
        expect(messages.at(-1)?.message.text.includes("The cause is a race.")).toBe(false);
      }),
    ),
  );

  it.live("deduplicates escaped and canonical copies of the same streamed final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
        const escaped =
          "## Result\n\nAt **11:58:03 AM**, the task was done\\.\n\nAt **11:58:36 AM\\:** it resumed.";
        const canonical =
          "## Result\n\nAt **11:58:03 AM**, the task was done.\n\nAt **11:58:36 AM:** it resumed.";
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "visible-final",
          text: escaped,
          status: "in_progress",
        });
        fake.callback?.({
          kind: "update",
          requestId,
          conversationId: null,
          role: "assistant",
          channel: "final",
          messageId: "canonical-final",
          text: canonical,
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
        expect(messages.at(-1)?.message.text).toBe(canonical);
        expect(messages.at(-1)?.message.text).not.toContain(escaped + "\n\n");
      }),
    ),
  );

  it.live(
    "renders previously hidden final-answer sections but not hidden tool or reasoning output",
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
          expect(messages.at(-1)?.message.text).toBe(
            "Intro\n\n## Findings\nEvidence.\n\n## Download\nThe verified AppImage.",
          );
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
