import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ChatGPTSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  modelCalls: 0,
  healthStarted: undefined as (() => void) | undefined,
  releaseHealth: undefined as (() => void) | undefined,
}));
vi.mock("./connection.ts", () => ({
  ChatGPTConnection: class {
    close() {}
    health() {
      return new Promise<void>((resolve) => {
        fake.releaseHealth = resolve;
        fake.healthStarted?.();
      });
    }
    async models() {
      fake.modelCalls++;
      return [
        {
          slug: "gpt-6-thinking",
          name: "GPT-6 Thinking",
          is_default: true,
          is_available: true,
          thinking_efforts: ["standard", "extended"],
        },
      ];
    }
  },
}));
import { ChatGPTDriver } from "./driver.ts";

const layer = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));
const decodeSettings = Schema.decodeSync(ChatGPTSettings);

describe("ChatGPT initial discovery", () => {
  it("is enabled by default in this integration build but respects manual disable", () => {
    expect(decodeSettings({}).enabled).toBe(true);
    expect(decodeSettings({ enabled: false }).enabled).toBe(false);
  });

  it.effect("loads a cold model catalog and reasoning choices without a manual refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        fake.modelCalls = 0;
        const started = yield* Queue.unbounded<void>();
        fake.healthStarted = () => {
          Queue.offerUnsafe(started, undefined);
        };
        const host = yield* ProviderHost.ProviderHost;
        const fs = yield* FileSystem.FileSystem;
        const tokenFile = host.paths.baseDir + "/test-control-token";
        yield* fs.writeFileString(tokenFile, "test-token");
        const instance = yield* ChatGPTDriver.create({
          instanceId: ProviderInstanceId.make("chatgpt"),
          displayName: undefined,
          enabled: true,
          environment: [],
          config: decodeSettings({ controlTokenFile: tokenFile }),
        });
        const updates = yield* Queue.unbounded<import("@t3tools/contracts").ServerProvider>();
        yield* instance.snapshot.streamChanges.pipe(
          Stream.runForEach((value) => Queue.offer(updates, value)),
          Effect.forkScoped,
        );
        yield* Queue.take(started);
        expect(fake.releaseHealth).toBeTypeOf("function");
        fake.releaseHealth!();
        const ready = yield* Queue.take(updates);
        expect(ready.status).toBe("ready");
        expect(ready.models[0]?.slug).toBe("gpt-6-thinking");
        expect(ready.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "reasoningEffort",
          options: [{ id: "standard" }, { id: "extended" }],
        });
        expect(fake.modelCalls).toBe(1);
      }),
    ).pipe(Effect.provide(layer)),
  );
});
