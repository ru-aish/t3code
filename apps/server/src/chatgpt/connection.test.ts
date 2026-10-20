// @effect-diagnostics nodeBuiltinImport:off -- Wire tests exercise real binary files and serialized renderer code.
import { OrchestratorMcpThreadSendInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatGPTConnection,
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

describe("ChatGPT submission identity", () => {
  it("uses the same valid upstream message ID for a retried durable request", () => {
    expect(stableMessageId("request-one")).toBe(stableMessageId("request-one"));
    expect(stableMessageId("request-one")).not.toBe(stableMessageId("request-two"));
    expect(stableMessageId("request-one")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
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
    startCompletionStream?: (input: { startupSignal?: AbortSignal }) => unknown;
    stopCompletion?: (...args: unknown[]) => Promise<void>;
    cancelStream?: (streamRequestId: string) => void;
    streams?: Map<string, unknown>;
  };

  const makeHarness = async (options: InterruptHarnessOptions = {}) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-stop-"));
    const stopCompletion = options.stopCompletion ?? vi.fn(async () => {});
    const cancelStream = options.cancelStream ?? vi.fn();
    const startCompletionStream =
      options.startCompletionStream ?? vi.fn(() => Promise.resolve({ streamRequestId: "stream-1" }));
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
      cleanup: () => NodeFSP.rm(directory, { recursive: true, force: true }),
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

          expect(stopCompletion).toHaveBeenCalledWith(nativeStopPayload);
          await stopping;
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
    await withHarness({ streams }, async ({ connection, stopCompletion, cancelStream }) => {
      await loadDispatches(connection, {
        "request-a": { messageId: stableMessageId("request-a"), state: "submitted" },
        "request-b": { messageId: stableMessageId("request-b"), state: "dispatching" },
      });

      await expect(connection.stop("request-a")).rejects.toThrow(
        "another request owns the renderer stream",
      );
      expect(stopCompletion).not.toHaveBeenCalled();
      expect(cancelStream).not.toHaveBeenCalled();
    });
  });

  it("does not use cached fallback while another request is dispatching", async () => {
    await withHarness({}, async ({ connection, stopCompletion, cancelStream }) => {
      await loadDispatches(connection, {
        "request-a": { messageId: stableMessageId("request-a"), state: "submitted" },
        "request-b": { messageId: stableMessageId("request-b"), state: "dispatching" },
      });

      await expect(connection.stop("request-a")).rejects.toThrow("renderer state is unavailable");
      expect(stopCompletion).not.toHaveBeenCalled();
      expect(cancelStream).not.toHaveBeenCalled();
    });
  });

  it("fails closed when a dispatching request loses renderer state", async () => {
    await withHarness({}, async ({ connection, stopCompletion, cancelStream }) => {
      await loadDispatches(connection, {
        request: { messageId: stableMessageId("request"), state: "dispatching" },
      });

      await expect(connection.stop("request")).rejects.toThrow("renderer state is unavailable");
      expect(stopCompletion).not.toHaveBeenCalled();
      expect(cancelStream).not.toHaveBeenCalled();
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
