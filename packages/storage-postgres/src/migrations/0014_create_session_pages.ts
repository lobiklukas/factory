import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The derived index of a session's cited knowledge pages (LOB-204, part 1 of LOB-47).
 *
 * A page's truth is its log: `factory.page` documents are what a reader asks for by name, and the
 * `factory.page` entries are what a fold can enumerate. This table is neither — it is the read path
 * `listPages` needs, so listing a session's pages costs one query instead of an enumeration the
 * document store does not offer (a family member is read by key).
 *
 * Which is why `rebuildIndexes` refolds it: deleting every row here and rebuilding has to reproduce
 * the pages exactly, and that is the case its test asserts.
 *
 * `links` and `sources` are `jsonb` but are read and written as JSON text, encoded and decoded by a
 * Schema codec in the service, so a stored value round-trips through `readonly string[]` rather than
 * whatever the driver chose to do with the column. `sources` is deliberately not a foreign key: a
 * citation names a session that may no longer exist, and the page still has to read back.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS`, so a second migration run leaves the table and its rows
 * untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_pages (
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (session_id, name)
    )
  `;
});
