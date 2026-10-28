import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Skills keyed by `(name, version)`: one row per edit, never a rewrite (docs/board.md B2, B6).
 *
 * 0009 made `name` the primary key, so writing a skill replaced the row in place — and a run that
 * was reopened after the write read the new body, not the one it opened with. This turns the table
 * into a history:
 *
 * - `version` becomes an integer, and **every row that exists becomes version 1**: there is exactly
 *   one row per name before this runs, so each is its skill's first version in the new history,
 *   whatever text 0009's column held.
 * - The primary key is `(name, version)`; `putSkill` inserts `newest + 1` (`@repo/core`'s
 *   `SkillService.put`) and nothing updates a row.
 * - `created_at` and `author` say when and by whom a version was put (LOB-20's actor); the existing
 *   rows get the time this ran and no author.
 *
 * Every skill seed inserts version `1` guarded by `WHERE NOT EXISTS` on the name, as 0009, 0015, 0022
 * and 0036 now do — a guard that reads the same before this migration and after it, which is what
 * lets their suites run them again on a migrated database. `ON CONFLICT (name)` no longer has a
 * constraint to name, so a seed that still used it would fail when it ran after this one.
 *
 * Idempotent: the conversion runs only while the column is still `text`, so a second pass leaves a
 * history with many versions per name exactly as it is.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  const columns = yield* sql<{ dataType: string }>`
    SELECT data_type AS "dataType"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'skills'
      AND column_name = 'version'
  `;
  if (columns[0]?.dataType === "text") {
    yield* sql`ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_pkey`;
    yield* sql`ALTER TABLE skills ALTER COLUMN version TYPE INTEGER USING 1`;
    yield* sql`ALTER TABLE skills ADD PRIMARY KEY (name, version)`;
  }
  yield* sql`
    ALTER TABLE skills
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS author TEXT NOT NULL DEFAULT ''
  `;
  const checks = yield* sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE conname = 'skills_version_positive'
      AND conrelid = 'skills'::regclass
  `;
  if ((checks[0]?.n ?? 0) === 0) {
    yield* sql`
      ALTER TABLE skills ADD CONSTRAINT skills_version_positive CHECK (version >= 1)
    `;
  }
});
