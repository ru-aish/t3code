// @effect-diagnostics nodeBuiltinImport:off -- Wire tests exercise real binary files and serialized renderer code.
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

  it("advertises the packaged self-wake helper without placing MCP credentials in the prompt", () => {
    const compiled = executionPrompt("registered-id", "/work/project", "start work", {
      command: "/opt/T3 Code/t3",
      entrypoint: "/opt/T3 Code/bin.mjs",
      configPath: "/home/user/.t3/wake bridge.json",
    });
    expect(compiled).toContain("chatgpt-wake-call");
    expect(compiled).toContain("schedule_continue");
    expect(compiled).toContain("continue_after_process");
    expect(compiled).toContain("'/home/user/.t3/wake bridge.json'");
    expect(compiled).not.toContain("T3_ACP_MCP_AUTHORIZATION");
    expect(compiled).not.toContain("Bearer ");
    expect(compiled.endsWith("\n\nstart work")).toBe(true);
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
