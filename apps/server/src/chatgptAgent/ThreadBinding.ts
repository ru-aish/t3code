import { IsoDateTime, ThreadId, TrimmedNonEmptyString, MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

/** A dedicated durable association; deliberately unrelated to provider runtime records. */
export const ChatGPTAgentThreadBinding = Schema.Struct({
  threadId: ThreadId,
  conversationId: TrimmedNonEmptyString,
  workspaceEnvelopeSentAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ChatGPTAgentThreadBinding = typeof ChatGPTAgentThreadBinding.Type;

export type ChatGPTAgentThreadBindingError = PersistenceSqlError | PersistenceDecodeError;

export class ChatGPTAgentThreadBindings extends Context.Service<
  ChatGPTAgentThreadBindings,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ChatGPTAgentThreadBinding>, ChatGPTAgentThreadBindingError>;
    readonly upsert: (
      binding: ChatGPTAgentThreadBinding,
    ) => Effect.Effect<void, ChatGPTAgentThreadBindingError>;
    readonly markWorkspaceEnvelopeSent: (
      threadId: ThreadId,
      sentAt: string,
    ) => Effect.Effect<void, ChatGPTAgentThreadBindingError>;
    /** Atomically claims the one permitted initial workspace-envelope dispatch. */
    readonly reserveInitialSend: (
      threadId: ThreadId,
      messageId: MessageId,
      reservedAt: string,
    ) => Effect.Effect<boolean, ChatGPTAgentThreadBindingError>;
    readonly getInitialSendMessageId: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<MessageId>, ChatGPTAgentThreadBindingError>;
    readonly delete: (threadId: ThreadId) => Effect.Effect<void, ChatGPTAgentThreadBindingError>;
  }
>()("t3/chatgptAgent/ThreadBindings") {}

const Row = ChatGPTAgentThreadBinding;
const Get = Schema.Struct({ threadId: ThreadId });
const Mark = Schema.Struct({ threadId: ThreadId, sentAt: IsoDateTime });
const ReserveInitialSend = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  reservedAt: IsoDateTime,
});
const decode = Schema.decodeUnknownEffect(Row);
const error = (
  operation: string,
  cause: unknown,
  threadId?: ThreadId,
): ChatGPTAgentThreadBindingError =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause, threadId ? { threadId } : undefined)
    : new PersistenceSqlError({
        operation,
        ...(threadId ? { correlation: { threadId } } : {}),
        cause,
      });

export const layer = Layer.effect(
  ChatGPTAgentThreadBindings,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getRow = SqlSchema.findOneOption({
      Request: Get,
      Result: Row,
      execute: ({ threadId }) => sql`
        SELECT thread_id AS "threadId", conversation_id AS "conversationId",
          workspace_envelope_sent_at AS "workspaceEnvelopeSentAt", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM chatgpt_agent_thread_bindings WHERE thread_id = ${threadId}`,
    });
    const putRow = SqlSchema.void({
      Request: Row,
      execute: (row) => sql`
        INSERT INTO chatgpt_agent_thread_bindings (thread_id, conversation_id, workspace_envelope_sent_at, created_at, updated_at)
        VALUES (${row.threadId}, ${row.conversationId}, ${row.workspaceEnvelopeSentAt}, ${row.createdAt}, ${row.updatedAt})
        ON CONFLICT(thread_id) DO UPDATE SET conversation_id = excluded.conversation_id,
          workspace_envelope_sent_at = excluded.workspace_envelope_sent_at, updated_at = excluded.updated_at`,
    });
    const mark = SqlSchema.void({
      Request: Mark,
      execute: ({ threadId, sentAt }) => sql`
        UPDATE chatgpt_agent_thread_bindings SET workspace_envelope_sent_at = ${sentAt}, updated_at = ${sentAt}
        WHERE thread_id = ${threadId}`,
    });
    const removeBinding = SqlSchema.void({
      Request: Get,
      execute: ({ threadId }) =>
        sql`DELETE FROM chatgpt_agent_thread_bindings WHERE thread_id = ${threadId}`,
    });
    const removeInitialSend = SqlSchema.void({
      Request: Get,
      execute: ({ threadId }) =>
        sql`DELETE FROM chatgpt_agent_initial_sends WHERE thread_id = ${threadId}`,
    });
    const reserveInitialSend = SqlSchema.findOneOption({
      Request: ReserveInitialSend,
      Result: Schema.Struct({ threadId: ThreadId }),
      execute: ({ threadId, messageId, reservedAt }) => sql`
        INSERT INTO chatgpt_agent_initial_sends (thread_id, message_id, reserved_at)
        VALUES (${threadId}, ${messageId}, ${reservedAt})
        ON CONFLICT(thread_id) DO NOTHING
        RETURNING thread_id AS "threadId"`,
    });
    const getInitialSend = SqlSchema.findOneOption({
      Request: Get,
      Result: Schema.Struct({ messageId: MessageId }),
      execute: ({ threadId }) => sql`
        SELECT message_id AS "messageId"
        FROM chatgpt_agent_initial_sends WHERE thread_id = ${threadId}`,
    });
    return ChatGPTAgentThreadBindings.of({
      get: (threadId) =>
        getRow({ threadId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (row) => decode(row).pipe(Effect.map(Option.some)),
            }),
          ),
          Effect.mapError((cause) => error("ChatGPTAgentThreadBindings.get", cause, threadId)),
        ),
      upsert: (binding) =>
        putRow(binding).pipe(
          Effect.mapError((cause) =>
            error("ChatGPTAgentThreadBindings.upsert", cause, binding.threadId),
          ),
        ),
      markWorkspaceEnvelopeSent: (threadId, sentAt) =>
        mark({ threadId, sentAt }).pipe(
          Effect.mapError((cause) =>
            error("ChatGPTAgentThreadBindings.markWorkspaceEnvelopeSent", cause, threadId),
          ),
        ),
      reserveInitialSend: (threadId, messageId, reservedAt) =>
        reserveInitialSend({ threadId, messageId, reservedAt }).pipe(
          Effect.map(Option.isSome),
          Effect.mapError((cause) =>
            error("ChatGPTAgentThreadBindings.reserveInitialSend", cause, threadId),
          ),
        ),
      getInitialSendMessageId: (threadId) =>
        getInitialSend({ threadId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: ({ messageId }) => Effect.succeed(Option.some(messageId)),
            }),
          ),
          Effect.mapError((cause) =>
            error("ChatGPTAgentThreadBindings.getInitialSendMessageId", cause, threadId),
          ),
        ),
      delete: (threadId) =>
        removeBinding({ threadId }).pipe(
          Effect.flatMap(() => removeInitialSend({ threadId })),
          Effect.asVoid,
          Effect.mapError((cause) => error("ChatGPTAgentThreadBindings.delete", cause, threadId)),
        ),
    });
  }),
);
