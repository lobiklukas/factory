import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Who a session's spend is attributed to, in the index (LOB-162, part 2 of LOB-17).
 *
 * `NULL` means nobody was: every session created before this column, and any caller that named no
 * actor. The spend pane groups those as unattributed rather than guessing, so the backfill is
 * deliberately none — an actor invented for history would be a lie the pane then sums.
 *
 * Derived, like every other column here: the log's `factory.actor` document carries the actor and
 * `rebuildIndexes` refolds it. Where the value comes from is a caller's declaration today, as an
 * approval decision's actor is; LOB-20's credential changes that source, not this column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS actor TEXT`;
});
