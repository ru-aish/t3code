// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Opt-in live transport test records only its own diagnostic IDs and counts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { ChatGPTConnection, type ChatGPTUpdate, type TerminalBinding } from "./connection.ts";

describe.skipIf(process.env.T3_CHATGPT_LIVE !== "1")("live ChatGPT → fedora_t3code → T3", () => {
  it("finishes a reply-only turn and a terminal-tool turn in the same ChatGPT conversation", async () => {
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
    let bound: Promise<unknown> | undefined;
    const updates: ChatGPTUpdate[] = [];
    const completions = new Map<string, () => void>();
    const streamed = (requestId: string) =>
      new Promise<void>((resolve) => {
        completions.set(requestId, resolve);
      });
    connection.onUpdate((update) => {
      updates.push(update);
      if (update.conversationId && !bound)
        bound = connection.control("bind", { conversationId: update.conversationId });
      if (update.kind === "complete" && update.requestId) completions.get(update.requestId)?.();
    });
    const done = (async () => {
      for await (const event of connection.terminalEvents(signal)) {
        if (event.kind === "state" && event.payload.state === "done") return;
      }
    })();
    const withinDeadline = async (promise: Promise<unknown>) => {
      await Promise.race([
        promise,
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Live test deadline reached")), {
            once: true,
          }),
        ),
      ]);
    };
    try {
      await connection.load();
      await connection.control<TerminalBinding>("register", { cwd, model: "gpt-5-6-thinking" });

      const replyRequest = id + "-reply";
      const firstStream = streamed(replyRequest);
      await connection.control("activate", { requestId: replyRequest });
      await connection.send(
        replyRequest,
        "Reply with exactly Y and do not call any tools. This is an end-to-end response-only test.",
        "gpt-5-6-thinking",
        cwd,
      );
      await withinDeadline(firstStream);
      if (bound) await bound;
      expect(
        updates.some(
          (update) =>
            update.requestId === replyRequest &&
            update.channel === "final" &&
            update.text?.includes("Y"),
        ),
      ).toBe(true);
      const replyState = await connection.control<TerminalBinding>("get");
      expect(replyState.state).not.toBe("done");

      const toolRequest = id + "-tool";
      const secondStream = streamed(toolRequest);
      await connection.control("activate", { requestId: toolRequest });
      await connection.send(
        toolRequest,
        `Run printf 'T3_CONNECTOR_OK\\n' using fedora_t3code.run_command (bootstrap first with thread_id=${id} and cwd=${JSON.stringify(cwd)}). Verify the result. Call fedora_t3code.thread_task(action="complete",session_id="${id}",evidence=["Confirmed T3_CONNECTOR_OK"]). Then reply exactly Y. Do not use other tools.`,
        "gpt-5-6-thinking",
        cwd,
      );
      await withinDeadline(Promise.all([secondStream, done]));
      expect(
        updates.some(
          (update) =>
            update.requestId === toolRequest &&
            update.channel === "final" &&
            update.text?.includes("Y"),
        ),
      ).toBe(true);
      const binding = await connection.control<TerminalBinding>("get");
      expect(binding.state).toBe("done");
      expect(binding.conversation_id).toBe(connection.conversationId);
      console.log(
        JSON.stringify({
          replyUpdates: updates.filter((update) => update.requestId === replyRequest).length,
          toolUpdates: updates.filter((update) => update.requestId === toolRequest).length,
          replyChannels: [
            ...new Set(
              updates
                .filter((update) => update.requestId === replyRequest)
                .map((update) => update.channel)
                .filter(Boolean),
            ),
          ],
          toolChannels: [
            ...new Set(
              updates
                .filter((update) => update.requestId === toolRequest)
                .map((update) => update.channel)
                .filter(Boolean),
            ),
          ],
          terminalState: binding.state,
        }),
      );
    } finally {
      connection.close();
    }
  }, 190_000);
});
