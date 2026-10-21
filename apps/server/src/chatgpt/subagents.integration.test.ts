// @effect-diagnostics nodeBuiltinImport:off -- Integration test executes the real CLI against a loopback MCP endpoint.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatGPTSettings,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/http";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { vi } from "vite-plus/test";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { ChatGPTUpdate } from "./connection.ts";

type Submission = {
  threadId: string;
  requestId: string;
  text: string;
  model: string;
  complete: () => void;
};
const fake = vi.hoisted(() => ({
  submitted: undefined as ((submission: Submission) => void) | undefined,
}));
vi.mock("./connection.ts", () => ({
  ChatGPTConnection: class {
    conversationId = null;
    messages = [];
    callback?: (update: ChatGPTUpdate) => void;
    readonly options: { threadId: string };
    constructor(options: { threadId: string }) {
      this.options = options;
    }
    async load() {}
    close() {}
    onUpdate(callback: (update: ChatGPTUpdate) => void) {
      this.callback = callback;
    }
    async control() {
      return {
        thread_id: this.options.threadId,
        terminal_id: this.options.threadId,
        conversation_id: null,
        epoch: 1,
        state: "working",
        paused: 0,
      };
    }
    async *terminalEvents(signal: AbortSignal) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    }
    async send(requestId: string, text: string, model: string) {
      fake.submitted?.({
        threadId: this.options.threadId,
        requestId,
        text,
        model,
        complete: () => {
          this.callback?.({
            kind: "update",
            requestId,
            conversationId: null,
            messageId: `${requestId}-answer`,
            role: "assistant",
            recipient: "all",
            channel: "final",
            text: `Result: ${text}`,
            status: "finished_successfully",
          });
          this.callback?.({ kind: "complete", requestId, conversationId: null });
        },
      });
    }
  },
}));
import * as ChatGPTMcpBridge from "./mcpBridge.ts";
import { CHATGPT_DRIVER, makeChatGPTAdapter } from "./adapter.ts";

const decodeSettings = Schema.decodeSync(ChatGPTSettings);
const parentId = ThreadId.make("chatgpt-parent");
const projectId = ProjectId.make("chatgpt-project");
const instanceId = ProviderInstanceId.make("chatgpt");
const selection = { instanceId, model: "gpt-parent" };
const provider: ServerProvider = {
  instanceId,
  driver: CHATGPT_DRIVER,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-18T00:00:00.000Z",
  models: ["gpt-parent", "gpt-child"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
  supportedRuntimeModes: ["full-access"],
};

const exec = NodeUtil.promisify(NodeChildProcess.exec);
const serverBinPath = NodePath.resolve(import.meta.dirname, "../bin.ts");
const withInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, serverBinPath]),
    Effect.provideService(HostProcess.ExecutablePath, process.execPath),
    Effect.provideService(HostProcess.IsExecutable, false),
  );

