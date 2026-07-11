// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { AntigravitySettings, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import {
  makeAntigravityAdapter,
  mapAntigravityTranscriptRecordToRuntimeEvents,
  parseAntigravityTranscriptLine,
} from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const makeTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: baseDir,
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig["Service"];
  });

function diagnosticEventType(event: unknown): string {
  return event !== null && typeof event === "object" && "type" in event
    ? String((event as { readonly type?: unknown }).type)
    : JSON.stringify(event);
}

async function waitFor(
  predicate: () => boolean,
  events: ReadonlyArray<unknown>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting; events=${events.map(diagnosticEventType).join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("AntigravityAdapter transcript helpers", () => {
  it("parses valid transcript lines and ignores malformed lines", () => {
    expect(
      parseAntigravityTranscriptLine(
        '{"step_index":7,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE"}',
      ),
    ).toMatchObject({
      step_index: 7,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
    });

    expect(parseAntigravityTranscriptLine("not json")).toBeUndefined();
    expect(parseAntigravityTranscriptLine("   ")).toBeUndefined();
  });

  it("maps command transcript records to command lifecycle and output events", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      instanceId: ProviderInstanceId.make("antigravity"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-05-29T00:00:00.000Z",
      record: {
        step_index: 10,
        source: "MODEL",
        type: "RUN_COMMAND",
        status: "DONE",
        content: "47.0",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["item.completed", "content.delta"]);
    expect(events[0]?.payload).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
    });
    expect(events[1]?.payload).toMatchObject({
      streamKind: "command_output",
      delta: "47.0",
    });
  });

  it("maps tool call records to dynamic tool lifecycle events", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "write_to_file",
            args: { TargetFile: '"/tmp/add_numbers.py"' },
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("item.completed");
    expect(events[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Write file",
    });
  });

  it("normalizes Antigravity list tool call titles", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "List_dir",
            args: { path: "/tmp/project" },
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Listed directory",
      detail: "/tmp/project",
    });
  });

  it("does not render echoed user prompts or conversation history", () => {
    for (const record of [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "<USER_REQUEST>say hi</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "SYSTEM",
        type: "CONVERSATION_HISTORY",
        status: "DONE",
        content: "# Conversation History",
      },
    ]) {
      expect(
        mapAntigravityTranscriptRecordToRuntimeEvents({
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          record,
        }),
      ).toEqual([]);
    }
  });

  it("maps directory listings to tool items without assistant text", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 3,
        source: "MODEL",
        type: "LIST_DIRECTORY",
        status: "DONE",
        content: '{"name":"package.json"}',
      },
    });

    expect(events.map((event) => event.type)).toEqual(["item.completed"]);
    expect(events[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Listed directory",
    });
  });

  it("emits assistant text and completes final response records", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 12,
        source: "MODEL",
        type: "FINAL_RESPONSE",
        status: "DONE",
        content: "Done.",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Done.",
    });
  });

  it("strips Antigravity protocol and tool-log noise from final response text", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 12,
        source: "MODEL",
        type: "FINAL_RESPONSE",
        status: "DONE",
        content: [
          "Created At: 2026-06-01T10:21:47Z Completed At: 2026-06-01T10:21:47Z",
          "You have read and write access to the following workspace(s):",
          "/home/coder",
          "command(cat): allowed",
          "Browser initialized successfully with anti-detection features",
          "Done.",
        ].join("\n"),
      },
    });

    expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Done.",
    });
  });

  it("maps system error transcript records to runtime failures", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 4,
        source: "SYSTEM",
        type: "ERROR_MESSAGE",
        status: "DONE",
        error: "usage limit has been exhausted",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      message: "usage limit has been exhausted",
      class: "provider_error",
    });
    expect(events[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "usage limit has been exhausted",
    });
  });

  it("treats terminal planner responses as assistant text", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Adapter launch probe only.",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Adapter launch probe only.",
    });
  });
});

