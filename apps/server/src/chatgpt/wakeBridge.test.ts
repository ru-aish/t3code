// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  prepareChatGPTWakeBridge,
  removeChatGPTWakeBridge,
  wakeBridgeInstructions,
} from "./wakeBridge.ts";

describe("ChatGPT packaged wake bridge", () => {
  it("keeps the MCP credential in a private local config and only puts its path in the prompt", async () => {
    const cacheDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-wake-"));
    const threadId = ThreadId.make("thread:wake-bridge");
    try {
      const bridge = await prepareChatGPTWakeBridge({
        cacheDir,
        threadId,
        session: {
          environmentId: EnvironmentId.make("environment:test"),
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("chatgpt"),
          endpoint: "http://127.0.0.1:3773/mcp",
          authorizationHeader: "Bearer super-secret",
          browserToolsAvailable: true,
        },
        selfInvocation: { command: "/opt/T3 Code/t3", entrypoint: "/opt/T3 Code/bin.mjs" },
      });
      const config = JSON.parse(await NodeFSP.readFile(bridge.configPath, "utf8"));
      expect(config).toEqual({
        endpoint: "http://127.0.0.1:3773/mcp",
        authorization: "Bearer super-secret",
      });
      if (process.platform !== "win32") {
        expect((await NodeFSP.stat(bridge.configPath)).mode & 0o777).toBe(0o600);
      }
      const prompt = wakeBridgeInstructions(bridge);
      expect(prompt).toContain("chatgpt-wake-call");
      expect(prompt).toContain("schedule_continue");
      expect(prompt).toContain("continue_after_process");
      expect(prompt).toContain(bridge.configPath);
      expect(prompt).not.toContain("super-secret");
      expect(prompt).not.toContain("127.0.0.1:3773");
      expect(prompt).toContain("'/opt/T3 Code/t3'");
      expect(prompt).toContain("'/opt/T3 Code/bin.mjs'");

      await removeChatGPTWakeBridge(cacheDir, threadId);
      await expect(NodeFSP.stat(bridge.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
