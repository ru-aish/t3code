// @effect-diagnostics nodeBuiltinImport:off -- ChatGPT bridge credentials are local files consumed by the packaged self-invocation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Schema from "effect/Schema";

export interface ChatGPTWakeBridge {
  readonly command: string;
  readonly entrypoint?: string;
  readonly configPath: string;
}

export class ChatGPTWakeBridgeError extends Schema.TaggedError<ChatGPTWakeBridgeError>()(
  "ChatGPTWakeBridgeError",
  {
    operation: Schema.Literals(["prepare", "cleanup"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the packaged ChatGPT wake bridge.`;
  }
}

interface WakeBridgeConfig {
  readonly endpoint: string;
  readonly authorization: string;
}

function wakeBridgeConfigPath(cacheDir: string, threadId: ThreadId): string {
  const digest = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return NodePath.join(cacheDir, "wake-bridge", `${digest}.json`);
}

export async function prepareChatGPTWakeBridge(input: {
  readonly cacheDir: string;
  readonly threadId: ThreadId;
  readonly session: McpProviderSessionConfig;
  readonly selfInvocation: SelfInvocation;
}): Promise<ChatGPTWakeBridge> {
  const directory = NodePath.join(input.cacheDir, "wake-bridge");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(directory, 0o700);
  const configPath = wakeBridgeConfigPath(input.cacheDir, input.threadId);
  const temporary = `${configPath}.${NodeCrypto.randomUUID()}.tmp`;
  const config: WakeBridgeConfig = {
    endpoint: input.session.endpoint,
    authorization: input.session.authorizationHeader,
  };
  await NodeFSP.writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await NodeFSP.rename(temporary, configPath);
  await NodeFSP.chmod(configPath, 0o600);
  return {
    command: input.selfInvocation.command,
    ...(input.selfInvocation.entrypoint === undefined
      ? {}
      : { entrypoint: input.selfInvocation.entrypoint }),
    configPath,
  };
}

export async function removeChatGPTWakeBridge(cacheDir: string, threadId: ThreadId): Promise<void> {
  await NodeFSP.rm(wakeBridgeConfigPath(cacheDir, threadId), { force: true });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function wakeBridgeCommandPrefix(bridge: ChatGPTWakeBridge): string {
  const invocation = [
    bridge.command,
    ...(bridge.entrypoint === undefined ? [] : [bridge.entrypoint]),
    "chatgpt-wake-call",
    bridge.configPath,
  ]
    .map(shellQuote)
    .join(" ");
  return `ELECTRON_RUN_AS_NODE=1 ${invocation}`;
}

export function wakeBridgeInstructions(bridge: ChatGPTWakeBridge): string {
  const prefix = wakeBridgeCommandPrefix(bridge);
  return `
[T3 packaged wake tools]
To wake this same T3 thread later, use fedora_t3code.run_command with the packaged helper below. Never pass a thread id.
- Relative time: ${prefix} schedule_continue '{"afterSeconds":30}'
- Exact time: ${prefix} schedule_continue '{"wakeAt":"2026-10-18T14:30:00+05:30"}'
- Background process: after fedora_t3code.start_process returns the real OS PID, run ${prefix} continue_after_process '{"pid":12345}'. Use the PID, not the opaque process_id.
Replace the example values with the intended delay/time/PID. After registering a wakeup, end the current turn instead of polling.
[/T3 packaged wake tools]`;
}
