import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ChatGPTAgentThreadBindings, layer as bindingsLayer } from "./ThreadBinding.ts";

const layer = it.layer(bindingsLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
layer("ChatGPTAgentThreadBindings", (it) => {
  it.effect("persists a stable conversation id and one-time workspace envelope marker", () =>
    Effect.gen(function* () {
      const bindings = yield* ChatGPTAgentThreadBindings;
      const threadId = ThreadId.make("chatgpt-binding-thread");
      yield* bindings.upsert({
        threadId,
        conversationId: "11111111-1111-4111-8111-111111111111",
        workspaceEnvelopeSentAt: null,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      });
      yield* bindings.markWorkspaceEnvelopeSent(threadId, "2026-07-13T00:01:00.000Z");
      const binding = yield* bindings.get(threadId);
      assert.equal(binding._tag, "Some");
      if (binding._tag === "Some") {
        assert.equal(binding.value.conversationId, "11111111-1111-4111-8111-111111111111");
        assert.equal(binding.value.workspaceEnvelopeSentAt, "2026-07-13T00:01:00.000Z");
      }
      const byConversation = yield* bindings.findByConversationId(
        "11111111-1111-4111-8111-111111111111",
      );
      assert.equal(byConversation._tag, "Some");
      if (byConversation._tag === "Some") assert.equal(byConversation.value.threadId, threadId);
    }),
  );

  it.effect("reserves the initial envelope once so retries cannot resend the same prompt", () =>
    Effect.gen(function* () {
      const bindings = yield* ChatGPTAgentThreadBindings;
      const threadId = ThreadId.make("chatgpt-initial-send-thread");
      const messageId = MessageId.make("chatgpt-initial-send-message");
      const sentAt = "2026-07-13T00:00:00.000Z";

      assert.equal(yield* bindings.reserveInitialSend(threadId, messageId, sentAt), true);
      assert.equal(yield* bindings.reserveInitialSend(threadId, messageId, sentAt), false);
      const reservedMessageId = yield* bindings.getInitialSendMessageId(threadId);
      assert.equal(Option.isSome(reservedMessageId), true);
      if (Option.isSome(reservedMessageId)) assert.equal(reservedMessageId.value, messageId);

      yield* bindings.delete(threadId);
      assert.equal(Option.isNone(yield* bindings.getInitialSendMessageId(threadId)), true);
    }),
  );
});
