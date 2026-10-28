import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * What a delivery came from and what it started (T4): the columns `listTriggerDeliveries` reads.
 *
 * `webhook_deliveries` recorded that a delivery arrived and how it ended (`status`, `skip_reason`),
 * but not which source sent it, and the session or card a processed delivery opened was a fact only
 * the first response carried. An operator whose labelled issue started nothing could not tell the
 * delivery was refused from the delivery never arriving, and one whose issue did start work could
 * not find it from the delivery.
 *
 * - `source` is the seam's `TriggerSource` (or `plan-freshness`, the cadence that shares the dedupe
 *   table): a plain `TEXT`, so a new adapter needs no migration. `NULL` for a row written before this.
 * - `session_id` and `task_id` are the session a processed delivery opened (or, for plan freshness,
 *   refreshed) and the card a card rule filed or found. Deliberately no foreign key: a delivery's
 *   history outlives the session it started (a discard deletes nothing here, a rebuild must not
 *   cascade into the dedupe fact), and the reader decides what a dangling id means.
 *
 * Backfilled where the answer is recoverable: a session a delivery opened carries the delivery's id
 * in its `request_id` (`trigger:<delivery id>`). Nothing on a session says which source sent it, and
 * a card's id has no such trail either, so an older delivery's `source` (and an older card
 * delivery's `task_id`) stays `NULL` and reads as absent.
 *
 * `webhook_deliveries_by_received_desc` serves the newest-first walk with its `request_id` tiebreak.
 * Idempotent: each statement is a no-op on a second run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS source TEXT`;
  yield* sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS session_id TEXT`;
  yield* sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS task_id TEXT`;

  yield* sql`
    UPDATE webhook_deliveries d
    SET session_id = s.id
    FROM sessions s
    WHERE d.session_id IS NULL
      AND d.status = 'processed'
      AND s.request_id = 'trigger:' || d.request_id
      AND s.id ~ '^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS webhook_deliveries_by_received_desc
      ON webhook_deliveries (received_at DESC, request_id DESC)
  `;
});
