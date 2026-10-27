import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * When, and why, a session's worktree and branch were torn down (LOB-268).
 *
 * A session's workspace outlives its owner: the idle sweep and a shutdown release only the harness
 * and the log handle, and the worktree and branch stay for the next run. They are removed on a
 * terminal event alone — the card reaching `done` or `canceled`, the PR merging, or an operator
 * discarding the session — and this column is what remembers that one happened, so a read of the
 * session afterwards does not cut a fresh worktree at the base and a new run is refused rather than
 * started on an empty branch. `NULL` is a workspace that is still the session's, which every session
 * created before this column is.
 *
 * `workspace_release_reason` names the event (`done`, `canceled`, `merged`, `discarded`). Unlike the
 * other columns here this one is not refolded from the log: it records something done to the
 * filesystem, outside any log, and `rebuildIndexes` upserts the columns it derives and leaves these
 * two alone.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS workspace_released_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS workspace_release_reason TEXT
  `;
});
