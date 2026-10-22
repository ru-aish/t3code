// @effect-diagnostics nodeBuiltinImport:off -- Wire tests exercise real binary files and serialized renderer code.
import { OrchestratorMcpThreadSendInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatGPTConnection,
  ChatGPTSubmissionNotStartedError,
  executionPrompt,
  stableMessageId,
  type ChatGPTUpdate,
} from "./connection.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { vi } from "vite-plus/test";

const decodeThreadSend = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestratorMcpThreadSendInput),
);


describe("CDP transport recovery", () => {
  it("times out an unopened renderer and reconnects rather than caching the failed attempt", async () => {
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      readyState = 0;
      constructor() { super(); sockets.push(this); }
      send(raw: string) {
        const { id, method } = JSON.parse(raw);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id, result: method === "Runtime.evaluate" ? { result: { value: true } } : {} }),
        })));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([
      { type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
    ])));
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cdp-timeout-"));
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234", controlEndpoint: "http://127.0.0.1:8022",
      token: "test", environmentId: "test", providerId: "chatgpt", threadId: "timeout", cacheDir: directory,
    });
    try {
      vi.useFakeTimers();
      const timedOut = connection.health();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const assertion = expect(timedOut).rejects.toThrow("handshake timed out");
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
      expect(sockets[0]!.readyState).toBe(Socket.CLOSED);
      const recovered = connection.health();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1]!.open();
      await recovered;
    } finally {
      connection.close();
      vi.useRealTimers();
      fetched.mockRestore();
      vi.unstubAllGlobals();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["close", "Runtime.executionContextsCleared", "Inspector.detached"])("notifies recovery and reconnects after %s without accepting stale disconnects", async (event) => {
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      static nextHealthy = true;
      readyState = 0;
      respond = true;
      healthy = Socket.nextHealthy;
      constructor() { super(); sockets.push(this); queueMicrotask(() => this.open()); }
      send(raw: string) {
        const { id, method } = JSON.parse(raw);
        if (method === "Runtime.evaluate" && !this.respond) return;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id, result: method === "Runtime.evaluate" ? { result: { value: this.healthy } } : {} }),
        })));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([
      { type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
    ])));
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cdp-inflight-"));
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234", controlEndpoint: "http://127.0.0.1:8022",
      token: "test", environmentId: "test", providerId: "chatgpt", threadId: "inflight", cacheDir: directory,
    });
    const updates: ChatGPTUpdate[] = [];
    connection.onUpdate((update) => updates.push(update));
    const disconnect = (socket: Socket) => event === "close" ? socket.close() : socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method: event, params: {} }) }));
    try {
      await connection.health();
      sockets[0]!.respond = false;
      const inflight = connection.health();
      const assertion = expect(inflight).rejects.toThrow("renderer disconnected");
      await Promise.resolve();
      disconnect(sockets[0]!);
      await assertion;
      expect(updates.map((update) => update.kind)).toEqual(["disconnected"]);
      Socket.nextHealthy = false;
      const second = connection.health();
      const unhealthy = expect(second).rejects.toThrow("Authenticated ChatGPT client is unavailable");
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      await unhealthy;
      sockets[1]!.close();
      Socket.nextHealthy = true;
      await connection.health();
      expect(sockets).toHaveLength(3);
      expect(updates.map((update) => update.kind)).toEqual(["disconnected", "disconnected"]);
      sockets[0]!.dispatchEvent(new Event("close"));
      await connection.health();
      expect(sockets).toHaveLength(3);
    } finally {
      connection.close();
      expect(updates).toHaveLength(2);
      fetched.mockRestore();
      vi.unstubAllGlobals();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });


  it("cleans pending commands after a synchronous WebSocket send failure", async () => {
    class ThrowSocket extends EventTarget {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      readyState = 1;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send() { throw new Error("send failed"); }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    vi.stubGlobal("WebSocket", ThrowSocket);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([
      { type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
    ])));
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cdp-throw-"));
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234", controlEndpoint: "http://127.0.0.1:8022",
      token: "test", environmentId: "test", providerId: "chatgpt",
      threadId: "send-throw", cacheDir: directory,
    });
    try {
      await expect(connection.health()).rejects.toThrow("send failed");
      expect(Reflect.get(connection, "connecting")).toBeUndefined();
    } finally {
      connection.close();
      fetch.mockRestore();
      vi.unstubAllGlobals();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects close before open and allows a subsequent successful connection", async () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      readyState = 0;
      constructor() { super(); sockets.push(this); }
      send(raw: string) {
        const command = JSON.parse(raw);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id: command.id, result: command.method === "Runtime.evaluate" ? { result: { value: true } } : {} }),
        })));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([
      { type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
    ])));
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cdp-recovery-"));
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234", controlEndpoint: "http://127.0.0.1:8022",
      token: "test", environmentId: "test", providerId: "chatgpt", threadId: "recovery",
      cacheDir: directory,
    });
    try {
      const first = connection.health();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.close();
      await expect(first).rejects.toThrow("closed during handshake");
      const concurrent = Array.from({ length: 24 }, () => connection.health());
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1]!.open();
      await Promise.all(concurrent);
      expect(sockets).toHaveLength(2);
      sockets[0]!.dispatchEvent(new Event("close"));
      await connection.health();
      expect(sockets).toHaveLength(2);
    } finally {
      connection.close();
      fetch.mockRestore();
      vi.unstubAllGlobals();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Conversation-scoped stop ordering", () => {
  it("does not submit a newer request before an earlier native stop settles", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "chatgpt-stop-order-"));
    try {
      const connection = new ChatGPTConnection({
        cdpEndpoint: "http://127.0.0.1:9234",
        controlEndpoint: "http://127.0.0.1:8022",
        token: "test",
        environmentId: "test",
        providerId: "chatgpt",
        threadId: "thread",
        cacheDir: directory,
      });
      await connection.adoptConversation("existing-conversation");
      const releaseStop = Promise.withResolvers<void>();
      const enteredStop = Promise.withResolvers<void>();
      const operations: string[] = [];
      Object.assign(connection, {
        renderer: async () => ({
          evaluate: async (expression: string) => {
            if (expression.includes("await r.client.stopCompletion(")) {
              expect(expression).toContain("terminal-mcp.chat-runtime.client.v5");
              expect(expression).toContain("stopCompletion({conversation_id:conversationId");
              expect(expression).toContain("prior-request");
              operations.push("stop-start");
              enteredStop.resolve();
              await releaseStop.promise;
              operations.push("stop-finish");
              return true;
            }
            if (expression.includes("const raw=await r.client.get("))
              return { current_node: "parent", gizmo_id: null };
            if (expression.includes("startCompletionStream")) {
              operations.push("send");
              return { submitted: true };
            }
            throw new Error("Unexpected CDP evaluation");
          },
        }),
      });
      const stopping = connection.stop("prior-request");
      await enteredStop.promise;
      const sending = connection.send("next-request", "next", "gpt-6-thinking", directory);
      await Promise.resolve();
      expect(operations).toEqual(["stop-start"]);
      releaseStop.resolve();
      await Promise.all([stopping, sending]);
      expect(operations).toEqual(["stop-start", "stop-finish", "send"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("orders a stop arriving during conversation preparation before native submission", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "chatgpt-stop-mid-send-"),
    );
    try {
      const connection = new ChatGPTConnection({
        cdpEndpoint: "http://127.0.0.1:9234",
        controlEndpoint: "http://127.0.0.1:8022",
        token: "test",
        environmentId: "test",
        providerId: "chatgpt",
        threadId: "thread",
        cacheDir: directory,
      });
      await connection.adoptConversation("existing-conversation");
      const parentEntered = Promise.withResolvers<void>();
      const releaseParent = Promise.withResolvers<void>();
      const stopEntered = Promise.withResolvers<void>();
      const releaseStop = Promise.withResolvers<void>();
      const prepared = Promise.withResolvers<void>();
      const operations: string[] = [];
      Object.assign(connection, {
        persist: async () => {
          const cache = Reflect.get(connection, "cache");
          if (cache.dispatches["next-request"]?.state === "dispatching") prepared.resolve();
        },
        renderer: async () => ({
          evaluate: async (expression: string) => {
            if (expression.includes("const raw=await r.client.get(")) {
              operations.push("parent-read");
              parentEntered.resolve();
              await releaseParent.promise;
              return { current_node: "parent", gizmo_id: null };
            }
            if (expression.includes("await r.client.stopCompletion(")) {
              operations.push("stop-start");
              stopEntered.resolve();
              await releaseStop.promise;
              operations.push("stop-finish");
              return true;
            }
            if (expression.includes("startCompletionStream")) {
              operations.push("send");
              return { submitted: true };
            }
            throw new Error("Unexpected CDP evaluation");
          },
        }),
      });
      const sending = connection.send("next-request", "next", "gpt-6-thinking", directory);
      await parentEntered.promise;
      const stopping = connection.stop("prior-request");
      await stopEntered.promise;
      releaseParent.resolve();
      await prepared.promise;
      await Promise.resolve();
      expect(operations).toEqual(["parent-read", "stop-start"]);
      releaseStop.resolve();
      await Promise.all([sending, stopping]);
      expect(operations).toEqual(["parent-read", "stop-start", "stop-finish", "send"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ChatGPT submission identity", () => {
  it("uses the same valid upstream message ID for a retried durable request", () => {
    expect(stableMessageId("request-one")).toBe(stableMessageId("request-one"));
    expect(stableMessageId("request-one")).not.toBe(stableMessageId("request-two"));
    expect(stableMessageId("request-one")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("makes configured local MCPs visible even on a first-turn greeting", () => {
    const inventory = {
      servers: [
        { name: "browser-tools", transport: "stdio", status: "configured" },
        { name: "remote-docs", transport: "streamable-http", status: "configured" },
      ],
    };
    for (const message of ["hi", "hello", "continue"]) {
      const prompt = executionPrompt("registered-id", "/work/project", message, undefined, inventory);
      expect(prompt).toContain('"name":"browser-tools"');
      expect(prompt).toContain('"name":"remote-docs"');
      expect(prompt).toContain('local_mcp(action="tools"');
      expect(prompt).toContain('local_mcp(action="call"');
      expect(prompt).toContain('session_id="registered-id"');
      expect(prompt.endsWith(`\n\n${message}`)).toBe(true);
    }
    expect(executionPrompt("registered-id", "/work/project", "hi")).toContain(
      "Local MCP catalog unavailable",
    );
  });

  it("injects the stored destination identity into every prompt including continuations", () => {
    for (const text of ["initial request", "follow-up request", "continue"]) {
      const compiled = executionPrompt("registered-id", "/work/project", text);
      expect(compiled).toContain("permanent Terminal MCP thread ID is: registered-id");
      expect(compiled).toContain('Workspace: "/work/project"');
      expect(compiled.endsWith(`\n\n${text}`)).toBe(true);
      expect(compiled).toContain(
        "Without fedora_t3code tool use, simply end your response normally.",
      );
    }
  });
});

describe("ChatGPT orchestration instructions", () => {
  it("exposes canonical async controls without a parent registration or credential", () => {
    const prompt = executionPrompt(
      "parent-thread",
      "/work/project",
      "Delegate a review",
      "private-bridge-command",
    );
    for (const tool of [
      "orchestrator_capabilities",
      "delegate_task",
      "task_status",
      "task_cancel",
      "t3_thread_send",
      "t3_thread_read",
    ])
      expect(prompt).toContain(tool);
    const sendExample = prompt.match(/send_input = t3_thread_send (\{[^}]+\})/)?.[1];
    expect(decodeThreadSend(sendExample)).toMatchObject({
      threadId: "returned childThreadId",
      message: "follow-up",
      mode: "auto",
    });
    expect(prompt).not.toContain("--help");
    expect(prompt).toContain("Spawn is async by default");
    expect(prompt).toContain("Do not poll, wait, or start watcher processes");
    expect(prompt).toContain("taskId is the delegated task handle");
    expect(prompt).toContain("--list-tools");
    expect(prompt).toContain("--describe-tool");
    expect(prompt).toContain("preview_open");
    expect(prompt).not.toContain("Bearer");
    expect(executionPrompt("parent-thread", "/work/project", "Hello")).not.toContain(
      "T3 orchestration tools",
    );
  });
});

describe("ChatGPT Terminal MCP control errors", () => {
  it("includes the control-plane error detail in failed requests", async () => {
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "thread:delegated-task:command%3Amcp%3Aexample",
      cacheDir: "/tmp",
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "A non-default registered thread identifier is required" }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    try {
      await expect(
        connection.control("register", { cwd: "/work", model: "gpt-5-6" }),
      ).rejects.toThrow(
        "Terminal MCP control request failed (409): A non-default registered thread identifier is required",
      );
    } finally {
      request.mockRestore();
    }
  });
});

describe("ChatGPT streamed update delivery", () => {
  it("does not block known-conversation updates on diagnostic cache writes", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-stream-"));
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "thread",
      cacheDir: directory,
    });
    await connection.adoptConversation("conversation");
    const delivered: string[] = [];
    connection.onUpdate((update) => delivered.push(update.messageId ?? update.kind));
    const gate = Promise.withResolvers<void>();
    const internals = connection as unknown as {
      persist: () => Promise<void>;
      acceptRendererUpdate: (update: ChatGPTUpdate) => void;
    };
    const persist = vi.fn(() => gate.promise);
    internals.persist = persist;
    try {
      internals.acceptRendererUpdate({
        kind: "update",
        requestId: "request",
        conversationId: "conversation",
        messageId: "delta",
        text: "Streaming",
      });
      await Promise.resolve();
      expect(delivered).toEqual(["delta"]);
      expect(persist).not.toHaveBeenCalled();

      internals.acceptRendererUpdate({
        kind: "complete",
        requestId: "request",
        conversationId: "conversation",
      });
      await Promise.resolve();
      expect(delivered).toEqual(["delta", "complete"]);
      expect(persist).toHaveBeenCalledTimes(1);
      gate.resolve();
      await gate.promise;
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ChatGPT interruption", () => {
  type InterruptHarnessOptions = {
    get?: (...args: unknown[]) => Promise<unknown>;
    startCompletionStream?: (input: {
      startupSignal?: AbortSignal;
      request?: unknown;
      onUpdate?: (value: unknown) => void;
      onComplete?: (value: unknown) => void;
      onError?: (value: unknown) => void;
    }) => unknown;
    stopCompletion?: (...args: unknown[]) => Promise<void>;
    cancelStream?: (streamRequestId: string) => void;
    streams?: Map<string, unknown>;
  };

  const makeHarness = async (options: InterruptHarnessOptions = {}) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-stop-"));
    const stopCompletion = options.stopCompletion ?? vi.fn(async () => {});
    const cancelStream = options.cancelStream ?? vi.fn();
    const startCompletionStream =
      options.startCompletionStream ??
      vi.fn(() => Promise.resolve({ streamRequestId: "stream-1" }));
    const client = {
      get: options.get ?? (async () => ({ current_node: "parent" })),
      list: async () => ({}),
      models: async () => ({}),
      startCompletionStream,
      stopCompletion,
      cancelStream,
    };
    const window: Record<symbol, unknown> = {
      [Symbol.for("terminal-mcp.chat-runtime.client.v5")]: client,
    };
    const storage = new Map<string, string>();
    Object.assign(window, {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
      },
    });
    if (options.streams) window[Symbol.for("t3.chatgpt.streams.v1")] = options.streams;
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "thread",
      cacheDir: directory,
    });
    Object.assign(connection, {
      renderer: async () => ({
        evaluate: (expression: string) =>
          NodeVM.runInNewContext(expression, {
            window,
            Symbol,
            Map,
            Set,
            Promise,
            AbortController,
          }),
      }),
    });
    return {
      directory,
      connection,
      window,
      stopCompletion,
      cancelStream,
      startCompletionStream,
      cleanup: async () => {
        connection.close();
        await (connection as unknown as { writes: Promise<unknown> }).writes;
        await NodeFSP.rm(directory, { recursive: true, force: true });
      },
    };
  };

  type InterruptHarness = Awaited<ReturnType<typeof makeHarness>>;

  const withHarness = async (
    options: InterruptHarnessOptions,
    run: (harness: InterruptHarness) => Promise<void>,
  ) => {
    const harness = await makeHarness(options);
    try {
      await run(harness);
    } finally {
      await harness.cleanup();
    }
  };

  const loadDispatches = async (
    connection: ChatGPTConnection,
    dispatches: Record<string, { messageId: string; state: string }>,
  ) => {
    await NodeFSP.writeFile(
      connection.cachePath,
      JSON.stringify({
        conversationId: "conversation",
        messages: {},
        dispatches,
        handledEvents: [],
      }),
    );
    await connection.load();
  };

  const nativeStopPayload = {
    conversation_id: "conversation",
    exclude_async_types: [],
  };

  it("uses ChatGPT's native stop payload and cancels the active stream", async () => {
    await withHarness({}, async ({ connection, stopCompletion, cancelStream, directory }) => {
      await connection.adoptConversation("conversation");
      await connection.send("request", "Stop me", "gpt-6-thinking", directory);
      await connection.stop("request");

      expect(stopCompletion).toHaveBeenCalledWith(nativeStopPayload);
      expect(cancelStream).toHaveBeenCalledWith("stream-1");
    });
  });

  it("can interrupt a new conversation while its stream handle is still pending", async () => {
    const handle = Promise.withResolvers<{ streamRequestId: string }>();
    let startupSignal: AbortSignal | undefined;
    await withHarness(
      {
        get: async () => ({}),
        startCompletionStream: (input) => {
          startupSignal = input.startupSignal;
          return handle.promise;
        },
      },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        try {
          await connection.send("request", "Stop me", "gpt-6-thinking", directory);
          await expect(connection.stop("request")).resolves.toBeUndefined();

          expect(startupSignal?.aborted).toBe(true);
          expect(stopCompletion).not.toHaveBeenCalled();
          expect(cancelStream).not.toHaveBeenCalled();

          handle.resolve({ streamRequestId: "stream-new" });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(cancelStream).toHaveBeenCalledWith("stream-new");
        } finally {
          handle.resolve({ streamRequestId: "stream-new" });
        }
      },
    );
  });

  it("does not wait for a pending stream handle before stopping a known conversation", async () => {
    const handle = Promise.withResolvers<{ streamRequestId: string }>();
    await withHarness(
      { startCompletionStream: () => handle.promise },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        try {
          await connection.adoptConversation("conversation");
          await connection.send("request", "Stop me", "gpt-6-thinking", directory);
          const stopping = connection.stop("request");
          await new Promise<void>((resolve) => setImmediate(resolve));

          await stopping;
          expect(stopCompletion).toHaveBeenCalledWith(nativeStopPayload);
          expect(cancelStream).not.toHaveBeenCalled();

          handle.resolve({ streamRequestId: "stream-pending" });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(cancelStream).toHaveBeenCalledWith("stream-pending");
        } finally {
          handle.resolve({ streamRequestId: "stream-pending" });
        }
      },
    );
  });

  it("falls back to stream cancellation when native stop fails", async () => {
    await withHarness(
      {
        stopCompletion: vi.fn(async () => {
          throw new Error("native stop failed");
        }),
        startCompletionStream: () => Promise.resolve({ streamRequestId: "stream-fallback" }),
      },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        await connection.adoptConversation("conversation");
        await connection.send("request", "Stop me", "gpt-6-thinking", directory);
        await expect(connection.stop("request")).resolves.toBeUndefined();

        expect(stopCompletion).toHaveBeenCalledOnce();
        expect(cancelStream).toHaveBeenCalledWith("stream-fallback");
      },
    );
  });

  it("keeps the request retired when every native stop mechanism fails", async () => {
    await withHarness(
      {
        stopCompletion: vi.fn(async () => {
          throw new Error("native stop failed");
        }),
        startCompletionStream: () => Promise.resolve({}),
      },
      async ({ connection, window, stopCompletion, cancelStream, directory }) => {
        await connection.adoptConversation("conversation");
        await connection.send("request", "Stop me", "gpt-6-thinking", directory);
        await new Promise<void>((resolve) => setImmediate(resolve));

        await expect(connection.stop("request")).rejects.toThrow("native stop failed");

        expect(stopCompletion).toHaveBeenCalledOnce();
        expect(cancelStream).not.toHaveBeenCalled();
        const cancelled = window[Symbol.for("t3.chatgpt.cancelled.v1")] as Set<string>;
        expect(cancelled.has("request")).toBe(true);
      },
    );
  });

  it("keeps a successful native stop successful when local stream cleanup fails", async () => {
    await withHarness(
      {
        cancelStream: vi.fn(() => {
          throw new Error("local cancel failed");
        }),
        startCompletionStream: () => Promise.resolve({ streamRequestId: "stream-local-cleanup" }),
      },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        await connection.adoptConversation("conversation");
        await connection.send("request", "Stop me", "gpt-6-thinking", directory);
        await expect(connection.stop("request")).resolves.toBeUndefined();

        expect(stopCompletion).toHaveBeenCalledOnce();
        expect(cancelStream).toHaveBeenCalledWith("stream-local-cleanup");
      },
    );
  });

  it("uses the renderer conversation ID before the persisted cache catches up", async () => {
    await withHarness(
      {
        get: async () => ({}),
        startCompletionStream: () => Promise.resolve({ streamRequestId: "stream-renderer-id" }),
      },
      async ({ connection, window, stopCompletion, directory }) => {
        await connection.send("request", "Stop me", "gpt-6-thinking", directory);
        const streams = window[Symbol.for("t3.chatgpt.streams.v1")] as Map<
          string,
          { conversationId: string | null }
        >;
        streams.get("thread")!.conversationId = "renderer-conversation";

        await connection.stop("request");

        expect(stopCompletion).toHaveBeenCalledWith({
          conversation_id: "renderer-conversation",
          exclude_async_types: [],
        });
      },
    );
  });

  it("uses startup abort when native stop fails before the stream handle resolves", async () => {
    const handle = Promise.withResolvers<{ streamRequestId: string }>();
    let startupSignal: AbortSignal | undefined;
    await withHarness(
      {
        startCompletionStream: (input) => {
          startupSignal = input.startupSignal;
          return handle.promise;
        },
        stopCompletion: vi.fn(async () => {
          throw new Error("native stop failed");
        }),
      },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        try {
          await connection.adoptConversation("conversation");
          await connection.send("request", "Stop me", "gpt-6-thinking", directory);
          await expect(connection.stop("request")).resolves.toBeUndefined();

          expect(startupSignal?.aborted).toBe(true);
          expect(stopCompletion).toHaveBeenCalledOnce();

          handle.reject(new Error("startup aborted"));
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(cancelStream).not.toHaveBeenCalled();
        } finally {
          handle.reject(new Error("startup aborted"));
        }
      },
    );
  });

  it("prevents an interrupted pending submission from starting and ignores stale stream state", async () => {
    const getStarted = Promise.withResolvers<void>();
    const getGate = Promise.withResolvers<{ current_node: string }>();
    const startCompletionStream = vi.fn(() => ({ streamRequestId: "new-stream" }));
    const streams = new Map<string, unknown>([
      [
        "thread",
        {
          requestId: "old-request",
          conversationId: "conversation",
          handle: { streamRequestId: "old-stream" },
          active: true,
        },
      ],
    ]);
    await withHarness(
      {
        get: vi.fn(() => {
          getStarted.resolve();
          return getGate.promise;
        }),
        startCompletionStream,
        streams,
      },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        try {
          await connection.adoptConversation("conversation");
          const sending = connection.send("request", "Do not start", "gpt-6-thinking", directory);
          await getStarted.promise;

          await expect(connection.stop("request")).resolves.toBeUndefined();
          expect(stopCompletion).not.toHaveBeenCalled();
          expect(cancelStream).not.toHaveBeenCalled();

          getGate.resolve({ current_node: "parent" });
          await sending;

          expect(startCompletionStream).not.toHaveBeenCalled();
          expect(connection.submittedRequestIds).not.toContain("request");
          expect((streams.get("thread") as { requestId?: string } | undefined)?.requestId).toBe(
            "old-request",
          );
        } finally {
          getGate.resolve({ current_node: "parent" });
        }
      },
    );
  });

  it("does not let a cancelled submission delete a newer renderer stream owner", async () => {
    await withHarness({}, async ({ connection, window, startCompletionStream, directory }) => {
      const client = window[Symbol.for("terminal-mcp.chat-runtime.client.v5")] as {
        get: (...args: unknown[]) => Promise<unknown>;
      };
      const get = client.get;
      let injected = false;
      const newerState = {
        requestId: "request-b",
        conversationId: "conversation-b",
        handle: { streamRequestId: "stream-b" },
        active: true,
      };
      Object.defineProperty(client, "get", {
        configurable: true,
        get() {
          if (!injected) {
            injected = true;
            const cancelKey = Symbol.for("t3.chatgpt.cancelled.v1");
            const streamsKey = Symbol.for("t3.chatgpt.streams.v1");
            const cancels = (window[cancelKey] ??= new Set<string>()) as Set<string>;
            const streams = window[streamsKey] as Map<string, unknown>;
            cancels.add("request-a");
            streams.set("thread", newerState);
          }
          return get;
        },
      });

      await connection.send("request-a", "Cancelled", "gpt-6-thinking", directory);

      const streams = window[Symbol.for("t3.chatgpt.streams.v1")] as Map<string, unknown>;
      expect(streams.get("thread")).toBe(newerState);
      expect(startCompletionStream).not.toHaveBeenCalled();
      expect(connection.submittedRequestIds).not.toContain("request-a");
    });
  });

  it("does not use a cached conversation when another request owns the renderer stream", async () => {
    const streams = new Map<string, unknown>([
      [
        "thread",
        {
          requestId: "request-b",
          conversationId: "conversation",
          handle: { streamRequestId: "stream-b" },
          active: true,
        },
      ],
    ]);
    await withHarness({ streams }, async ({ connection, window, stopCompletion, cancelStream }) => {
      await loadDispatches(connection, {
        "request-a": { messageId: stableMessageId("request-a"), state: "submitted" },
        "request-b": { messageId: stableMessageId("request-b"), state: "dispatching" },
      });

      await expect(connection.stop("request-a")).rejects.toThrow(
        "another request owns the renderer stream",
      );
      expect(stopCompletion).not.toHaveBeenCalled();
      expect(cancelStream).not.toHaveBeenCalled();
      const cancelled = window[Symbol.for("t3.chatgpt.cancelled.v1")] as Set<string>;
      expect(cancelled.has("request-a")).toBe(true);
    });
  });

  it("does not use cached fallback while another request is dispatching", async () => {
    await withHarness({}, async ({ connection, window, stopCompletion, cancelStream }) => {
      await loadDispatches(connection, {
        "request-a": { messageId: stableMessageId("request-a"), state: "submitted" },
        "request-b": { messageId: stableMessageId("request-b"), state: "dispatching" },
      });

      await expect(connection.stop("request-a")).rejects.toThrow("renderer state is unavailable");
      expect(stopCompletion).not.toHaveBeenCalled();
      expect(cancelStream).not.toHaveBeenCalled();
      const cancelled = window[Symbol.for("t3.chatgpt.cancelled.v1")] as Set<string>;
      expect(cancelled.has("request-a")).toBe(true);
    });
  });

  it.each([
    "asdk_app_6ad23e985b608191984705f0c25f1ba3",
    "asdk_app_6a9b31f86efc81918287f37a02413746",
    "asdk_app_recreated_connection",
  ])(
    "auto-approves successive Terminal prompts without losing output or polling (%s)",
    async (connectorId) => {
      const requests: Array<Record<string, unknown>> = [];
      const completed = Promise.withResolvers<void>();
      let latestHead: Record<string, unknown> | null = null;
      const get = vi.fn(async () => {
        if (!latestHead) throw new Error("Missing approval head");
        return {
          conversation_id: "new-conversation",
          default_model_slug: "gpt-6-thinking",
          current_node: latestHead.id,
          mapping: { [latestHead.id as string]: { message: latestHead } },
        };
      });
      const startCompletionStream = vi.fn(
        (input: {
          request?: unknown;
          onUpdate?: (value: unknown) => void;
          onComplete?: (value: unknown) => void;
        }) => {
          requests.push(input.request as Record<string, unknown>);
          const index = requests.length;
          queueMicrotask(() => {
            if (index <= 3) {
              const messageId = `approval-${index}`;
              const message = {
                id: messageId,
                author: { role: "tool" },
                content: { parts: [""] },
                metadata: {
                  jit_plugin_data: {
                    from_server: {
                      type: "confirm_action",
                      body: {
                        codex_mcp_elicitation: { kind: "mcpToolCall", status: "pending" },
                        connector_id: connectorId,
                        params: {
                          path: `/${connectorId}/link_6ad23eb0b6cc819189b71f055d70599c/bootstrap_thread`,
                          args: { thread_id: "thread" },
                        },
                        link_id: "link_6ad23eb0b6cc819189b71f055d70599c",
                        connector_name: "fedora_t3code",
                        actions: [{ always_allow: { target_message_id: messageId } }],
                      },
                    },
                  },
                },
              };
              latestHead = message;
              const event = { conversation_id: "new-conversation", message };
              input.onUpdate?.(event);
              if (index === 2) input.onUpdate?.(event);
              input.onComplete?.({ conversation_id: "new-conversation" });
            } else {
              input.onUpdate?.({
                conversation_id: "new-conversation",
                message: {
                  id: "assistant-final",
                  author: { role: "assistant" },
                  channel: "final",
                  status: "finished_successfully",
                  end_turn: true,
                  content: { parts: ["Y"] },
                },
              });
              input.onComplete?.({ conversation_id: "new-conversation" });
            }
          });
          return { streamRequestId: `stream-${index}` };
        },
      );

      await withHarness({ get, startCompletionStream }, async ({ connection, window }) => {
        vi.spyOn(connection, "control").mockResolvedValue({ servers: [] });
        Object.assign(window, { crypto: { randomUUID: () => "approval-response-id" } });
        const internals = connection as unknown as {
          binding: string;
          acceptRendererUpdate: (update: ChatGPTUpdate) => void;
        };
        Object.assign(window, {
          [internals.binding]: (payload: string) =>
            internals.acceptRendererUpdate(JSON.parse(payload) as ChatGPTUpdate),
        });
        const updates: ChatGPTUpdate[] = [];
        connection.onUpdate((update) => {
          updates.push(update);
          if (update.kind === "complete") completed.resolve();
        });

        await connection.send("request", "Run a harmless Fedora command", "gpt-6-thinking", "/tmp");
        await completed.promise;

        expect(requests).toHaveLength(4);
        for (let i = 1; i <= 3; i++) {
          expect(requests[i]).toMatchObject({
            action: "next",
            conversation_id: "new-conversation",
            parent_message_id: `approval-${i}`,
            model: "gpt-6-thinking",
            messages: [
              {
                author: { role: "tool", name: "api_tool.call_tool" },
                metadata: {
                  jit_plugin_data: {
                    from_client: {
                      target_message_id: `approval-${i}`,
                      type: "always_allow",
                    },
                  },
                },
              },
            ],
          });
        }
        expect(get).toHaveBeenCalledTimes(3);
        expect(updates.filter((update) => update.kind === "complete")).toHaveLength(1);
        expect(updates.filter((update) => update.fedoraApproval)).toHaveLength(4);
        expect(updates.some((update) => update.text === "Y")).toBe(true);
      });
    },
  );

  it.each([
    "success",
    "recover-read",
    "cancel-recovery",
    "reload-renderer",
    "replace-connection",
    "passive-refresh",
    "stream-error",
    "stop-after-reload",
    "stop-during-recovery",
    "older-runtime",
    "lost-completion",
    "manual-resume",
    "stopped-cache-reload",
    "uncertain-reload",
  ])("continues head-only approval after verification (%s)", async (scenario) => {
    const verificationFailed = Promise.withResolvers<void>();
    const approvalFailed = Promise.withResolvers<void>();
    const recoveryReading = Promise.withResolvers<void>();
    const recoveryRead = Promise.withResolvers<void>();
    let reads = 0;
    let canonicalRequestId = "request";
    const completed = Promise.withResolvers<void>();
    const approvals: Array<Record<string, unknown>> = [];
    const approvalMessage = {
      id: "head-only-approval",
      author: { role: "tool" },
      metadata: {
        jit_plugin_data: {
          from_server: {
            type: "confirm_action",
            body: {
              codex_mcp_elicitation: { kind: "mcpToolCall", status: "pending" },
              connector_id: "asdk_app_6ad23e985b608191984705f0c25f1ba3",
              connector_name: "fedora_t3code",
              link_id: "link_6ad23eb0b6cc819189b71f055d70599c",
              params: {
                path: "/asdk_app_6ad23e985b608191984705f0c25f1ba3/link_6ad23eb0b6cc819189b71f055d70599c/bootstrap_thread",
                args: { thread_id: "thread" },
              },
              actions: [{ always_allow: { target_message_id: "head-only-approval" } }],
            },
          },
        },
      },
    };
    const get = vi.fn(async () => {
      reads++;
      if (
        scenario !== "success" &&
        scenario !== "stream-error" &&
        scenario !== "lost-completion" &&
        reads === 1
      )
        throw new Error("Too many requests");
      if (scenario === "stop-during-recovery" && reads === 2) {
        recoveryReading.resolve();
        await recoveryRead.promise;
      }
      return {
        conversation_id: "new-conversation",
        default_model_slug: "gpt-6-thinking",
        async_status: null,
        current_node: approvalMessage.id,
        mapping: {
          user: {
            message: { id: stableMessageId(canonicalRequestId), author: { role: "user" } },
            parent: null,
          },
          [approvalMessage.id]: { message: approvalMessage, parent: "user" },
        },
      };
    });
    const startCompletionStream = vi.fn(
      (input: {
        request?: unknown;
        onUpdate?: (value: unknown) => void;
        onComplete?: (value: unknown) => void;
        onError?: (value: unknown) => void;
      }) => {
        approvals.push(input.request as Record<string, unknown>);
        queueMicrotask(() => {
          if (approvals.length === 1 || (scenario === "manual-resume" && approvals.length === 2)) {
            input.onUpdate?.({
              conversation_id: "new-conversation",
              message: { id: "thinking", author: { role: "assistant" }, channel: "analysis" },
            });
            if (scenario === "stream-error") input.onError?.(new Error("Network changed"));
            else if (scenario === "lost-completion") verificationFailed.resolve();
            else input.onComplete?.({ conversation_id: "new-conversation" });
          } else if (scenario === "uncertain-reload") {
            input.onError?.(new Error("Connection lost during approval submission"));
            approvalFailed.resolve();
          } else {
            input.onUpdate?.({
              conversation_id: "new-conversation",
              message: {
                id: "final",
                author: { role: "assistant" },
                channel: "final",
                end_turn: true,
                content: { parts: ["Y"] },
              },
            });
            input.onComplete?.({ conversation_id: "new-conversation" });
          }
        });
        return { streamRequestId: `stream-${approvals.length}` };
      },
    );
    await withHarness({ get, startCompletionStream }, async ({ connection, directory, window }) => {
      vi.spyOn(connection, "control").mockResolvedValue({ servers: [] });
      Object.assign(window, { crypto: { randomUUID: () => "approval-response-id" } });
      const internals = connection as unknown as {
        binding: string;
        acceptRendererUpdate: (update: ChatGPTUpdate) => void;
      };
      Object.assign(window, {
        [internals.binding]: (payload: string) =>
          internals.acceptRendererUpdate(JSON.parse(payload) as ChatGPTUpdate),
      });
      const events: ChatGPTUpdate[] = [];
      connection.onUpdate((update) => {
        events.push(update);
        if (update.kind === "complete") completed.resolve();
        if (update.kind === "error") verificationFailed.resolve();
      });
      await connection.send("request", "Run Fedora", "gpt-6-thinking", directory);
      if (scenario !== "success") {
        await verificationFailed.promise;
        if (
          scenario === "reload-renderer" ||
          scenario === "stop-after-reload" ||
          scenario === "stop-during-recovery" ||
          scenario === "stopped-cache-reload"
        )
          delete window[Symbol.for("t3.chatgpt.streams.v1")];
        if (scenario === "older-runtime") {
          const state = (
            window[Symbol.for("t3.chatgpt.streams.v1")] as Map<
              string,
              { resumeCompletion?: unknown }
            >
          ).get("thread")!;
          delete state.resumeCompletion;
        }
        if (scenario === "passive-refresh") {
          await connection.readConversation();
          expect(approvals).toHaveLength(1);
        }
        if (
          scenario === "cancel-recovery" ||
          scenario === "stop-after-reload" ||
          scenario === "stopped-cache-reload"
        )
          await connection.stop("request");
        if (scenario === "manual-resume") {
          await connection.stop("request");
          canonicalRequestId = "replacement-request";
          await connection.send(canonicalRequestId, "Continue", "gpt-6-thinking", directory);
        } else if (scenario === "replace-connection" || scenario === "stopped-cache-reload") {
          const replacement = new ChatGPTConnection(connection.options);
          Object.assign(replacement, { renderer: Reflect.get(connection, "renderer") });
          await replacement.load();
          const replacementBinding = Reflect.get(replacement, "binding") as string;
          Object.assign(window, {
            [replacementBinding]: (payload: string) =>
              Reflect.get(replacement, "acceptRendererUpdate").call(
                replacement,
                JSON.parse(payload),
              ),
          });
          replacement.onUpdate((update) => {
            events.push(update);
            if (update.kind === "complete") completed.resolve();
          });
          connection.close();
          try {
            await replacement.readConversation("request");
            if (scenario === "replace-connection") await completed.promise;
          } finally {
            replacement.close();
            await Reflect.get(replacement, "writes");
          }
        } else if (scenario === "stop-during-recovery") {
          const recovering = connection.readConversation("request");
          await recoveryReading.promise;
          await connection.stop("request");
          recoveryRead.resolve();
          await recovering;
        } else await connection.readConversation("request");
        if (scenario === "uncertain-reload") {
          await approvalFailed.promise;
          delete window[Symbol.for("t3.chatgpt.streams.v1")];
          await connection.readConversation("request");
          expect(approvals).toHaveLength(2);
          expect(events.some((event) => event.kind === "complete")).toBe(false);
          return;
        }
        if (
          scenario === "cancel-recovery" ||
          scenario === "stop-after-reload" ||
          scenario === "stop-during-recovery" ||
          scenario === "stopped-cache-reload"
        ) {
          expect(approvals).toHaveLength(1);
          expect(events.some((event) => event.kind === "complete")).toBe(false);
          return;
        }
      }
      await completed.promise;
      expect(get).toHaveBeenCalledTimes(
        scenario === "success" || scenario === "stream-error" || scenario === "lost-completion"
          ? 1
          : scenario === "passive-refresh" || scenario === "manual-resume"
            ? 3
            : 2,
      );
      expect(approvals).toHaveLength(scenario === "manual-resume" ? 3 : 2);
      expect(approvals.at(-1)).toMatchObject({
        parent_message_id: "head-only-approval",
        messages: [
          {
            metadata: {
              jit_plugin_data: {
                from_client: {
                  target_message_id: "head-only-approval",
                  type: "always_allow",
                },
              },
            },
          },
        ],
      });
      expect(events.filter((event) => event.kind === "complete")).toEqual([
        expect.objectContaining({ requestId: canonicalRequestId }),
      ]);
    });
  });

  it("never resumes an approval after the owning turn is stopped during verification", async () => {
    const checking = Promise.withResolvers<void>();
    const approvalRead = Promise.withResolvers<unknown>();
    const get = vi.fn(() => {
      checking.resolve();
      return approvalRead.promise;
    });
    const startCompletionStream = vi.fn(
      (input: { onUpdate?: (value: unknown) => void; onComplete?: (value: unknown) => void }) => {
        queueMicrotask(() => {
          const message = {
            id: "approval-stopped",
            author: { role: "tool" },
            metadata: {
              jit_plugin_data: {
                from_server: {
                  type: "confirm_action",
                  body: {
                    codex_mcp_elicitation: { kind: "mcpToolCall", status: "pending" },
                    connector_id: "asdk_app_6ad23e985b608191984705f0c25f1ba3",
                    connector_name: "fedora_t3code",
                    link_id: "link_6ad23eb0b6cc819189b71f055d70599c",
                    params: {
                      path: "/asdk_app_6ad23e985b608191984705f0c25f1ba3/link_6ad23eb0b6cc819189b71f055d70599c/bootstrap_thread",
                      args: { thread_id: "thread" },
                    },
                    actions: [{ always_allow: { target_message_id: "approval-stopped" } }],
                  },
                },
              },
            },
          };
          input.onUpdate?.({ conversation_id: "new-conversation", message });
          input.onComplete?.({ conversation_id: "new-conversation" });
        });
        return { streamRequestId: "first-stream" };
      },
    );
    await withHarness({ get, startCompletionStream }, async ({ connection, directory, window }) => {
      vi.spyOn(connection, "control").mockResolvedValue({ servers: [] });
      Object.assign(window, { crypto: { randomUUID: () => "approval-response-id" } });
      await connection.send("request", "Run Fedora", "gpt-6-thinking", directory);
      await checking.promise;
      await connection.stop("request");
      approvalRead.resolve({
        conversation_id: "new-conversation",
        current_node: "approval-stopped",
        mapping: { "approval-stopped": { message: { id: "approval-stopped" } } },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(startCompletionStream).toHaveBeenCalledTimes(1);
    });
  });

  it("fails closed when a dispatching request loses renderer state", async () => {
    await withHarness({}, async ({ connection, window, stopCompletion, cancelStream }) => {
      await loadDispatches(connection, {
        request: { messageId: stableMessageId("request"), state: "dispatching" },
      });

      await expect(connection.stop("request")).rejects.toThrow("renderer state is unavailable");
      expect(stopCompletion).not.toHaveBeenCalled();
      expect(cancelStream).not.toHaveBeenCalled();
      const cancelled = window[Symbol.for("t3.chatgpt.cancelled.v1")] as Set<string>;
      expect(cancelled.has("request")).toBe(true);
    });
  });

  it("uses the cached conversation for the exact submitted request after renderer state is lost", async () => {
    await withHarness(
      {},
      async ({ connection, window, stopCompletion, cancelStream, directory }) => {
        await connection.adoptConversation("conversation");
        await connection.send("request", "Stop me", "gpt-6-thinking", directory);
        const streams = window[Symbol.for("t3.chatgpt.streams.v1")] as Map<string, unknown>;
        streams.delete("thread");

        await expect(connection.stop("request")).resolves.toBeUndefined();

        expect(stopCompletion).toHaveBeenCalledWith(nativeStopPayload);
        expect(cancelStream).not.toHaveBeenCalled();
      },
    );
  });

  it("does not let a rejected stream handle block native stop", async () => {
    await withHarness(
      {
        startCompletionStream: () => Promise.reject(new Error("stream setup failed")),
      },
      async ({ connection, stopCompletion, cancelStream, directory }) => {
        await connection.adoptConversation("conversation");
        await connection.send("request", "Stop me", "gpt-6-thinking", directory);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(connection.stop("request")).resolves.toBeUndefined();

        expect(stopCompletion).toHaveBeenCalledWith(nativeStopPayload);
        expect(cancelStream).not.toHaveBeenCalled();
      },
    );
  });
});

