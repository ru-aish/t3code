import { expect, it } from "@effect/vitest";
import {
  ChatGPTThreadRefreshError,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadSync from "./threadSync.ts";
import { messageQuestionArtifacts } from "../orchestration-v2/userInputArtifacts.ts";

it.effect.each([false, true])(
  "persists an idle thread's recovered answer before refresh succeeds, detached=%s",
  (detached) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const now = yield* DateTime.now;
        const saved = new Map<string, OrchestrationV2ConversationMessage>();
        const message = {
          id: MessageId.make("recovered"),
          text: "Completed work",
          streaming: false,
          updatedAt: now,
        } as OrchestrationV2ConversationMessage;
        const metadata = {
          thread: {
            activeProviderThreadId: "provider-thread",
            runtimeMode: "full-access",
            interactionMode: "default",
            projectId: "project",
          },
          providerThreads: [
            { id: "provider-thread", driver: "chatgpt", providerSessionId: "session" },
          ],
          providerSessions: detached ? [] : [{ id: "session", cwd: "/tmp/isolated" }],
          runs: [
            {
              providerThreadId: "provider-thread",
              modelSelection: { instanceId: "chatgpt", model: "test" },
            },
          ],
          turnItems: [],
          runtimeRequests: [],
          nodes: [],
        };
        let reads = 0;
        let opens = 0;
        let succeeded = false;
        const runtime = {
          driver: "chatgpt",
          instanceId: "chatgpt",
          readThreadSnapshot: () =>
            Effect.sync(() => {
              reads++;
              return {
                providerThread: metadata.providerThreads[0],
                messages: [message],
                runtimeRequests: [],
                providerTurns: [],
              };
            }),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/tmp/isolated" } as never)),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: () =>
              Effect.succeed({
                ...metadata,
                messages: [...saved.values()],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedNone,
            open: (input) =>
              Effect.sync(() => {
                expect(input.providerSessionId).toBe("session");
                expect(input.runtimePolicy.cwd).toBe("/tmp/isolated");
                opens++;
                return runtime;
              }),
          }),
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            normalize: (input) =>
              Effect.succeed([
                {
                  type: "message.updated",
                  payload: input.event.type === "message.updated" ? input.event.message : null,
                },
              ] as unknown as OrchestrationV2DomainEvent[]),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(commit)),
                Effect.andThen(
                  Effect.sync(() => {
                    for (const event of input.events)
                      if (event.type === "message.updated")
                        saved.set(event.payload.id, event.payload);
                    return [];
                  }),
                ),
              ),
          }),
        );
        yield* Effect.gen(function* () {
          const sync = yield* ThreadSync.ChatGPTThreadSync;
          const run = yield* sync.refresh(ThreadId.make("thread")).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                succeeded = true;
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          expect(succeeded).toBe(false);
          expect(saved.size).toBe(0);
          yield* Deferred.succeed(commit, undefined);
          expect((yield* Fiber.join(run)).messageCount).toBe(1);
          expect(saved.get("recovered")?.text).toBe("Completed work");
          yield* sync.refresh(ThreadId.make("thread"));
          expect(saved.size).toBe(1);
          expect(reads).toBe(2);
          expect(opens).toBe(2);
        }).pipe(Effect.provide(ThreadSync.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
);

it.effect(
  "restores an idle question with its answer request and never reopens an answered card",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("recovered-question");
      const runId = RunId.make("question-run");
      const now = yield* DateTime.now;
      const artifacts = messageQuestionArtifacts({
        threadId,
        runId,
        rootNodeId: NodeId.make("question-root"),
        providerThreadId: null,
        providerTurnId: null,
        requestId: RuntimeRequestId.make("recovered-phone-question"),
        questions: [
          { id: "phone", header: "Phone", question: "Which phone and RAM?", options: [] },
        ],
        ordinal: 1,
        now,
      });
      let projection = {
        thread: {
          activeProviderThreadId: "provider-thread",
          worktreePath: "/tmp/isolated",
        },
        providerThreads: [
          { id: "provider-thread", driver: "chatgpt", providerSessionId: "session" },
        ],
        providerSessions: [],
        runs: [
          {
            id: runId,
            rootNodeId: artifacts.node.rootNodeId,
            providerThreadId: "provider-thread",
            modelSelection: { instanceId: "chatgpt", model: "test" },
          },
        ],
        nodes: [],
        runtimeRequests: [],
        turnItems: [],
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let commits = 0;
      const runtime = {
        driver: "chatgpt",
        instanceId: "chatgpt",
        readThreadSnapshot: () =>
          Effect.succeed({
            providerThread: projection.providerThreads[0],
            providerTurns: [],
            messages: [],
            turnItems: [artifacts.turnItem],
            runtimeRequests: [artifacts.request],
          }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const dependencies = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.sync(() => projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () => Effect.succeed(Option.some(runtime)),
        }),
        Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
          normalize: ({ event }) =>
            Effect.succeed([
              event.type === "node.updated"
                ? { type: "node.updated", payload: event.node }
                : event.type === "runtime_request.updated"
                  ? { type: "runtime-request.updated", payload: event.runtimeRequest }
                  : event.type === "turn_item.updated"
                    ? { type: "turn-item.updated", payload: event.turnItem }
                    : (() => {
                        throw new Error(`Unexpected event: ${event.type}`);
                      })(),
            ] as OrchestrationV2DomainEvent[]),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.sync(() => {
              commits++;
              expect(events.map((event) => event.type)).toEqual([
                "node.updated",
                "runtime-request.updated",
                "turn-item.updated",
              ]);
              for (const event of events) {
                if (event.type === "node.updated")
                  Object.assign(projection, { nodes: [event.payload] });
                if (event.type === "runtime-request.updated")
                  Object.assign(projection, { runtimeRequests: [event.payload] });
                if (event.type === "turn-item.updated")
                  Object.assign(projection, { turnItems: [event.payload] });
              }
              return [];
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const sync = yield* ThreadSync.ChatGPTThreadSync;
        yield* sync.refresh(threadId);
        expect(projection.runtimeRequests).toEqual([artifacts.request]);
        expect(projection.nodes).toEqual([artifacts.node]);
        expect(projection.turnItems).toEqual([artifacts.turnItem]);
        yield* sync.refresh(threadId);
        expect(commits).toBe(1);
        projection = {
          ...projection,
          nodes: [{ ...artifacts.node, status: "completed", completedAt: now }],
          runtimeRequests: [{ ...artifacts.request, status: "resolved", resolvedAt: now }],
          turnItems: [{ ...artifacts.turnItem, status: "completed", completedAt: now }],
        };
        yield* sync.refresh(threadId);
        expect(commits).toBe(1);
        expect(projection.runtimeRequests[0]?.status).toBe("resolved");
        expect(projection.turnItems[0]?.status).toBe("completed");
      }).pipe(Effect.provide(ThreadSync.layer.pipe(Layer.provide(dependencies))));
    }),
);

it.effect("rejects other providers before opening a runtime or reading a conversation", () =>
  Effect.gen(function* () {
    const sync = yield* ThreadSync.ChatGPTThreadSync;
    const result = yield* sync.refresh(ThreadId.make("not-chatgpt")).pipe(Effect.flip);
    expect(result).toBeInstanceOf(ChatGPTThreadRefreshError);
  }).pipe(
    Effect.provide(
      ThreadSync.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadProjection: () =>
                Effect.succeed({
                  thread: { activeProviderThreadId: "other" },
                  providerThreads: [{ id: "other", driver: "codex" }],
                  providerSessions: [],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({}),
            Layer.mock(EventSink.EventSinkV2)({}),
          ),
        ),
      ),
    ),
  ),
);
