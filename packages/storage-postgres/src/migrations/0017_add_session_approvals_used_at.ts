import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * When an approval was spent, in the index (LOB-52, D15).
 *
 * An approval covers one run of the gated call it names. The approvals service commits a
 * `factory.approval.used` entry when it answers a gated call `approved`, and sets this column beside
 * it, so the next identical call reads a used row and asks a person again under a new request id
 * instead of running on the old yes. `NULL` is an approval still unused, or a request that was never
 * approved: only an approved row can be used.
 *
 * Derived like every other column here: `rebuildIndexes` refolds the `used` entries, so dropping the
 * row loses the index's answer, never the fact that an approval was spent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE session_approvals ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ`;
  yield* sql`
    ALTER TABLE session_approvals DROP CONSTRAINT IF EXISTS session_approvals_used_approved
  `;
  yield* sql`
    ALTER TABLE session_approvals ADD CONSTRAINT session_approvals_used_approved
    CHECK (used_at IS NULL OR decision = 'approved')
  `;
});
