import { expect, it } from "@effect/vitest";
import {
  ChatGPTThreadRefreshError,
  MessageId,
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
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadSync from "./threadSync.ts";

it.effect(
  "persists an idle thread's recovered answer before refresh succeeds, without duplicate imports",
  () =>
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
          },
          providerThreads: [
            { id: "provider-thread", driver: "chatgpt", providerSessionId: "session" },
          ],
          providerSessions: [{ id: "session", cwd: "/tmp/isolated" }],
          runs: [
            {
              providerThreadId: "provider-thread",
              modelSelection: { instanceId: "chatgpt", model: "test" },
            },
          ],
          turnItems: [],
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
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: () =>
              Effect.succeed({
                ...metadata,
                messages: [...saved.values()],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedNone,
            open: () =>
              Effect.sync(() => {
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