describe("ChatGPT app-owned delegation", () => {
  it.live(
    "returns before the child completes, projects the task, and automatically continues the parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("chatgpt-subagents");
          const submissions = yield* Queue.unbounded<Submission>();
          fake.submitted = (submission) => {
            Queue.offerUnsafe(submissions, submission);
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              fake.submitted = undefined;
            }),
          );
          const attachMcp = yield* ChatGPTMcpBridge.make;
          const adapter = makeChatGPTAdapter(
            {
              instanceId,
              displayName: undefined,
              environment: [],
              enabled: true,
              config: decodeSettings({}),
            },
            {
              token: "test",
              environmentId: "test",
              cacheDir: cwd + "/chatgpt-cache",
              attachMcp,
            },
          );
          const capabilities = yield* adapter.getCapabilities();
          expect(capabilities.subagents.supportsSubagents).toBe(false);
          const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
          const runtime = ProviderReplayHarness.layerWithRegistry(
            {
              name: "chatgpt-subagents",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            registry,
            { runContinuationWorker: true },
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sink = yield* EventSink.EventSinkV2;
            const mcpDependencies = Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                dispatch: orchestrator.dispatch,
                getThreadShell: orchestrator.getThreadShell,
                getThreadRecords: orchestrator.getThreadRecords,
                recoverDelegatedTask: orchestrator.recoverDelegatedTask,
                delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
                hasReceipt: () => Effect.succeed(false),
              }),
              registry,
              ProviderRegistryMock.layer([provider]),
              ServerSettings.layerTest(),
              Layer.mock(ProjectService.ProjectService)({
                getById: () =>
                  Effect.succeed(
                    Option.some({ id: projectId, defaultModelSelection: null } as never),
                  ),
              }),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            );
            const mcpRoutes = McpHttpServer.layerOrchestratorToolkit.pipe(
              Layer.provideMerge(McpHttpServer.layerMcpTransport),
              Layer.provide(mcpDependencies),
              Layer.provide(McpSessionRegistry.layer),
            );
            yield* HttpRouter.serve(mcpRoutes, {
              disableListenLog: true,
              disableLogger: true,
            }).pipe(
              Layer.provide(NodeHttpServer.layerTest),
              Layer.provide(
                Layer.mock(ServerEnvironment.ServerEnvironment)({
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
                }),
              ),
              Layer.provide(NodeServices.layer),
              Layer.build,
            );
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("create-parent"),
              threadId: parentId,
              projectId,
              title: "Parent",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("start-parent"),
              threadId: parentId,
              messageId: MessageId.make("parent-message"),
              text: "Delegate a review",
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
            const parent = yield* Queue.take(submissions);
            // The provider emits its running event before submitting. Await its
            // commit so the MCP call has the same active parent as a real tool call.
            yield* sink.stream({ threadId: parentId, afterSequence: 0 }).pipe(
              Stream.filter(
                ({ event }) => event.type === "run.updated" && event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
              threadId: parentId,
              providerInstanceId: instanceId,
              browserToolsAvailable: false,
              capabilities: new Set(["orchestration"]),
            });
            if (credential === undefined) {
              return yield* Effect.die(new Error("MCP credential was not issued."));
            }
            expect(credential.config.threadId).toBe(parentId);
            yield* (yield* McpProviderSessions.McpProviderSessions).set(credential.config);
            const bridge = yield* attachMcp(parentId, cwd + "/bridge-call");
            if (bridge === undefined) {
              return yield* Effect.die(new Error("ChatGPT MCP bridge was not attached."));
            }
            const { stdout, stderr } = yield* Effect.promise(() =>
              exec(
                `${bridge.command} delegate_task '${JSON.stringify({
                  task: "Review the API",
                  title: "API review",
                  target: { model: "gpt-child" },
                  clientRequestId: "review-one",
                })}'`,
              ),
            );
            expect(stderr).toBe("");
            const task = JSON.parse(stdout).structuredContent;
            expect(task).toMatchObject({
              childThreadId: expect.any(String),
              taskId: expect.any(String),
            });
            expect(["queued", "running"]).toContain(task.status);
            expect(task.taskId).not.toBe(task.childThreadId);
            expect(task.summary).toBeNull();
            const child = yield* Queue.take(submissions);
            expect(child).toMatchObject({
              threadId: task.childThreadId,
              model: "gpt-child",
              text: "Review the API",
            });
            const projection = yield* orchestrator.getThreadProjection(parentId);
            expect(projection.subagents.find((agent) => agent.id === task.taskId)).toMatchObject({
              origin: "app_owned",
              driver: "chatgpt",
              providerInstanceId: instanceId,
              model: "gpt-child",
              title: "API review",
              childThreadId: task.childThreadId,
              completionWake: "always",
            });
            parent.complete();
            yield* sink.stream({ threadId: parentId, afterSequence: 0 }).pipe(
              Stream.filter(
                ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            child.complete();
            // No status/wait call: the existing completion worker resumes ChatGPT.
            const continuation = yield* Queue.take(submissions);
            expect(continuation.threadId).toBe(parentId);
            expect(continuation.text.length).toBeLessThan(600);
            expect(continuation.text).toContain("task_status");
            const completed = yield* orchestrator.getThreadProjection(parentId);
            const delivery = completed.messages.find((message) =>
              message.delegatedCompletion?.taskIds.includes(task.taskId),
            );
            expect(delivery?.delegatedCompletion?.taskIds).toEqual([task.taskId]);
            expect(completed.subagents.find((agent) => agent.id === task.taskId)).toMatchObject({
              status: "completed",
              result: "Result: Review the API",
            });
            continuation.complete();
          }).pipe(Effect.provide(runtime));
        }),
      ).pipe(
        withInvocation,
        Effect.provide(Layer.merge(NodeServices.layer, McpProviderSessions.layer)),
      ),
  );
});
