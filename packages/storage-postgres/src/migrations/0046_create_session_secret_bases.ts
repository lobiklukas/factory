import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The commit a session's secret grant is read at (S-agent-secrets): one row per session, written the
 * first time its owner opens with a repo checkout to read `.factory/config` from, and never changed.
 *
 * Why a row and not the ref: `@repo/core`'s grant reads which stored secrets a session's commands get
 * from the config at the session's base, never its branch. In a local checkout the agent's own shell
 * shares the checkout's refs, so a base re-resolved on every open is one the agent can move onto a
 * commit of its own that declares every name. The commit is resolved before the session's agent has
 * run, pinned here, and every later open reads the config at it.
 *
 * Control-plane state like `secrets`, not an index of the log: `rebuildIndexes` neither writes nor
 * clears it. A session with no row (one older than this table) is pinned at its next open.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_secret_bases (
      session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
      base_commit TEXT NOT NULL CHECK (base_commit ~ '^[0-9a-f]{40,64}$'),
      pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
});
