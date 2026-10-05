import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The session's repo binding, on the index row (docs/features.md §3 A1).
 *
 * A session's repo and base ref are committed into its log as well (`factory.session`), so these
 * columns are a cache of the log rather than the only copy: `rebuildIndexes` re-derives them, and
 * `createSession` writes both at once. They live here because every `SessionSummary` carries them
 * and a summary must never fold a log.
 *
 * Existing rows keep `NULL` — the binding did not exist when they were created, and inventing one
 * from the id would be guessing. `base_ref` is only meaningful next to a repo, so they are set and
 * cleared together.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN repo TEXT`;
  yield* sql`ALTER TABLE sessions ADD COLUMN base_ref TEXT`;
  yield* sql`
    ALTER TABLE sessions
    ADD CONSTRAINT sessions_base_ref_requires_repo
    CHECK (base_ref IS NULL OR repo IS NOT NULL)
  `;
});
