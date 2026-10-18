// @effect-diagnostics nodeBuiltinImport:off -- CLI boundary reads a private session credential and writes the MCP result.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { callAcpMcpTool } from "../mcp/AcpMcpStdioBridge.ts";

import { ChatGPTMcpCredential } from "./mcpBridge.ts";
const decodeArguments = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeCredential = Schema.decodeSync(ChatGPTMcpCredential);

export async function runChatGPTMcpCall(args: ReadonlyArray<string>): Promise<void> {
  const [credentialPath, tool, argumentsJson] = args;
  if (!credentialPath || !tool || argumentsJson === undefined) {
    process.stderr.write("chatgpt-mcp-call requires <session-file> <tool> <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  const credential = decodeCredential(await NodeFSP.readFile(credentialPath, "utf8"));
  const input = decodeArguments(argumentsJson);
  const result = await Effect.runPromise(callAcpMcpTool({ ...credential, tool, arguments: input }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
