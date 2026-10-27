import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * When a delivery's claim was last taken (LOB-216).
 *
 * The trigger seam claims a delivery by inserting its row as `received` and gives the claim back on
 * any unsuccessful exit. A process killed between the two runs no cleanup, so its row stayed
 * `received` for good and every retry was answered `replayed: true` to work that never started. A
 * `received` row whose claim is older than the seam's reclaim window is now taken again by the next
 * delivery of that id, and this column is what the window is measured from.
 *
 * It is not `received_at`: that is when the delivery first arrived, and a claim can be taken later
 * than that — the unregistered-repo skip a work-keyed delivery flips back to `received` (LOB-164),
 * or a reclaim itself — so measuring from it would make a claim taken a moment ago look stale.
 *
 * Backfilled from `received_at`, which is the claim time of every row written before this column:
 * a row a killed process left behind is reclaimable at once, rather than one window after the
 * migration. Idempotent: each statement is a no-op on a second run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`;
  yield* sql`UPDATE webhook_deliveries SET claimed_at = received_at WHERE claimed_at IS NULL`;
  yield* sql`ALTER TABLE webhook_deliveries ALTER COLUMN claimed_at SET DEFAULT now()`;
  yield* sql`ALTER TABLE webhook_deliveries ALTER COLUMN claimed_at SET NOT NULL`;
});
