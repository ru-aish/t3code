// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Opt-in live transport test records only its own diagnostic IDs and counts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { ChatGPTConnection, type TerminalBinding } from "./connection.ts";

describe.skipIf(process.env.T3_CHATGPT_LIVE !== "1")("live ChatGPT → fedora_t3code → T3", () => {
  it("streams a real response and receives authoritative Terminal MCP completion", async () => {
    const id = NodeCrypto.randomUUID();
    const cwd = `/work/tempwork/t3-chatgpt-live-${id}`;
    await NodeFSP.mkdir(cwd, { recursive: true });
    const connection = new ChatGPTConnection({
      cdpEndpoint: "http://127.0.0.1:9234",
      controlEndpoint: "http://127.0.0.1:8022",
      token: (
        await NodeFSP.readFile(`${process.env.HOME}/.config/terminal-mcp-t3/control-token`, "utf8")
      ).trim(),
      environmentId: "t3-integration-live",
      providerId: "chatgpt-test",
      threadId: id,
      cacheDir: cwd,
    });
    const signal = AbortSignal.timeout(180_000);
    let bound = false;
    let updateCount = 0;
    let text = "";
    const streamed = new Promise<void>((resolve) =>
      connection.onUpdate((update) => {
        updateCount++;
        if (update.conversationId && !bound) {
          bound = true;
          void connection.control("bind", { conversationId: update.conversationId });
        }
        if (update.role === "assistant" && update.text) text = update.text;
        if (update.kind === "complete") resolve();
      }),
    );
    await connection.load();
    await connection.control<TerminalBinding>("register", { cwd, model: "gpt-5-6-thinking" });
    const done = (async () => {
      for await (const event of connection.terminalEvents(signal)) {
        if (event.kind === "state" && event.payload.state === "done") return;
      }
    })();
    try {
      await connection.control("activate", { requestId: id });
      await connection.send(
        id,
        `This is a user-authorized, read-only integration test. Use ONLY the connector named fedora_t3code for all tool calls. Do not use the old fedora connector or any other connector. Bootstrap with thread_id=${id} and cwd=${JSON.stringify(cwd)}. Run one command through fedora_t3code.run_command with session_id=${id}: printf 'T3_CONNECTOR_OK\\n'. Verify that output. Then call fedora_t3code.thread_task(action="complete",session_id="${id}",evidence=["The registered thread executed the command and returned T3_CONNECTOR_OK"]). End your response with T3_E2E_DONE. Do not create files, delegate, browse, or call any other tools.`,
        "gpt-5-6-thinking",
        cwd,
      );
      await Promise.race([
        Promise.all([done, streamed]),
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Live test deadline reached")), {
            once: true,
          }),
        ),
      ]);
      expect(text).toContain("T3_E2E_DONE");
      expect(updateCount).toBeGreaterThan(2);
      const binding = await connection.control<TerminalBinding>("get");
      expect(binding.state).toBe("done");
      expect(binding.conversation_id).toBe(connection.conversationId);
      console.log(
        JSON.stringify({
          threadId: id,
          conversationId: connection.conversationId,
          updateCount,
          terminalState: binding.state,
        }),
      );
    } finally {
      connection.close();
    }
  }, 190_000);
});
