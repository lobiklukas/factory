import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The derived session list (`listSessions`, docs/features.md §3 A2, R6).
 *
 * `listSessions` must not fold a log per session, so this table answers it in one query:
 * `status`, `cost_total`, and `last_activity_at` per session, joined to `sessions` for the
 * identity columns. It is written from the log — the control plane upserts it as it observes a
 * session's committed changes — and `rebuildIndexes` re-derives it by folding logs, because every
 * column here is a fold of `commits` (`pi.live`'s run state, `pi.usage`'s totals, `committed_at`'s
 * newest row). Dropping it loses nothing but the timeliness of "last activity".
 *
 * `last_activity_at` is a `TIMESTAMPTZ`, not a millisecond counter, so the keyset cursor can carry
 * the exact value Postgres ordered by. The backfill gives every session that predates this table a
 * row, so the list never silently omits history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE session_activity (
      session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy')),
      cost_total DOUBLE PRECISION NOT NULL DEFAULT 0,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE INDEX session_activity_recent
    ON session_activity (last_activity_at DESC, session_id DESC)
  `;

  yield* sql`
    INSERT INTO session_activity (session_id, status, last_activity_at)
    SELECT id, 'idle', created_at FROM sessions
    ON CONFLICT (session_id) DO NOTHING
  `;
});