describe("AntigravityAdapter resumed-output turn reopen", () => {
  it.effect("does not duplicate list-dir planner and concrete transcript records", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antig-list-dedupe-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
            Effect.ignore,
          ),
      );
      const brainPath = NodePath.join(baseDir, "brain");
      const conversationId = "conv-list-dedupe";
      const transcriptPath = NodePath.join(
        brainPath,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(transcriptPath, ""));

      const settings = decodeAntigravitySettings({
        brainPath,
        settingsPath: NodePath.join(baseDir, "settings.json"),
      });
      const config = yield* makeTestServerConfig(baseDir);
      const adapter = yield* makeAntigravityAdapter(settings, {
        instanceId: ProviderInstanceId.make("antigravity"),
        environment: {},
      }).pipe(Effect.provideService(ServerConfig, config));

      const events: ProviderRuntimeEvent[] = [];
      const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      const threadId = ThreadId.make("thread-list-dedupe");

      yield* Effect.gen(function* () {
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: baseDir,
          resumeCursor: { conversationId },
        });
        yield* Effect.promise(() =>
          NodeFSP.appendFile(
            transcriptPath,
            [
              encodeUnknownJson({
                step_index: 3,
                source: "MODEL",
                type: "PLANNER_RESPONSE",
                status: "DONE",
                tool_calls: [{ name: "List_dir", args: { path: baseDir } }],
              }),
              encodeUnknownJson({
                step_index: 3,
                source: "MODEL",
                type: "LIST_DIRECTORY",
                status: "DONE",
                content: '{"name":"package.json"}',
              }),
              "",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          waitFor(
            () => events.filter((event) => event.type === "item.completed").length === 1,
            events,
          ),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => NodeTimers.setTimeout(resolve, 700)),
        );

        const toolEvents = events.filter((event) => event.type === "item.completed");
        expect(toolEvents).toHaveLength(1);
        expect(toolEvents[0]?.payload).toMatchObject({
          itemType: "dynamic_tool_call",
          title: "Listed directory",
        });
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [adapter.stopSession(threadId).pipe(Effect.ignore), Fiber.interrupt(collector)],
            { discard: true },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reopens a turn when transcript output resumes after a completed turn", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antig-reopen-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
            Effect.ignore,
          ),
      );
      const brainPath = NodePath.join(baseDir, "brain");
      const conversationId = "conv-resume";
      const transcriptPath = NodePath.join(
        brainPath,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(transcriptPath, ""));

      const settings = decodeAntigravitySettings({
        brainPath,
        settingsPath: NodePath.join(baseDir, "settings.json"),
      });
      const config = yield* makeTestServerConfig(baseDir);
      const adapter = yield* makeAntigravityAdapter(settings, {
        instanceId: ProviderInstanceId.make("antigravity"),
        environment: {},
      }).pipe(Effect.provideService(ServerConfig, config));

      const events: ProviderRuntimeEvent[] = [];
      const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      const threadId = ThreadId.make("thread-resume");

      yield* Effect.gen(function* () {
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: baseDir,
          resumeCursor: { conversationId },
        });

        yield* Effect.promise(() =>
          NodeFSP.appendFile(
            transcriptPath,
            `${encodeUnknownJson({ step_index: 1, source: "MODEL", type: "FINAL_RESPONSE", status: "DONE", content: "Started in background." })}\n`,
          ),
        );
        yield* Effect.promise(() =>
          waitFor(() => events.some((event) => event.type === "turn.completed"), events),
        );

        yield* Effect.promise(() =>
          NodeFSP.appendFile(
            transcriptPath,
            `${encodeUnknownJson({ step_index: 2, source: "MODEL", type: "RUN_COMMAND", status: "DONE", content: "HELLO_AFTER_WAIT" })}\n`,
          ),
        );
        yield* Effect.promise(() =>
          waitFor(
            () => events.filter((event) => event.type === "turn.started").length >= 2,
            events,
          ),
        );

        const turnStarts = events.filter((event) => event.type === "turn.started");
        expect(turnStarts.length).toBeGreaterThanOrEqual(2);
        expect(turnStarts[1]?.turnId).toBeDefined();
        expect(turnStarts[1]?.turnId).not.toBe(turnStarts[0]?.turnId);

        const firstCompletedIdx = events.findIndex((event) => event.type === "turn.completed");
        const reopenIdx = events.findIndex(
          (event, index) => index > firstCompletedIdx && event.type === "turn.started",
        );
        const commandIdx = events.findIndex(
          (event) =>
            event.type === "item.completed" &&
            (event.payload as { itemType?: string }).itemType === "command_execution",
        );
        expect(reopenIdx).toBeGreaterThan(firstCompletedIdx);
        expect(commandIdx).toBeGreaterThan(reopenIdx);
        expect(events[reopenIdx]?.turnId).toBeDefined();
        expect(events[commandIdx]?.turnId).toBe(events[reopenIdx]?.turnId);
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [adapter.stopSession(threadId).pipe(Effect.ignore), Fiber.interrupt(collector)],
            { discard: true },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

