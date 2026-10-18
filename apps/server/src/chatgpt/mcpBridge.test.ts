// @effect-diagnostics nodeBuiltinImport:off -- Integration test executes the real CLI against a loopback MCP endpoint.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Bridge from "./mcpBridge.ts";

const exec = NodeUtil.promisify(NodeChildProcess.exec);
const serverBinPath = NodePath.resolve(import.meta.dirname, "../bin.ts");
const threadId = ThreadId.make("parent-thread");
const layer = Layer.merge(NodeServices.layer, McpProviderSessions.layer);
const session = {
  environmentId: EnvironmentId.make("test-environment"),
  providerInstanceId: ProviderInstanceId.make("chatgpt"),
  threadId,
  providerSessionId: "authenticated-session",
  endpoint: "http://127.0.0.1/mcp",
  authorizationHeader: "Bearer private-test-credential",
  browserToolsAvailable: false,
};

const withInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.Arguments, [
      process.execPath,
      serverBinPath,
    ]),
    Effect.provideService(HostProcess.ExecutablePath, process.execPath),
    Effect.provideService(HostProcess.IsExecutable, false),
  );

describe("ChatGPT orchestration attachment", () => {
  it.effect("omits the bridge when orchestration MCP is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attach = yield* Bridge.make;
        expect(yield* attach(threadId, "/unused-cache")).toBeUndefined();
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the credential private and removes it when the provider session closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(session);
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chatgpt-mcp-test-" });
      let credentialPath = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const attach = yield* Bridge.make;
          const bridge = yield* attach(threadId, root);
          const command = bridge?.command;
          expect(command).toBeDefined();
          expect(command).not.toContain(session.authorizationHeader);
          const directories = yield* fs.readDirectory(root);
          credentialPath = path.join(root, directories[0]!, "session.json");
          expect(JSON.parse(yield* fs.readFileString(credentialPath))).toEqual({
            endpoint: session.endpoint,
            authorization: session.authorizationHeader,
          });
          expect((yield* fs.stat(credentialPath)).mode & 0o777).toBe(0o600);
          yield* sessions.set({ ...session, authorizationHeader: "Bearer rotated" });
          yield* bridge!.refresh;
          expect(JSON.parse(yield* fs.readFileString(credentialPath)).authorization).toBe(
            "Bearer rotated",
          );
          yield* sessions.clear(threadId);
          yield* bridge!.refresh;
          expect(yield* fs.exists(credentialPath)).toBe(false);
          yield* sessions.set(session);
          yield* bridge!.refresh;
          expect(yield* fs.exists(credentialPath)).toBe(true);
        }),
      );
      expect(yield* fs.exists(credentialPath)).toBe(false);
    }).pipe(Effect.scoped, withInvocation, Effect.provide(layer)),
  );

  it.effect("uses host shell quoting for script and packaged runtimes on all platforms", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3 chatgpt 'mcp-" });
      yield* (yield* McpProviderSessions.McpProviderSessions).set(session);
      for (const platform of ["linux", "darwin", "win32"] as const) {
        for (const packaged of [false, true]) {
          const bridge = yield* Effect.gen(function* () {
            const attach = yield* Bridge.make;
            return yield* attach(threadId, root);
          }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.IsExecutable, packaged),
            Effect.provideService(
              HostProcess.ExecutablePath,
              "C:\\Program Files\\T3 $Code`\\t3.exe",
            ),
          );
          const command = bridge!.command;
          expect(command).toContain("chatgpt-mcp-call");
          expect(command.includes(serverBinPath)).toBe(!packaged);
          expect(command).not.toContain(session.authorizationHeader);
          if (platform === "win32") {
            expect(command).toContain("$env:ELECTRON_RUN_AS_NODE='1'; & ");
            expect(command).toContain('"C:\\Program Files\\T3 `$Code``\\t3.exe"');
            expect(command).not.toContain("env ELECTRON_RUN_AS_NODE=1");
          } else {
            expect(command).toContain(
              "env ELECTRON_RUN_AS_NODE=1 'C:\\Program Files\\T3 $Code`\\t3.exe'",
            );
            expect(command).toContain("'\"'\"'");
          }
        }
      }
    }).pipe(Effect.scoped, withInvocation, Effect.provide(layer)),
  );

  it.effect(
    "executes canonical tools with authenticated MCP initialization and returns taskId separately",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: Array<{ method: string; params?: unknown }> = [];
          const headers: NodeHttp.IncomingHttpHeaders[] = [];
          const server = NodeHttp.createServer(async (request, response) => {
            headers.push(request.headers);
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const message = JSON.parse(Buffer.concat(chunks).toString());
            calls.push(message);
            response.setHeader("content-type", "application/json");
            response.setHeader("mcp-session-id", "negotiated-session");
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
                          taskId: "task-one",
                          childThreadId: "child-thread",
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
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3 chatgpt 'mcp-" });
          yield* (yield* McpProviderSessions.McpProviderSessions).set({
            ...session,
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
          });
          const bridge = yield* (yield* Bridge.make)(threadId, root);
          const command = bridge?.command;
          const { stdout, stderr } = yield* Effect.promise(() =>
            exec(`${command} delegate_task '{"task":"Inspect code","clientRequestId":"task-one"}'`),
          );
          expect(stderr).toBe("");
          expect(JSON.parse(stdout)).toMatchObject({
            structuredContent: {
              taskId: "task-one",
              childThreadId: "child-thread",
              status: "running",
            },
          });
          expect(calls.map((call) => call.method)).toEqual([
            "initialize",
            "notifications/initialized",
            "tools/call",
          ]);
          expect(calls[2]?.params).toEqual({
            name: "delegate_task",
            arguments: { task: "Inspect code", clientRequestId: "task-one" },
          });
          expect(
            headers.every((header) => header.authorization === session.authorizationHeader),
          ).toBe(true);
          expect(headers[2]?.["mcp-session-id"]).toBe("negotiated-session");
          expect(headers[2]?.["mcp-protocol-version"]).toBe("2025-06-18");
        }),
      ).pipe(withInvocation, Effect.provide(layer)),
  );
});
