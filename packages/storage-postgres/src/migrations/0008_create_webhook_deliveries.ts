import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Durable dedupe store for inbound webhook deliveries (LOB-168, part 1 of LOB-154).
 *
 * A delivery is identified by its `request_id` (the provider's idempotency key); recording it
 * here is what makes a replayed delivery a no-op. The row is the dedupe fact, so it must survive
 * a rebuild/replay of the rest of the system — hence a dedicated table rather than a log fold.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS`, so a second migration run leaves the table (and its
 * rows) untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      request_id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'skipped', 'processed')),
      skip_reason TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS webhook_deliveries_by_received ON webhook_deliveries (received_at)
  `;
});
