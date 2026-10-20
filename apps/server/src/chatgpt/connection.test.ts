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
              expect(expression).toContain('conversationId:"existing-conversation"');
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
      const stopping = connection.stop();
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
      const stopping = connection.stop();
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
        NodeVM.runInNewContext(expression, { window, Image, Symbol, Map, Set, Date, Intl, URL }),
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
      Object.assign(connection, { control: async () => ({ conversation_id: "poisoned" }) });
      await expect(connection.resetNativeConversation()).rejects.toThrow("did not detach");
      expect(connection.conversationId).toBe("poisoned");
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
