import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ChatGPTAgentThreadBindings,
  layer as bindingsLayer,
} from "./ThreadBinding.ts";

const layer = it.layer(
  bindingsLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
layer("ChatGPTAgentThreadBindings", (it) => {
  it.effect(
    "persists a stable conversation id and one-time workspace envelope marker",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE chatgpt_agent_thread_bindings (thread_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, workspace_envelope_sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
        const bindings = yield* ChatGPTAgentThreadBindings;
        const threadId = ThreadId.make("chatgpt-binding-thread");
        yield* bindings.upsert({
          threadId,
          conversationId: "11111111-1111-4111-8111-111111111111",
          workspaceEnvelopeSentAt: null,
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
        });
        yield* bindings.markWorkspaceEnvelopeSent(
          threadId,
          "2026-07-13T00:01:00.000Z",
        );
        const binding = yield* bindings.get(threadId);
        assert.equal(binding._tag, "Some");
        if (binding._tag === "Some") {
          assert.equal(
            binding.value.conversationId,
            "11111111-1111-4111-8111-111111111111",
          );
          assert.equal(
            binding.value.workspaceEnvelopeSentAt,
            "2026-07-13T00:01:00.000Z",
          );
        }
      }),
  );
});
