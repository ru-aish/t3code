import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ChatGPTDesktopBridge,
  ChatGPTDesktopBridgeError,
  ChatGPTDesktopBridgeLive,
  ChatGPTDesktopBridgeTest,
  type RendererTurn,
} from "./ChatGPTDesktopBridge.ts";

const conversationId = "123e4567-e89b-42d3-a456-426614174000";

type Listener = (event: Event | MessageEvent) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sentMethods: string[] = [];
  onSend: (message: string) => void = () => {};

  constructor(_url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: Listener) {
    this.listeners.get(name)?.delete(listener);
  }

  close() {}

  send(message: string) {
    this.sentMethods.push((JSON.parse(message) as { method: string }).method);
    this.onSend(message);
  }

  emit(name: string, data?: string) {
    const event = data === undefined ? new Event(name) : ({ data } as MessageEvent);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const desktopTarget = {
  type: "page",
  url: "http://127.0.0.1:5175/?mcpAppSandboxDevtools=1",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/example",
};

async function withDesktop(onSocket: (socket: FakeSocket) => void, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  FakeSocket.instances = [];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([desktopTarget]))) as unknown as typeof fetch;
  (globalThis as { WebSocket: unknown }).WebSocket = class extends FakeSocket {
    constructor(url: string) {
      super(url);
      onSocket(this);
    }
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  }
}

async function assertRejected(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
    assert.equal(true, false, "Expected promise to reject");
  } catch (error) {
    assert.match(String(error), pattern);
  }
}

