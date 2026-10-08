import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The approvals table.
 *
 * Stores pending approval requests for sessions. Idempotent lookups use
 * `request_id` (format: `actor-sessionId`) to deduplicate retried calls.
 *
 * `decided_at` is set when `decideApproval` settles the approval.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending',
      request_id TEXT NOT NULL UNIQUE,
      decided_at TIMESTAMPTZ
    )
  `;
});
