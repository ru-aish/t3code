// @effect-diagnostics nodeBuiltinImport:off -- Exercises the generated Windows PowerShell bridge against the real CLI.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Bridge from "./mcpBridge.ts";

const powerShell = ["pwsh", "powershell.exe"].find(
  (command) =>
    NodeChildProcess.spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      stdio: "ignore",
    }).status === 0,
);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const serverBinPath = NodePath.resolve(import.meta.dirname, "../bin.ts");
const threadId = ThreadId.make("windows-parent");
const session = {
  environmentId: EnvironmentId.make("test-environment"),
  providerInstanceId: ProviderInstanceId.make("chatgpt"),
  threadId,
  providerSessionId: "windows-session",
  endpoint: "http://127.0.0.1/mcp",
  authorizationHeader: "Bearer private-test-credential",
  browserToolsAvailable: false,
};
const layer = Layer.merge(NodeServices.layer, McpProviderSessions.layer);
const withInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, serverBinPath]),
    Effect.provideService(HostProcess.ExecutablePath, process.execPath),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.Platform, "win32"),
  );
const encodedCommand = (source: string) => Buffer.from(source, "utf16le").toString("base64");

describe("ChatGPT Windows orchestration bridge", () => {
  it.effect.skipIf(powerShell === undefined)(
    "preserves JSON through the native boundary, restores the shell, and surfaces failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let failToolCall = false;
          const calls: Array<{ method: string; params?: unknown }> = [];
          const server = NodeHttp.createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const message = JSON.parse(Buffer.concat(chunks).toString());
            calls.push(message);
            if (failToolCall && message.method === "tools/call") {
              response.writeHead(500, { "content-type": "text/plain" }).end("forced failure");
              return;
            }
            response.setHeader("content-type", "application/json");
            response.setHeader("mcp-session-id", "windows-mcp-session");
            if (!message.id) {
              response.writeHead(202).end();
              return;
            }
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result:
                  message.method === "initialize"
                    ? {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        serverInfo: { name: "test", version: "1" },
                      }
                    : {
                        content: [],
                        structuredContent: {
                          taskId: "windows-task",
                          childThreadId: "windows-child",
                          status: "running",
                        },
                      },
              }),
            );
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
            ),
            () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                  ),
              ),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Missing test endpoint");
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chatgpt-windows-mcp-" });
          yield* (yield* McpProviderSessions.McpProviderSessions).set({
            ...session,
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
          });
          const attach = yield* Bridge.make;
          const bridge = yield* attach(threadId, root);
          if (bridge === undefined) return yield* Effect.die("Missing Windows bridge");

          const input = {
            task: 'Inspect "quoted" code',
            note: "spaces survive the native boundary",
            clientRequestId: "windows-one",
          };
          const argumentsJson = JSON.stringify(input);
          const powerShellLiteral = `'${argumentsJson.replaceAll("'", "''")}'`;
          const successSource = [
            "$ErrorActionPreference = 'Stop'",
            "$env:ELECTRON_RUN_AS_NODE = 'before-bridge'",
            `$output = ${bridge.command} delegate_task ${powerShellLiteral}`,
            "$nativeStatus = $?",
            "$nativeExitCode = $LASTEXITCODE",
            "[PSCustomObject]@{ output = ($output | ConvertFrom-Json); status = $nativeStatus; exitCode = $nativeExitCode; restored = $env:ELECTRON_RUN_AS_NODE } | ConvertTo-Json -Depth 10 -Compress",
          ].join("; ");
          const success = yield* Effect.promise(() =>
            execFile(powerShell!, [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encodedCommand(successSource),
            ]),
          );
          expect(success.stderr).toBe("");
          expect(JSON.parse(success.stdout)).toMatchObject({
            output: {
              structuredContent: {
                taskId: "windows-task",
                childThreadId: "windows-child",
                status: "running",
              },
            },
            status: true,
            exitCode: 0,
            restored: "before-bridge",
          });
          expect(calls.at(-1)?.params).toEqual({ name: "delegate_task", arguments: input });

          failToolCall = true;
          const caughtSource = [
            "$ErrorActionPreference = 'Stop'",
            "$env:ELECTRON_RUN_AS_NODE = 'before-failure'",
            "$caught = $false",
            `$caughtMessage = $null; try { ${bridge.command} delegate_task ${powerShellLiteral} | Out-Null } catch { $caught = $true; $caughtMessage = $_.Exception.Message }`,
            "$nativeExitCode = $LASTEXITCODE",
            "[PSCustomObject]@{ caught = $caught; message = $caughtMessage; exitCode = $nativeExitCode; restored = $env:ELECTRON_RUN_AS_NODE } | ConvertTo-Json -Compress",
          ].join("; ");
          const caught = yield* Effect.promise(() =>
            execFile(powerShell!, [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encodedCommand(caughtSource),
            ]),
          );
          const caughtResult = JSON.parse(caught.stdout);
          expect(caughtResult).toMatchObject({
            caught: true,
            message: expect.stringContaining("T3 MCP bridge failed with exit code"),
            restored: "before-failure",
          });
          expect(caughtResult.exitCode).not.toBe(0);

          const uncaughtSource = [
            "$ErrorActionPreference = 'Stop'",
            `$null = ${bridge.command} delegate_task ${powerShellLiteral}`,
          ].join("; ");
          const failure = yield* Effect.promise(async () => {
            try {
              await execFile(powerShell!, [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                encodedCommand(uncaughtSource),
              ]);
              return null;
            } catch (error) {
              return error as NodeChildProcess.ExecFileException;
            }
          });
          expect(failure).not.toBeNull();
          expect(failure?.code).not.toBe(0);
        }),
      ).pipe(withInvocation, Effect.provide(layer)),
  );
});
