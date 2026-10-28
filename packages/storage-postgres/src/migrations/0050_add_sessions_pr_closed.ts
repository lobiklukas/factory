import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * When a session's PR was closed without merging (F12): the index of the `closedAt` the GitHub
 * webhook — or the PR-state read when the card is opened (C20) — commits on the session's
 * `factory.merge` document. A card's later run adopts the card's PR only while this is `NULL` and
 * `pr_merged_at` is too, so a run after an unmerged close opens a fresh PR rather than pushing onto a
 * branch nobody will review.
 *
 * Derived, like `pr_merged_at` (0033): `rebuildIndexes` refolds it from the log. `NULL` is "no close
 * recorded" — every session before this column. Nothing is backfilled: the closes before it were
 * never recorded anywhere the factory can read, and a card whose PR was closed then is still blocked
 * `pr_closed` (0047), which a person settles.
 *
 * Idempotent: `IF NOT EXISTS`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS pr_closed_at TIMESTAMPTZ
  `;
});
