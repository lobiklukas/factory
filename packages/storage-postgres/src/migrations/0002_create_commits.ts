import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The append-only commit log (docs/design.md D7). Everything else is a fold of this table.
 *
 * - `log_id` namespaces one Pi Durable `Storage` (one session) inside a shared database.
 * - `seq` is the sequence Pi Durable assigned to the commit. It is **not** a `bigserial`: the
 *   owning process mints it, and `PRIMARY KEY (log_id, seq)` is what fences a second owner,
 *   because the second writer's insert collides instead of silently forking the log.
 * - `writes` is `json`, not `jsonb`, on purpose. Pi Durable's contract requires strings to
 *   round-trip unchanged, including lone surrogates (the conformance suite checks one) and
 *   U+0000 from tool output; `jsonb` rejects both. Nothing queries inside `writes`: reads fold
 *   it in the application, and derived tables are projections of that fold.
 * - Rows are immutable. A trigger rejects UPDATE and DELETE so "the log is truth" is enforced
 *   by the database rather than by convention. TRUNCATE is deliberately still allowed for tests.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE commits (
      log_id TEXT NOT NULL,
      seq BIGINT NOT NULL CHECK (seq >= 1),
      writes JSON NOT NULL,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (log_id, seq)
    )
  `;

  yield* sql`
    CREATE FUNCTION commits_reject_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commits is append-only (% rejected)', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `;

  yield* sql`
    CREATE TRIGGER commits_append_only
    BEFORE UPDATE OR DELETE ON commits
    FOR EACH ROW EXECUTE FUNCTION commits_reject_mutation()
  `;
});
