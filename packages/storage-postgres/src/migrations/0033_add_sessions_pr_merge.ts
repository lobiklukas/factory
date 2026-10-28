import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * When a session's PR merged, and when a later PR reverted it (LOB-44): the index of the session's
 * `factory.merge` document, which the GitHub webhook commits when it reports the merge or the revert.
 *
 * Derived, like `pr_url` (0012): `rebuildIndexes` refolds both columns from the log, so dropping
 * them costs the outcome metrics their numbers until a rebuild, not the facts. `NULL` is "no merge
 * recorded" and "not reverted" — every session before this column, and any whose PR has not merged.
 * Nothing is backfilled: the merges before it were never recorded anywhere the factory can read.
 *
 * Idempotent: `IF NOT EXISTS`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS pr_merged_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pr_reverted_at TIMESTAMPTZ
  `;
});