interface FakeDaemon {
  readonly address: string;
  readonly interactions: Array<unknown>;
  close(): Promise<void>;
}

const readFakeDaemonRequestBody = (req: NodeHttp.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => resolve(body));
  });

async function startFakeAntigravityDaemon(): Promise<FakeDaemon> {
  const interactions: Array<unknown> = [];
  const state = { approveWaiting: true };

  const server: NodeHttp.Server = NodeHttp.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const body = await readFakeDaemonRequestBody(req);
      if (url.endsWith("/GetCascadeTrajectory")) {
        const trajectory = state.approveWaiting
          ? {
              trajectory: {
                trajectoryId: "traj-1",
                steps: [
                  {
                    status: "CORTEX_STEP_STATUS_WAITING",
                    metadata: {
                      sourceTrajectoryStepInfo: { trajectoryId: "traj-1", stepIndex: 0 },
                    },
                    requestedInteraction: {
                      permission: { resource: { action: "RUN_COMMAND", target: "ls -la" } },
                    },
                  },
                ],
              },
            }
          : { trajectory: { trajectoryId: "traj-1", steps: [] } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(trajectory));
        return;
      }
      if (url.endsWith("/HandleCascadeUserInteraction")) {
        interactions.push(JSON.parse(body) as unknown);
        // Once approved, the daemon clears the WAITING step.
        state.approveWaiting = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  return {
    address: `http://127.0.0.1:${port}`,
    interactions,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("AntigravityAdapter full-access auto-approval", () => {
  it.effect("auto-approves permission gates without approval runtime events", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antig-autoapprove-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
            Effect.ignore,
          ),
      );
      const daemon = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeAntigravityDaemon()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.ignore),
      );
      const brainPath = NodePath.join(baseDir, "brain");
      const conversationId = "conv-autoapprove";
      const transcriptPath = NodePath.join(
        brainPath,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(transcriptPath, ""));

      const settings = decodeAntigravitySettings({
        brainPath,
        settingsPath: NodePath.join(baseDir, "settings.json"),
        languageServerAddress: daemon.address,
      });
      const config = yield* makeTestServerConfig(baseDir);
      const adapter = yield* makeAntigravityAdapter(settings, {
        instanceId: ProviderInstanceId.make("antigravity"),
        environment: { ANTIGRAVITY_LS_ADDRESS: daemon.address },
        runAgentApi: () => Promise.resolve(""),
      }).pipe(Effect.provideService(ServerConfig, config));

      const events: ProviderRuntimeEvent[] = [];
      const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      const threadId = ThreadId.make("thread-autoapprove");

      yield* Effect.gen(function* () {
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: baseDir,
          resumeCursor: { conversationId },
        });
        yield* adapter.sendTurn({ threadId, input: "run the command" });
        yield* Effect.promise(() =>
          waitFor(() => daemon.interactions.length === 1, daemon.interactions),
        );

        expect(events.map((event) => event.type)).not.toContain("request.opened");
        expect(events.map((event) => event.type)).not.toContain("request.resolved");
        expect(daemon.interactions).toHaveLength(1);
        expect(daemon.interactions[0]).toMatchObject({
          cascadeId: conversationId,
          interaction: {
            trajectoryId: "traj-1",
            stepIndex: 0,
            permission: { allow: true, scope: "PERMISSION_SCOPE_ONCE" },
          },
        });
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [adapter.stopSession(threadId).pipe(Effect.ignore), Fiber.interrupt(collector)],
            { discard: true },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
