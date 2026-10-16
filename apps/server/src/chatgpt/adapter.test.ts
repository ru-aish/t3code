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
  connections: [] as Array<{
    callback?: (update: ChatGPTUpdate) => void;
    publish: (event: TerminalEvent) => void;
    sent: string[];
    stops: number;
  }>,
}));
vi.mock("./connection.ts", () => ({
  ChatGPTConnection: class {
    conversationId = null;
    messages = [];
    callback?: (update: ChatGPTUpdate) => void;
    sent: string[] = [];
    stops = 0;
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
  it.live("keeps the run active after stream completion until Terminal MCP marks done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, fake, requestId } = yield* fixture;
        yield* Queue.take(events);
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