describe("ChatGPT image and project submissions", () => {
  it("uploads actual image bytes, sends a multimodal request, and keeps the destination after reload", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-wire-"));
    const imagePath = NodePath.join(directory, "fixture.png");
    const bytes = Buffer.from("png fixture bytes");
    await NodeFSP.writeFile(imagePath, bytes);
    const requests: Array<{
      gizmo_id?: string;
      thinking_effort?: string;
      parent_message_id?: string;
      messages: Array<{ content: { content_type: string; parts: unknown[] } }>;
    }> = [];
    let processed = 0;
    const client = {
      get: async () => ({ current_node: "canonical-parent", gizmo_id: "g-p-selected" }),
      list: async () => ({}),
      models: async () => ({}),
      createUpload: async () => ({
        file_id: "file_example",
        upload_url: "https://sdmntpr.oaiusercontent.com/file?sig=example",
      }),
      finishUpload: async () => {
        processed++;
      },
      startCompletionStream: (input: { request: (typeof requests)[number] }) => {
        requests.push(input.request);
        return {};
      },
    };
    const window: Record<symbol | string, unknown> = {
      [Symbol.for("terminal-mcp.chat-runtime.client.v5")]: client,
    };
    const storage = new Map<string, string>();
    Object.assign(window, {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
      },
    });
    class Image {
      naturalWidth = 300;
      naturalHeight = 200;
      onload?: () => void;
      set src(_value: string) {
        this.onload?.();
      }
    }
    const renderer = {
      evaluate: async (expression: string) =>
        NodeVM.runInNewContext(expression, {
          window,
          Image,
          Symbol,
          Map,
          Set,
          Date,
          Intl,
          URL,
          AbortController,
        }),
    };
    const options = {
      orchestrationCommand: "test-orchestration-command",
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "thread",
      cacheDir: directory,
    };
    const connection = new ChatGPTConnection(options);
    const inventory = vi.spyOn(connection, "control").mockResolvedValue({
      servers: [{ name: "browser-tools", transport: "stdio", status: "configured" }],
    });
    Object.assign(connection, { renderer: async () => renderer });
    const upload = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      expect(Buffer.from(options!.body as Uint8Array)).toEqual(bytes);
      expect(options?.headers).toMatchObject({
        "x-ms-blob-type": "BlockBlob",
        "content-type": "image/png",
      });
      return new Response(null, { status: 201 });
    });
    try {
      const images = [
        { id: "stored-image", name: "fixture.png", mimeType: "image/png", path: imagePath },
      ];
      await connection.send(
        "request-image",
        "Read this image",
        "gpt-6-thinking",
        directory,
        "extended",
        images,
        "g-p-selected",
      );
      expect(requests[0]).toMatchObject({
        gizmo_id: "g-p-selected",
        conversation_mode: { kind: "gizmo_interaction", gizmo_id: "g-p-selected" },
        thinking_effort: "extended",
        messages: [
          {
            content: {
              content_type: "multimodal_text",
              parts: [
                {
                  content_type: "image_asset_pointer",
                  asset_pointer: "sediment://file_example",
                  width: 300,
                  height: 200,
                },
                expect.stringContaining("Read this image"),
              ],
            },
          },
        ],
      });
      expect(JSON.stringify(requests[0])).not.toContain(imagePath);
      await connection.adoptConversation("upstream-conversation");
      await connection.send(
        "follow-up",
        "Read it again",
        "gpt-6-thinking",
        directory,
        "standard",
        images,
      );
      expect(JSON.stringify(requests[0])).toContain("test-orchestration-command");
      expect(JSON.stringify(requests[1])).toContain("test-orchestration-command");
      expect(JSON.stringify(requests[0])).toContain('\\"name\\":\\"browser-tools\\"');
      expect(JSON.stringify(requests[1])).toContain('\\"name\\":\\"browser-tools\\"');
      expect(inventory).toHaveBeenCalledTimes(2);
      expect(inventory).toHaveBeenCalledWith("mcp-inventory", {}, expect.any(AbortSignal));
      expect(requests[1]?.parent_message_id).toBe("canonical-parent");
      expect(requests[1]?.gizmo_id).toBe("g-p-selected");
      expect(upload).toHaveBeenCalledTimes(1);
      expect(processed).toBe(1);
      const reopened = new ChatGPTConnection(options);
      Object.assign(reopened, { renderer: async () => renderer });
      await reopened.load();
      await expect(
        reopened.send(
          "wrong-project",
          "test",
          "gpt-6-thinking",
          directory,
          undefined,
          [],
          "g-p-other",
        ),
      ).rejects.toThrow("bound to another ChatGPT project");
      expect(JSON.parse(await NodeFSP.readFile(reopened.cachePath, "utf8")).projectId).toBe(
        "g-p-selected",
      );
    } finally {
      upload.mockRestore();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ChatGPT conversation reconciliation", () => {
  it("reads one active branch, restores the final answer, and rejects other submissions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-refresh-"));
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "thread",
      cacheDir: directory,
    });
    const snapshot = {
      async_status: null as string | null,
      current_node: "final",
      mapping: {
        user: {
          parent: null,
          message: {
            id: stableMessageId("request"),
            author: { role: "user" },
            content: { parts: ["T3 execution context and prompt"] },
          },
        },
        final: {
          parent: "user",
          message: {
            id: "native-final",
            author: { role: "assistant" },
            channel: "final",
            recipient: "all",
            status: "finished_successfully",
            end_turn: true,
            create_time: 1234,
            content: { parts: ["Recovered answer"] },
          },
        },
        sibling: {
          parent: "user",
          message: {
            id: "other-branch",
            author: { role: "assistant" },
            channel: "final",
            content: { parts: ["Wrong branch"] },
          },
        },
      },
    };
    const get = vi.fn(async () => ({ conversation: snapshot }));
    const client = { get, list() {}, models() {}, startCompletionStream: vi.fn() };
    const window = { [Symbol.for("terminal-mcp.chat-runtime.client.v5")]: client };
    Object.assign(connection, {
      renderer: async () => ({
        evaluate: (expression: string) =>
          NodeVM.runInNewContext(expression, { window, Symbol, Map, Set }),
      }),
    });
    try {
      await NodeFSP.writeFile(
        connection.cachePath,
        JSON.stringify({
          conversationId: "conversation",
          messages: {},
          dispatches: { request: { messageId: stableMessageId("request"), state: "submitted" } },
          handledEvents: [],
        }),
      );
      await connection.load();
      expect(connection.latestSubmittedRequestId).toBe("request");
      const recovered = await connection.readCompletion("request");
      expect(get).toHaveBeenCalledTimes(1);
      expect(recovered).toMatchObject([
        {
          kind: "update",
          requestId: "request",
          messageId: "native-final",
          text: "Recovered answer",
          createdAt: 1234,
        },
        { kind: "complete", requestId: "request" },
      ]);
      expect(client.startCompletionStream).not.toHaveBeenCalled();
      // GenUI may end with a hidden copy; recover the canonical visible answer.
      Object.assign(snapshot.mapping, { hidden: {
        parent: "final", message: { ...snapshot.mapping.final.message,
          id: "hidden-ending", metadata: { is_visually_hidden_from_conversation: true },
        },
      } });
      snapshot.current_node = "hidden";
      expect(await connection.readCompletion("request")).toMatchObject([
        { messageId: "native-final", text: "Recovered answer" }, { kind: "complete" },
      ]);
      snapshot.current_node = "final";
      snapshot.async_status = "running";
      expect(await connection.readCompletion("request")).toBeNull();
      snapshot.async_status = null;
      snapshot.mapping.final.message.end_turn = false;
      expect(await connection.readCompletion("request")).toBeNull();
      snapshot.mapping.final.message.end_turn = true;
      snapshot.mapping.user.message.id = "some-other-user-submission";
      expect(await connection.readCompletion("request")).toBeNull();
      expect((await connection.readConversation()).updates).toEqual([]);
      snapshot.mapping.final.parent = "final";
      await expect(connection.readConversation()).rejects.toThrow("ancestry is invalid");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ChatGPT handoff submission boundary", () => {
  it("distinguishes failure before dispatch from uncertain native failure", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "chatgpt-handoff-phase-"),
    );
    try {
      const make = (threadId: string) =>
        new ChatGPTConnection({
          cdpEndpoint: "http://127.0.0.1:9234",
          controlEndpoint: "http://127.0.0.1:8022",
          token: "test",
          environmentId: "test",
          providerId: "chatgpt",
          threadId,
          cacheDir: directory,
        });
      const pre = make("pre");
      Object.assign(pre, {
        renderer: async () => {
          throw new Error("renderer unavailable");
        },
      });
      await expect(pre.send("pre", "history", "model", "/tmp")).rejects.toBeInstanceOf(
        ChatGPTSubmissionNotStartedError,
      );
      let submitted = 0;
      Object.assign(pre, {
        renderer: async () => ({
          evaluate: async () => {
            submitted++;
            return { submitted: true };
          },
        }),
      });
      await pre.send("pre", "history", "model", "/tmp");
      await pre.send("pre", "history", "model", "/tmp");
      expect(submitted).toBe(1);
      const post = make("post");
      Object.assign(post, {
        renderer: async () => ({
          evaluate: async () => {
            throw new Error("submission uncertain");
          },
        }),
      });
      await expect(post.send("post", "history", "model", "/tmp")).rejects.not.toBeInstanceOf(
        ChatGPTSubmissionNotStartedError,
      );
      const dispatches = Reflect.get(post, "cache").dispatches;
      expect(dispatches.post.state).toBe("dispatching");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("ignores old renderer callbacks without request IDs after a native reset", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "chatgpt-wire-reset-"));
    const bindings: string[] = [];
    const sockets: EventTarget[] = [];
    class TestSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 1;
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(raw: string) {
        const command = JSON.parse(raw);
        if (command.method === "Runtime.addBinding") bindings.push(command.params.name);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ id: command.id, result: command.method === "Runtime.evaluate" ? { result: { value: true } } : {} }),
            }),
          ),
        );
      }
      close() {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", TestSocket);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            type: "page",
            url: "https://chatgpt.com/",
            webSocketDebuggerUrl: "ws://127.0.0.1/test",
          },
        ]),
        { status: 200 },
      ),
    );
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "reset-wire",
      cacheDir: directory,
    });
    try {
      await connection.adoptConversation("poisoned");
      await connection.health();
      const oldBinding = bindings[0]!;
      Object.assign(connection, { control: async () => ({ conversation_id: null }) });
      await connection.resetNativeConversation();
      const updates: ChatGPTUpdate[] = [];
      connection.onUpdate((update) => updates.push(update));
      const publish = (name: string, conversationId: string) =>
        sockets[0]!.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name,
                payload: JSON.stringify({ kind: "complete", conversationId }),
              },
            }),
          }),
        );
      publish(oldBinding, "poisoned");
      await Reflect.get(connection, "deliveryBarrier");
      expect(connection.conversationId).toBeNull();
      expect(updates).toHaveLength(0);
      expect(bindings[1]).not.toBe(oldBinding);
      publish(bindings[1]!, "replacement");
      await Reflect.get(connection, "deliveryBarrier");
      expect(connection.conversationId).toBe("replacement");
      expect(updates).toHaveLength(1);
    } finally {
      connection.close();
      fetch.mockRestore();
      vi.unstubAllGlobals();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("persists the reset when the renderer cannot register the rotated binding", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "chatgpt-reset-binding-error-"),
    );
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "reset-binding-error",
      cacheDir: directory,
    });
    try {
      await connection.adoptConversation("poisoned");
      Reflect.get(connection, "cache").dispatches.old = {
        state: "submitted", messageId: stableMessageId("old"),
      };
      let closed = false;
      Object.assign(connection, {
        control: async () => ({ conversation_id: null }),
        cdp: {
          call: async () => { throw new Error("renderer disconnected"); },
          close: () => { closed = true; },
        },
      });
      await connection.resetNativeConversation();
      expect(connection.conversationId).toBeNull();
      expect(Reflect.get(connection, "cdp")).toBeUndefined();
      expect(Reflect.get(connection, "retiredRequestIds").has("old")).toBe(true);
      expect(closed).toBe(true);
    } finally {
      connection.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not close a replacement renderer when the previous binding registration fails", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "chatgpt-reset-renderer-race-"),
    );
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: "test",
      environmentId: "test",
      providerId: "chatgpt",
      threadId: "reset-renderer-race",
      cacheDir: directory,
    });
    try {
      await connection.adoptConversation("poisoned");
      let rejectOld!: (cause: Error) => void;
      let oldCalled!: () => void;
      const oldStarted = new Promise<void>((resolve) => {
        oldCalled = resolve;
      });
      const oldCall = new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      });
      let oldClosed = false;
      let replacementClosed = false;
      const oldRenderer = {
        call: async () => {
          oldCalled();
          await oldCall;
        },
        close: () => {
          oldClosed = true;
        },
      };
      const replacement = {
        call: async () => {},
        close: () => {
          replacementClosed = true;
        },
      };
      Object.assign(connection, {
        control: async () => ({ conversation_id: null }),
        cdp: oldRenderer,
      });
      const reset = connection.resetNativeConversation();
      await oldStarted;
      Object.assign(connection, { cdp: replacement });
      rejectOld(new Error("old registration failed"));
      await reset;
      expect(Reflect.get(connection, "cdp")).toBe(replacement);
      expect(oldClosed).toBe(false);
      expect(replacementClosed).toBe(false);
      expect(connection.conversationId).toBeNull();
    } finally {
      connection.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a fresh native reset without terminal detachment, and fences retired streams", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "chatgpt-handoff-reset-"),
    );
    try {
      const connection = new ChatGPTConnection({
        cdpEndpoint: "http://127.0.0.1:9234",
        controlEndpoint: "http://127.0.0.1:8022",
        token: "test",
        environmentId: "test",
        providerId: "chatgpt",
        threadId: "reset",
        cacheDir: directory,
      });
      await connection.adoptConversation("poisoned");
      const cache = Reflect.get(connection, "cache");
      cache.dispatches.old = { state: "submitted", messageId: stableMessageId("old") };
      const resetRequests: unknown[] = [];
      Object.assign(connection, {
        control: async (action: string, body: unknown) => {
          resetRequests.push({ action, body });
          return { conversation_id: "poisoned" };
        },
      });
      await expect(connection.resetNativeConversation()).rejects.toThrow("did not detach");
      expect(connection.conversationId).toBe("poisoned");
      expect(resetRequests).toEqual([
        {
          action: "reset",
          body: { expectedConversationId: "poisoned" },
        },
      ]);
      Object.assign(connection, { control: async () => ({ conversation_id: null }) });
      await connection.resetNativeConversation();
      expect(connection.conversationId).toBeNull();
      const updates: ChatGPTUpdate[] = [];
      connection.onUpdate((update) => updates.push(update));
      Reflect.get(connection, "acceptRendererUpdate").call(connection, {
        kind: "update",
        requestId: "old",
        conversationId: "poisoned",
      });
      expect(connection.conversationId).toBeNull();
      expect(updates).toHaveLength(0);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
