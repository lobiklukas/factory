import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The repo registry (docs/features.md §3 A1): which repositories sessions may bind to, where they
 * are cloned from, and which ref a session starts at.
 *
 * Like `sessions`, this table is a droppable index over facts that outlive it: a session commits
 * its own repo binding into its log (`factory.session`), so `rebuildIndexes` can reconstruct which
 * repos sessions have used. What only this table knows is the clone URL and the local checkout —
 * operator input, not a derivation — and a rebuild preserves them.
 *
 * `slug` is `owner/name` in lowercase, the same string a branch (D10), a credential (D14), and a
 * trigger bind to. `url` is empty until someone registers it: a session that names an unregistered
 * repo still opens, it just cannot be cloned yet.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE repos (
      slug TEXT PRIMARY KEY,
      url TEXT NOT NULL DEFAULT '',
      default_base_ref TEXT NOT NULL DEFAULT 'main',
      local_path TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
});
