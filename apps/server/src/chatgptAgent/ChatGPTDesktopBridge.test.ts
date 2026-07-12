import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ChatGPTDesktopBridge,
  ChatGPTDesktopBridgeError,
  ChatGPTDesktopBridgeLive,
  ChatGPTDesktopBridgeTest,
} from "./ChatGPTDesktopBridge.ts";

const conversationId = "123e4567-e89b-42d3-a456-426614174000";

type Listener = (event: Event | MessageEvent) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  closed = false;
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

  close() {
    this.closed = true;
  }

  send(message: string) {
    this.onSend(message);
  }

  emit(name: string, data?: string) {
    const event = data === undefined ? new Event(name) : ({ data } as MessageEvent);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const desktopTarget = {
  type: "page",
  url: "https://chatgpt.com/c/example",
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

function respond(socket: FakeSocket, value: unknown, malformed = false) {
  socket.onSend = (message) => {
    const { id } = JSON.parse(message) as { id: number };
    if (malformed) socket.emit("message", "not JSON");
    queueMicrotask(() =>
      socket.emit("message", JSON.stringify({ id, result: { result: { value } } })),
    );
  };
}

async function assertRejected(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
    assert.equal(true, false, "Expected promise to reject");
  } catch (error) {
    assert.match(String(error), pattern);
  }
}

it("rejects non-loopback HTTP and WebSocket endpoints", () => {
  assert.throws(() => ChatGPTDesktopBridgeTest.validateEndpoint("https://127.0.0.1:9222"));
  assert.throws(() => ChatGPTDesktopBridgeTest.validateEndpoint("http://192.168.1.2:9222"));
  assert.throws(() =>
    ChatGPTDesktopBridgeTest.validateWebSocketEndpoint("ws://example.com/devtools"),
  );
  assert.equal(ChatGPTDesktopBridgeTest.validateEndpoint("http://[::1]:9222").hostname, "[::1]");
});

it("discovers only a local ChatGPT renderer target", async () => {
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

it("filters user turns before reading assistant response text", () => {
  const turns = ChatGPTDesktopBridgeTest.assistantTurns([
    { id: "user", role: "user", text: "just sent" },
    { id: "assistant", role: "assistant", text: "answer" },
  ]);
  assert.deepEqual(turns, [{ id: "assistant", role: "assistant", text: "answer" }]);
});

it("waits through a replaced renderer context and verifies the saved conversation", async () => {
  let attempts = 0;
  await ChatGPTDesktopBridgeTest.waitForRenderer(async () => {
    attempts += 1;
    if (attempts === 1)
      throw new ChatGPTDesktopBridgeError({
        kind: "incompatible",
        detail: "Execution context was destroyed during navigation.",
      });
    return {
      composer: true,
      conversationId: attempts === 2 ? "wrong" : conversationId,
    };
  }, conversationId);
  assert.equal(attempts, 3);
});

it("streams only a started assistant response and settles after generation completes", async () => {
  await withDesktop(
    (socket) => {
      let readCount = 0;
      let generating = true;
      socket.onSend = (message) => {
        const { id, params } = JSON.parse(message) as {
          id: number;
          params: { expression: string };
        };
        const expression = params.expression;
        let value: unknown;
        if (expression.includes("composer")) value = { composer: true, conversationId };
        else if (expression.includes("location.pathname.match")) value = conversationId;
        else if (expression.includes("data-message-author-role")) {
          readCount += 1;
          value =
            readCount === 1
              ? [{ id: "old", role: "assistant", text: "old response" }]
              : [
                  { id: "user", role: "user", text: "just sent" },
                  { id: "new", role: "assistant", text: "assistant response" },
                ];
        } else if (expression.includes("data-testid*")) {
          value = generating;
          generating = false;
        } else value = { ok: true };
        queueMicrotask(() =>
          socket.emit("message", JSON.stringify({ id, result: { result: { value } } })),
        );
      };
    },
    async () => {
      const chunks: Array<{ conversationId: string; text: string }> = [];
      for await (const chunk of ChatGPTDesktopBridgeTest.streamSend({
        endpoint: "http://127.0.0.1:9222",
        text: "prompt",
      }))
        chunks.push(chunk);
      assert.deepEqual(chunks, [{ conversationId, text: "assistant response" }]);
    },
  );
});

it("rejects pending commands on socket close or error and ignores malformed messages", async () => {
  await withDesktop(
    (socket) => respond(socket, "ok", true),
    async () => {
      const cdp = await ChatGPTDesktopBridgeTest.openCdp("http://127.0.0.1:9222");
      assert.equal(await cdp.evaluate("1"), "ok");
      const socket = FakeSocket.instances[0];
      if (socket) socket.onSend = () => {};
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
      const cdp = await ChatGPTDesktopBridgeTest.openCdp("http://127.0.0.1:9222");
      const pending = cdp.evaluate("1");
      FakeSocket.instances[0]?.emit("error");
      await assertRejected(pending, /connection failed/u);
    },
  );
});

it("times out commands and aborts active evaluation without late callbacks", async () => {
  await withDesktop(
    (socket) => {
      socket.onSend = () => {};
    },
    async () => {
      const cdp = await ChatGPTDesktopBridgeTest.openCdp("http://127.0.0.1:9222", undefined, {
        commandMs: 1,
      });
      await assertRejected(cdp.evaluate("1"), /did not complete/u);
      const controller = new AbortController();
      const pending = cdp.evaluate("2", controller.signal);
      controller.abort();
      await assertRejected(pending, /interrupted/u);
      FakeSocket.instances[0]?.emit(
        "message",
        JSON.stringify({ id: 2, result: { result: { value: "late" } } }),
      );
    },
  );
});

it("cancels response polling before a user turn can be treated as an assistant response", async () => {
  await withDesktop(
    (socket) => {
      socket.onSend = (message) => {
        const { id, params } = JSON.parse(message) as {
          id: number;
          params: { expression: string };
        };
        const expression = params.expression;
        const value = expression.includes("composer")
          ? { composer: true, conversationId }
          : expression.includes("location.pathname.match")
            ? conversationId
            : expression.includes("data-message-author-role")
              ? [{ id: "user", role: "user", text: "just sent" }]
              : expression.includes("data-testid*")
                ? false
                : { ok: true };
        queueMicrotask(() =>
          socket.emit("message", JSON.stringify({ id, result: { result: { value } } })),
        );
      };
    },
    async () => {
      const controller = new AbortController();
      const stream = ChatGPTDesktopBridgeTest.streamSend({
        endpoint: "http://127.0.0.1:9222",
        text: "prompt",
        signal: controller.signal,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const pending = iterator.next();
      setTimeout(() => controller.abort(), 10);
      await assertRejected(pending, /interrupted/u);
    },
  );
});

it.effect("reports an unavailable desktop bridge without falling through to provider runtime", () =>
  Effect.gen(function* () {
    const bridge = yield* ChatGPTDesktopBridge;
    const result = yield* Effect.flip(bridge.health("http://127.0.0.1:1"));
    assert.equal(result._tag, "ChatGPTDesktopBridgeError");
    assert.equal(result.kind, "unavailable");
  }).pipe(Effect.provide(ChatGPTDesktopBridgeLive)),
);
