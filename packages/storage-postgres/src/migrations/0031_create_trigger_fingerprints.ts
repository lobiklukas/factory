import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Which session an inbound item's occurrences belong to (LOB-82): a Sentry issue → the session its
 * first alert opened.
 *
 * A Sentry alert is keyed by its event (`sentry:event:<event_id>`, LOB-81), so the alert firing again
 * for a new event in the same issue is a new delivery, and `webhook_deliveries` cannot tell it is the
 * same work. This row can: `fingerprint` is the item (`sentry:<issue_id>`), `request_id` the delivery
 * that claimed it, and `session_id` the session that delivery opened. The trigger seam claims the row
 * before it opens a session — `INSERT … ON CONFLICT … RETURNING`, so two occurrences racing cannot
 * both open one — and a later occurrence whose bound session is still open is recorded as a skip
 * naming it. A row survives a restart the way the delivery's own dedupe row does.
 *
 * - `session_id` is `NULL` between the claim and the session being opened; `bound_at` is when the
 *   current holder claimed it, which is what lets a holder that died before opening its session be
 *   overtaken after the seam's reclaim window.
 * - The reference to `sessions` clears rather than cascades: a session removed from the index leaves
 *   the item free for its next occurrence, not a row pointing nowhere.
 *
 * Idempotent: `IF NOT EXISTS`. Nothing is backfilled — an issue whose alerts were delivered before
 * this table existed is bound by its next alert.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trigger_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
      bound_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
});