describe("ChatGPTDesktopBridge", () => {
  it("rejects non-loopback HTTP and WebSocket endpoints and discovers only the local renderer", async () => {
    assert.throws(() => ChatGPTDesktopBridgeTest.validateEndpoint("https://127.0.0.1:9222"));
    assert.throws(() => ChatGPTDesktopBridgeTest.validateEndpoint("http://192.168.1.2:9222"));
    assert.throws(() =>
      ChatGPTDesktopBridgeTest.validateWebSocketEndpoint("ws://example.com/devtools"),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([desktopTarget]))) as unknown as typeof fetch;
    try {
      const target = await ChatGPTDesktopBridgeTest.discoverTarget("http://127.0.0.1:9222");
      assert.equal(target.webSocketDebuggerUrl, desktopTarget.webSocketDebuggerUrl);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers the authenticated main renderer and rejects standalone quick-chat windows", () => {
    const target = ChatGPTDesktopBridgeTest.selectDesktopTarget([
      {
        type: "page",
        url: "http://127.0.0.1:5175/?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
        webSocketDebuggerUrl: "ws://127.0.0.1:9337/prewarm",
      },
      {
        type: "page",
        url: "http://127.0.0.1:5175/?initialRoute=%2Fchatgpt%2Fquick-chat%2Flocal-chatgpt%253Aexample",
        webSocketDebuggerUrl: "ws://127.0.0.1:9337/quick-chat-window",
      },
      {
        type: "page",
        url: "http://127.0.0.1:5175/?mcpAppSandboxDevtools=1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9337/main",
      },
      {
        type: "page",
        url: "https://chatgpt.com/",
        webSocketDebuggerUrl: "ws://127.0.0.1:9337/external",
      },
    ]);
    assert.equal(target?.webSocketDebuggerUrl, "ws://127.0.0.1:9337/main");
  });

  it("keeps stable role-unit keys and excludes user units from assistant streaming", () => {
    const turns: ReadonlyArray<RendererTurn> = ChatGPTDesktopBridgeTest.parseRoleUnits([
      { key: "turn-1:user", text: "prompt" },
      { key: "turn-1:assistant", text: "answer" },
      { key: "turn-1:tool", text: "ignored" },
    ]);
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ["turn-1:user", "turn-1:assistant"],
    );
    assert.deepEqual(ChatGPTDesktopBridgeTest.assistantTurns(turns), [turns[1]!]);
  });

  it("retries renderer probing after a navigation replaces the execution context", async () => {
    let attempts = 0;
    await ChatGPTDesktopBridgeTest.waitForRenderer(async () => {
      attempts += 1;
      if (attempts === 1)
        throw new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail: "Execution context was destroyed during navigation.",
        });
      return { composer: true, empty: true };
    }, true);
    assert.equal(attempts, 2);
  });

  it("discovers the newest backend conversation by exact user-message text, never local ids", () => {
    const id = ChatGPTDesktopBridgeTest.discoverStableConversationId(
      [
        {
          key: ["chatgpt-conversation", conversationId],
          updatedAt: 1,
          data: {
            current_node: "a",
            mapping: {
              a: { message: { author: { role: "user" }, content: { parts: ["prompt"] } } },
            },
          },
        },
        {
          key: ["chatgpt-conversation", "223e4567-e89b-42d3-a456-426614174000"],
          updatedAt: 2,
          data: {
            current_node: "a",
            mapping: {
              a: { message: { author: { role: "user" }, content: { parts: ["other"] } } },
            },
          },
        },
      ],
      "prompt",
    );
    assert.equal(id, conversationId);
  });

  it("verifies an opened history entry against query data and visible quick-chat units", () => {
    const query = {
      key: ["chatgpt-conversation", conversationId],
      data: {
        current_node: "b",
        mapping: {
          a: {
            parent: null,
            message: { author: { role: "user" }, content: { parts: ["prompt"] } },
          },
          b: {
            parent: "a",
            message: { author: { role: "assistant" }, content: { parts: ["answer"] } },
          },
        },
      },
    };
    assert.isTrue(
      ChatGPTDesktopBridgeTest.verifyOpenedConversation([query], conversationId, [
        { id: "a:user", role: "user", text: "prompt" },
        { id: "b:assistant", role: "assistant", text: "answer" },
      ]),
    );
    assert.isFalse(
      ChatGPTDesktopBridgeTest.verifyOpenedConversation([query], conversationId, [
        { id: "a:user", role: "user", text: "wrong chat" },
      ]),
    );
  });

  it("finds a saved conversation in every infinite-history page", () => {
    assert.deepEqual(
      ChatGPTDesktopBridgeTest.findConversationHistoryEntry(
        [
          {
            key: ["chatgpt-conversations"],
            data: {
              pages: [
                { items: [{ id: "other", title: "Other" }] },
                { items: [{ id: conversationId, title: "Saved chat" }] },
              ],
            },
          },
        ],
        conversationId,
      ),
      { id: conversationId, title: "Saved chat" },
    );
  });

  it("follows the current-node chain so branches and mapping order cannot verify the wrong chat", () => {
    const query = {
      key: ["chatgpt-conversation", conversationId],
      data: {
        current_node: "assistant",
        mapping: {
          stale: {
            parent: "root",
            message: { author: { role: "assistant" }, content: { parts: ["stale"] } },
          },
          assistant: {
            parent: "user",
            message: { author: { role: "assistant" }, content: { parts: ["answer"] } },
          },
          root: {
            parent: null,
            message: { author: { role: "user" }, content: { parts: ["wrong branch"] } },
          },
          user: {
            parent: null,
            message: { author: { role: "user" }, content: { parts: ["prompt"] } },
          },
        },
      },
    };
    assert.deepEqual(ChatGPTDesktopBridgeTest.conversationMessages(query.data), [
      { role: "user", text: "prompt" },
      { role: "assistant", text: "answer" },
    ]);
    assert.isFalse(
      ChatGPTDesktopBridgeTest.verifyOpenedConversation([query], conversationId, [
        { id: "user:user", role: "user", text: "wrong branch" },
        { id: "assistant:assistant", role: "assistant", text: "stale" },
      ]),
    );
  });

  it("keeps mutation distinct from the later Send-enabled polling phase", () => {
    const expression = ChatGPTDesktopBridgeTest.mutateEditor("prompt");
    assert.match(expression, /InputEvent/);
    assert.notMatch(expression, /aria-label=\\?"Send/);
  });

  it("injects image bytes through the renderer's real file input and waits for acknowledgement", () => {
    const expression = ChatGPTDesktopBridgeTest.expressions.injectImages([
      { name: "diagram.png", mimeType: "image/png", base64: "AQID" },
    ]);
    assert.match(expression, /DataTransfer/);
    assert.match(expression, /input\.files = transfer\.files/);
    assert.match(expression, /image\/png/);
    assert.match(expression, /AQID/);
    assert.match(ChatGPTDesktopBridgeTest.expressions.attachmentReady, /attachment/);
  });

  it("generates syntactically valid, visible-menu-scoped renderer expressions", () => {
    for (const expression of [
      ChatGPTDesktopBridgeTest.expressions.historyTrigger,
      ChatGPTDesktopBridgeTest.expressions.historyEntry("Saved chat"),
      ChatGPTDesktopBridgeTest.expressions.isGenerating,
      ChatGPTDesktopBridgeTest.expressions.modelMenuState,
      ChatGPTDesktopBridgeTest.expressions.modelSubmenuTrigger,
      ChatGPTDesktopBridgeTest.expressions.readLatestReasoning,
      ChatGPTDesktopBridgeTest.expressions.responseComplete,
      ChatGPTDesktopBridgeTest.expressions.visibleMenuItem("High"),
      ChatGPTDesktopBridgeTest.conversationSnapshotFromClient(conversationId),
    ])
      assert.doesNotThrow(() => new Function(`return (${expression});`));
  });

  it("reads the Desktop reasoning accordion and has no wall-clock response deadline", () => {
    assert.match(
      ChatGPTDesktopBridgeTest.expressions.readLatestReasoning,
      /exploration-accordion-body/u,
    );
    assert.match(ChatGPTDesktopBridgeTest.expressions.readLatestReasoning, /Thought/u);
    assert.match(ChatGPTDesktopBridgeTest.expressions.isGenerating, /startsWith\('stop'\)/u);
    assert.notMatch(
      ChatGPTDesktopBridgeTest.streamSend.toString(),
      /Timed out waiting for ChatGPT Desktop's assistant response|RESPONSE_TIMEOUT_MS/u,
    );
  });

  it("does not toggle quick chat when its composer is already present", async () => {
    const clicks: string[] = [];
    await ChatGPTDesktopBridgeTest.ensureQuickChat({
      evaluate: async (expression: string) => {
        if (/element\.click\(\)/u.test(expression)) clicks.push(expression);
        return { composer: true, empty: true, turnCount: 0 };
      },
    } as never);
    assert.deepEqual(clicks, []);
  });

  it("matches the desktop Chat launcher even when its shortcut is rendered inline", async () => {
    let probes = 0;
    const clicks: string[] = [];
    await ChatGPTDesktopBridgeTest.ensureQuickChat({
      evaluate: async (expression: string) => {
        if (/element\.click\(\)/u.test(expression)) {
          clicks.push(expression);
          return { ok: true };
        }
        return probes++ === 0
          ? { composer: false, empty: false, turnCount: 0 }
          : { composer: true, empty: true, turnCount: 0 };
      },
    } as never);
    assert.equal(clicks.length, 1);
    assert.match(clicks[0]!, /ChatCtrl\+/u);
  });

  it("reuses an already-empty new-chat surface and only clicks New chat for visible history", async () => {
    const readyClicks: string[] = [];
    await ChatGPTDesktopBridgeTest.prepareNewConversation({
      evaluate: async (expression: string) => {
        if (/element\.click\(\)/u.test(expression)) {
          readyClicks.push(expression);
          return { ok: true };
        }
        return { composer: true, empty: true, turnCount: 0 };
      },
    } as never);
    assert.deepEqual(readyClicks, []);

    let probes = 0;
    const historyClicks: string[] = [];
    await ChatGPTDesktopBridgeTest.prepareNewConversation({
      evaluate: async (expression: string) => {
        if (/element\.click\(\)/u.test(expression)) {
          historyClicks.push(expression);
          return { ok: true };
        }
        return probes++ === 0
          ? { composer: true, empty: true, turnCount: 2 }
          : { composer: true, empty: true, turnCount: 0 };
      },
    } as never);
    assert.equal(historyClicks.length, 1);
    assert.match(historyClicks[0]!, /New chat/u);
  });

  it("reopens the model menu after changing effort and always uses the visible version trigger", async () => {
    let probes = 0;
    const clicks: string[] = [];
    await ChatGPTDesktopBridgeTest.configureModel(
      {
        evaluate: async (expression: string) => {
          if (expression === ChatGPTDesktopBridgeTest.expressions.modelMenuState)
            return probes++ === 0 ? null : { selected: "Low", version: "GPT-5.4" };
          if (/element\.click\(\)/u.test(expression)) {
            clicks.push(expression);
            return { ok: true };
          }
          throw new Error(`Unexpected expression: ${expression}`);
        },
      } as never,
      {
        endpoint: "http://127.0.0.1:9222",
        text: "prompt",
        reasoningEffort: "high",
        model: "5.5",
      },
    );
    assert.equal(clicks.length, 5);
    assert.match(clicks[0]!, /Select ChatGPT model/u);
    assert.match(clicks[1]!, /High/u);
    assert.match(clicks[3]!, /aria-haspopup/u);
    assert.match(clicks[4]!, /GPT-5\.5/u);
  });

  it("waits for the asynchronously mounted Desktop model menu and closes it when unchanged", async () => {
    let probes = 0;
    const clicks: string[] = [];
    await ChatGPTDesktopBridgeTest.configureModel(
      {
        evaluate: async (expression: string) => {
          if (expression === ChatGPTDesktopBridgeTest.expressions.modelMenuState)
            return probes++ < 3 ? null : { selected: "High", version: "GPT-5.6 Sol" };
          if (/element\.click\(\)/u.test(expression)) {
            clicks.push(expression);
            return { ok: true };
          }
          throw new Error(`Unexpected expression: ${expression}`);
        },
      } as never,
      {
        endpoint: "http://127.0.0.1:9222",
        text: "prompt",
        reasoningEffort: "high",
        model: "latest",
      },
    );
    assert.equal(probes, 4);
    assert.equal(clicks.length, 2);
    assert.match(clicks[0]!, /Select ChatGPT model/u);
    assert.match(clicks[1]!, /Select ChatGPT model/u);
  });

  it("activates Send once and polls acknowledgement without duplicate submission", async () => {
    let activations = 0;
    let acknowledgementProbes = 0;
    await ChatGPTDesktopBridgeTest.submitMessage(async (expression: string) => {
      if (expression === ChatGPTDesktopBridgeTest.expressions.activateSend) {
        activations += 1;
        return { ok: true };
      }
      assert.equal(expression, ChatGPTDesktopBridgeTest.expressions.sendAcknowledged);
      acknowledgementProbes += 1;
      return acknowledgementProbes >= 3;
    });
    assert.equal(activations, 1);
    assert.equal(acknowledgementProbes, 3);
  });

  it("does not retry Send when activation times out but ChatGPT acknowledges it", async () => {
    let activations = 0;
    let acknowledgementProbes = 0;
    await ChatGPTDesktopBridgeTest.submitMessage(async (expression: string) => {
      if (expression === ChatGPTDesktopBridgeTest.expressions.activateSend) {
        activations += 1;
        throw new ChatGPTDesktopBridgeError({
          kind: "timeout",
          detail: "ambiguous activation timeout",
        });
      }
      assert.equal(expression, ChatGPTDesktopBridgeTest.expressions.sendAcknowledged);
      acknowledgementProbes += 1;
      return true;
    });
    assert.equal(activations, 1);
    assert.equal(acknowledgementProbes, 1);
  });

  it("keeps CDP transport failure, timeout, and active-command cancellation coverage", async () => {
    await withDesktop(
      (socket) => {
        socket.onSend = (message) => {
          const { id } = JSON.parse(message) as { id: number };
          queueMicrotask(() =>
            socket.emit("message", JSON.stringify({ id, result: { result: { value: "ok" } } })),
          );
        };
      },
      async () => {
        const cdp = await ChatGPTDesktopBridgeTest.openCdp("http://127.0.0.1:9222");
        assert.equal(await cdp.evaluate("1"), "ok");
        FakeSocket.instances[0]!.onSend = () => {};
        const pending = cdp.evaluate("2");
        FakeSocket.instances[0]?.emit("close");
        await assertRejected(pending, /connection closed/u);
      },
    );
    await withDesktop(
      (socket) => {
        socket.onSend = () => {};
      },
      async () => {
        const cdp = await ChatGPTDesktopBridgeTest.openCdp("http://127.0.0.1:9222", undefined, {
          commandMs: 1,
        });
        await assertRejected(cdp.evaluate("1"), /Runtime\.evaluate/u);
        const controller = new AbortController();
        const pending = cdp.evaluate("2", controller.signal);
        controller.abort();
        await assertRejected(pending, /interrupted/u);
      },
    );
  });

  it("uses CDP mouse dispatch for trusted controls and ignores malformed CDP messages", async () => {
    await withDesktop(
      (socket) => {
        socket.onSend = (message) => {
          const request = JSON.parse(message) as { id: number; method: string };
          if (request.method === "Runtime.evaluate") socket.emit("message", "not json");
          queueMicrotask(() =>
            socket.emit(
              "message",
              JSON.stringify({ id: request.id, result: { result: { value: { x: 4, y: 8 } } } }),
            ),
          );
        };
      },
      async () => {
        const cdp = await ChatGPTDesktopBridgeTest.openCdp("http://127.0.0.1:9222");
        await cdp.trustedClick("button[aria-label=Send]");
        const methods = FakeSocket.instances[0]!.sentMethods;
        assert.deepEqual(methods, [
          "Runtime.evaluate",
          "Input.dispatchMouseEvent",
          "Input.dispatchMouseEvent",
        ]);
      },
    );
  });

  it.effect(
    "reports an unavailable desktop bridge without falling through to provider runtime",
    () =>
      Effect.gen(function* () {
        const bridge = yield* ChatGPTDesktopBridge;
        const result = yield* Effect.flip(bridge.health("http://127.0.0.1:1"));
        assert.equal(result._tag, "ChatGPTDesktopBridgeError");
        assert.equal(result.kind, "unavailable");
      }).pipe(Effect.provide(ChatGPTDesktopBridgeLive)),
  );
});
