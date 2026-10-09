import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The derived pending-approvals rows (D11, LOB-147).
 *
 * One row per approval request a session has made and nobody has decided yet. The log is the
 * truth: the request and decision entries are committed there, and `foldApprovals` derives the same
 * list from them. This table is the query-shaped copy the pending list reads, so a request does not
 * fold a whole log to answer "what is waiting". The control plane inserts a row as it records a
 * request (a repeat is `ON CONFLICT DO NOTHING`, so a request id is one row) and deletes it as it
 * records the decision. Dropping the table loses nothing a fold cannot re-derive.
 *
 * `requested_at` stays `TEXT`: it is the ISO string the log carries, so the list returns exactly the
 * value that was recorded. Rows go with their session, like `session_activity`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE session_approvals (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id)
    )
  `;
});
