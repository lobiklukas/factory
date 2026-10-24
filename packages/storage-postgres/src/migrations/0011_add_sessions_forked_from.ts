import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The session a fork was taken from, on the index row (LOB-180).
 *
 * A fork is its own session — its own log, its own worktree — and its lineage is committed into
 * that log as a `factory.fork` document beside this column, so `rebuildIndexes` re-derives it from
 * the log rather than trusting the row (D7). It lives here because every `SessionSummary` carries
 * it and a summary must never fold a log.
 *
 * Existing rows keep `NULL`: a session that was not forked has no parent, and inventing one would
 * be a claim about its history. No foreign key back to `sessions`: the column is an index of the
 * log's own document, and the logs of both sides outlive any index (a rebuild rewrites both).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN forked_from TEXT`;
});
