import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Reserving the initial desktop dispatch before touching CDP prevents a retry
 * after a timeout or process interruption from submitting the workspace
 * envelope (and its first user prompt) twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chatgpt_agent_initial_sends (
      thread_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      reserved_at TEXT NOT NULL
    )
  `;
});
