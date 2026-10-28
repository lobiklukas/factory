import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Stored trigger routes (LOB-266): which label or team starts work on which registered repo.
 *
 * Until now the mapping was `TRIGGER_RULES`, read once per process, so changing where a label goes
 * meant an env edit and a restart. A route is a row on the repo registry instead: the trigger seam
 * reads the table per delivery, and `TRIGGER_RULES` is the fallback for an event no row claims.
 *
 * Operator input, like `repos.url`: nothing in a session's log says which label meant which repo, so
 * `rebuildIndexes` does not touch this table. `repo` references the registry, so a route cannot name
 * a repo nobody registered (the RPC refuses it first, with a message), and a route cannot outlive its
 * repo. A route names a label, a team, or both; one that names neither would claim nothing, and the
 * check refuses it. `id` is minted by the server (`trr_…`) and is what a delivery's recorded reason
 * names. Idempotent: `IF NOT EXISTS`, so a second run leaves the rows alone.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trigger_routes (
      id TEXT PRIMARY KEY,
      label TEXT,
      team TEXT,
      repo TEXT NOT NULL REFERENCES repos (slug) ON DELETE CASCADE,
      base_ref TEXT,
      prompt TEXT NOT NULL,
      starts_work_for TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (label IS NOT NULL OR team IS NOT NULL),
      CHECK (label <> '' AND team <> '')
    )
  `;
});
