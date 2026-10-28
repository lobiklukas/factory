import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A definition version records who wrote it (F7). `board_definitions.author` is the control-plane
 * actor behind a `defineBoard` — the credential's actor, as a skill version's `author` is (0037) —
 * so nobody has to guess who published a version.
 *
 * Nullable, unlike a skill's: a version written before this column, and every seeded version, has no
 * author, and `NULL` is what says so (a reader shows it as absent, never as an empty name). No row is
 * touched. `ADD COLUMN IF NOT EXISTS`, so a second run is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE board_definitions
      ADD COLUMN IF NOT EXISTS author TEXT
  `;
});
