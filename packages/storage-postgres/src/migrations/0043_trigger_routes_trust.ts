import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A stored route's trust gate (S-trigger-trust-gating): who may start work through it, and which
 * items — `TriggerTrust` (`authors`, `githubPermission`, `createdAfter`) as one `jsonb` value.
 *
 * One column rather than three: the gate is one decision the seam reads whole, and per-repo policy as
 * config (S-factory-config-as-code) can carry it as one section. `NULL` is no gate, what every route
 * meant before; nothing is backfilled, because a gate an operator did not ask for would silently stop
 * work that starts today. The route's `created_at` is already the instant `createdAfter: "enabled"`
 * names, so no enable time is stored beside it. Idempotent: `IF NOT EXISTS`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE trigger_routes ADD COLUMN IF NOT EXISTS trust JSONB`;
});
