import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_wakeups (
      wakeup_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('time', 'process')),
      due_at TEXT,
      pid INTEGER,
      process_identity TEXT,
      originating_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'due', 'delivered', 'stale')),
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX thread_wakeups_idempotency_idx
    ON thread_wakeups(thread_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX thread_wakeups_pending_idx ON thread_wakeups(status, kind, due_at)
    WHERE status IN ('scheduled', 'due')
  `;
});
