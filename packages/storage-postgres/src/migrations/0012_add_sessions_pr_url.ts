import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The session's PR link, in the index (LOB-177).
 *
 * A column on `sessions` rather than a fold: the session list answers without reading a log (R6),
 * and the link has to be on a row for the list to carry it. It is still derived — the log's
 * `factory.pr` document is the truth and `rebuildIndexes` refolds it into this column — so
 * dropping the row loses the list's timeliness, never the link.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pr_url TEXT`;
});
