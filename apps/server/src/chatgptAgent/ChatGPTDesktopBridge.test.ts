import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ChatGPTDesktopBridge,
  ChatGPTDesktopBridgeLive,
} from "./ChatGPTDesktopBridge.ts";

it.effect(
  "reports an unavailable desktop bridge without falling through to provider runtime",
  () =>
    Effect.gen(function* () {
      const bridge = yield* ChatGPTDesktopBridge;
      const result = yield* Effect.flip(bridge.health("http://127.0.0.1:1"));
      assert.equal(result._tag, "ChatGPTDesktopBridgeError");
      assert.equal(result.kind, "unavailable");
    }).pipe(Effect.provide(ChatGPTDesktopBridgeLive)),
);
