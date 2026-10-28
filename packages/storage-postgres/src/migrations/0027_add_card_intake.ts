import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A mapped trigger delivery can put a card on the repo's board (LOB-254).
 *
 * - `tasks.external_url` is where a person opens the tracker issue a card was filed from — a Linear
 *   issue's own link — which the card pane renders beside `external_ref`. `NULL` is none: every card
 *   made before this column, and any card filed with no link. Input, like `external_ref`: written
 *   into the row and the `created` event in one transaction, so the card stays derivable from its
 *   history (B3). Nothing is backfilled.
 * - `trigger_routes.mode` is what a delivery the route maps starts: `session` (a bare session, what
 *   every route meant before) or `card`. `NULL` is `session`, so existing rows mean what they meant.
 *
 * Idempotent: `IF NOT EXISTS`, and the check is added only when the column is.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS external_url TEXT
  `;
  yield* sql`
    ALTER TABLE trigger_routes
      ADD COLUMN IF NOT EXISTS mode TEXT CHECK (mode IN ('session', 'card'))
  `;
});
