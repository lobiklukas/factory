import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The derived pending-approvals row (LOB-147, D11).
 *
 * A request and its decision are committed into the session's log — `factory.approval.requested`
 * and `factory.approval.decided`, written by the approvals service — and this table is the fold of
 * those two entries: one row per request id, `decision` NULL while it is still waiting. The log is
 * the truth; a row is what lets the pending list answer without folding a log, the way
 * `sessions.pr_url` lets the session list answer without folding one (R6), and
 * `rebuildIndexes` re-derives every row from the log so losing the table costs the list's
 * timeliness, never an approval.
 *
 * The primary key is `(session_id, request_id)` rather than a minted id: a request id is unique
 * within a session and is the caller's deduplication key, so it *is* the row's identity — a
 * retried request upserts the same row instead of appending a second one.
 *
 * `requested_at` is `TIMESTAMPTZ` and the pending list orders by it, then by `request_id`, which
 * is the same order the log fold produces: two asks in one millisecond still have one answer.
 *
 * No backfill. A row is written when a request is committed, so a request committed before this
 * table existed has a log entry and no row; `rebuildIndexes` derives every row from the logs and
 * is the way to fill those in. The pending list reads this table, so until such a rebuild the list
 * of a session that was already waiting answers nothing — while that session's snapshot, which
 * folds the log, still reports the request. That asymmetry is the price of an index that is written
 * at request time rather than read at list time, and it is bounded by one rebuild.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_approvals (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      requested_at TIMESTAMPTZ NOT NULL,
      decision TEXT CHECK (decision IN ('approved', 'denied')),
      actor TEXT,
      decided_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, request_id),
      CHECK ((decision IS NULL) = (actor IS NULL)),
      CHECK ((decision IS NULL) = (decided_at IS NULL))
    )
  `;

  // The pending list asks "what is waiting for this session, oldest first", and a decided row is
  // never part of that answer: a partial index keeps it out of the scan instead of filtering it.
  yield* sql`
    CREATE INDEX IF NOT EXISTS session_approvals_pending
    ON session_approvals (session_id, requested_at, request_id)
    WHERE decision IS NULL
  `;
});
