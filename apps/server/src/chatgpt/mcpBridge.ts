import type { ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { hostShellWord } from "../cli/invocation.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const ChatGPTMcpCredential = Schema.fromJsonString(
  Schema.Struct({ endpoint: Schema.String, authorization: Schema.String }),
);

const encodeCredential = Schema.encodeSync(ChatGPTMcpCredential);

// ChatGPT cannot attach a local MCP server to its hosted runtime. Its Terminal
// connector can execute this authenticated client on the environment instead.
export const make = Effect.gen(function* () {
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const self = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  return Effect.fn("ChatGPTMcpBridge.attach")(function* (threadId: ThreadId, cacheDir: string) {
    const session = yield* sessions.read(threadId);
    if (session === undefined) return undefined;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    const directory = yield* fs.makeTempDirectoryScoped({ directory: cacheDir, prefix: "mcp-" });
    const credentialPath = path.join(directory, "session.json");
    const refresh = Effect.gen(function* () {
      const current = yield* sessions.read(threadId);
      // Never leave a revoked credential usable by the launcher.
      if (current === undefined) {
        yield* fs.remove(credentialPath, { force: true });
        return;
      }
      yield* fs.writeFileString(
        credentialPath,
        encodeCredential({
          endpoint: current.endpoint,
          authorization: current.authorizationHeader,
        }),
        { mode: 0o600 },
      );
    });
    yield* refresh;
    const invocation = [
      self.command,
      ...selfInvocationArgs(self, ["chatgpt-mcp-call", credentialPath]),
    ]
      .map((part) => hostShellWord(platform, part))
      .join(" ");
    const command =
      platform === "win32"
        ? `& { $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE; $exitCode = 1; try { if ($args.Count -lt 2) { throw 'T3 MCP bridge requires <tool> <arguments-json>.' }; $env:ELECTRON_RUN_AS_NODE='1'; $argumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$args[1])); & ${invocation} ([string]$args[0]) --arguments-base64 $argumentsBase64; $exitCode = $LASTEXITCODE } finally { if ($null -eq $previousElectronRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode } }; $global:LASTEXITCODE = $exitCode; if ($exitCode -ne 0) { throw "T3 MCP bridge failed with exit code $exitCode." } }`
        : `env ELECTRON_RUN_AS_NODE=1 ${invocation}`;
    return { command, refresh };
  });
});

export function orchestrationPrompt(command: string, threadId: string): string {
  return `\n[T3 orchestration tools]\nT3 owns delegated agents and automatically delivers their results to this thread. Through your Terminal MCP command tool, run ${command} <tool> <arguments-json>, shell-quoting the JSON as one argument. Use PowerShell on Windows and a POSIX shell on macOS/Linux on this T3 environment machine. Call orchestrator_capabilities with {} for available providers and models. The authenticated bridge already identifies this parent; do not register a parent or use Terminal MCP's agent registry.\nControls: agents_available = orchestrator_capabilities {}; spawn_agent = delegate_task {"task":"self-contained brief","title":"short title","target":{"providerInstanceId":"catalog id","model":"catalog model"},"clientRequestId":"unique per task, stable on retry"}; agent_status = task_status {"taskId":"returned taskId"}; send_input = t3_thread_send {"threadId":"returned childThreadId","message":"follow-up","mode":"auto"}; close_agent = task_cancel {"taskId":"returned taskId"}; list_agents = t3_thread_read with view="activity" with threadId=${JSON.stringify(threadId)}. Omit target to inherit provider/model. taskId is the delegated task handle; childThreadId is its separate conversation ID.\nSpawn is async by default. Continue independent work or end your turn. T3 automatically wakes/continues this thread when children complete, including across providers. Do not poll, wait, or start watcher processes. Use task_status only if a result is needed during your current turn. Follow-ups to completed children return a fresh taskId and automatically deliver that result too. These app-owned controls are separate from provider-native subagents.\n[/T3 orchestration tools]\n`;
}
