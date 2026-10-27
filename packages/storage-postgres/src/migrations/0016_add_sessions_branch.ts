import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The branch a session's worktree is cut on, in the index (LOB-197).
 *
 * The default branch is derived from the id (`factory/<session-id>`, D10) and needs no column, so
 * `NULL` means exactly that: no caller named one. A docs run names `factory/doc-<id>` because the
 * branch has to say what produced it, and the workspace, the PR step and the teardown all read the
 * same fact — a branch that only the create call knew would be re-derived differently by every
 * later read.
 *
 * Still derived, like every other column here: the log's `factory.session` document carries it and
 * `rebuildIndexes` refolds it, so dropping the row loses the list's answer, never the branch the
 * worktree is really on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS branch TEXT`;
});
