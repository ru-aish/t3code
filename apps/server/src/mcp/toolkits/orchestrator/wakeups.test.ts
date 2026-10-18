import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWakeupService from "../../../threadWakeups/ThreadWakeupService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

it.effect(
  "self-wake handlers target the credential's exact thread and reject external MCP clients",
  () =>
    Effect.gen(function* () {
      const caller = liveThreadShell(ThreadId.make("credential-thread"));
      const calls: Array<{
        kind: string;
        threadId: ThreadId;
        input: unknown;
        originatingRunId?: string | null | undefined;
      }> = [];
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        issuedAt: 0,
        capabilities: new Set(["orchestration"]),
        client: undefined,
        thread: {
          threadId: caller.id,
          providerSessionId: "session",
          providerInstanceId: caller.providerInstanceId,
        },
      };
      const threadManagement = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      });
      const wakeups = Layer.mock(ThreadWakeupService.ThreadWakeupService)({
        scheduleContinue: (threadId, input) =>
          Effect.sync(() => {
            calls.push({ kind: "time", threadId, input });
            return {
              wakeupId: "time",
              status: "scheduled" as const,
              dueAt: "2026-10-18T10:00:00Z",
            };
          }),
        continueAfterProcess: (threadId, input, originatingRunId) =>
          Effect.sync(() => {
            calls.push({ kind: "process", threadId, input, originatingRunId });
            return { wakeupId: "process", status: "scheduled" as const, dueAt: null };
          }),
      });
      const build = (invocation: McpInvocationContext.McpInvocationScope) => {
        const handlerDependencies = Layer.merge(
          Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
          threadManagement,
        );
        const callDependencies = Layer.merge(handlerDependencies, wakeups);
        return OrchestratorToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
              Layer.provide(handlerDependencies),
            ),
          ),
          Effect.map((toolkit) => ({ toolkit, callDependencies })),
        );
      };

      const allowed = yield* build(scope);
      const timeResult = yield* allowed.toolkit
        .handle("schedule_continue", { afterSeconds: 10 })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(allowed.callDependencies));
      expect(timeResult.at(-1)?.result).toMatchObject({ wakeupId: "time" });
      const processResult = yield* allowed.toolkit
        .handle("continue_after_process", { pid: 42 })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(allowed.callDependencies));
      expect(processResult.at(-1)?.result).toMatchObject({ wakeupId: "process" });
      expect(calls).toEqual([
        { kind: "time", threadId: caller.id, input: { afterSeconds: 10 } },
        {
          kind: "process",
          threadId: caller.id,
          input: { pid: 42 },
          originatingRunId: caller.activeRunId,
        },
      ]);
      for (const denied of [
        {
          ...scope,
          thread: undefined,
          client: { sessionId: "external", label: "external", access: "full-access" as const },
        },
        { ...scope, capabilities: new Set<McpInvocationContext.McpCapability>() },
      ]) {
        const current = yield* build(denied);
        const time = yield* current.toolkit
          .handle("schedule_continue", { afterSeconds: 10 })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(current.callDependencies));
        const process = yield* current.toolkit
          .handle("continue_after_process", { pid: 42 })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(current.callDependencies));
        const code =
          denied.thread === undefined ? "thread_credential_required" : "capability_denied";
        expect(time.at(-1)?.result).toMatchObject({ code });
        expect(process.at(-1)?.result).toMatchObject({ code });
      }
      expect(calls).toHaveLength(2);
    }),
);
