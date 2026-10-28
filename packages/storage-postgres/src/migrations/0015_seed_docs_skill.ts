import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The `docs` skill: the fixed prompt a documentation run holds (LOB-225, part 1 of LOB-195).
 *
 * A skill is a factory-owned record (docs/board.md B6) and this one is seeded rather than authored,
 * exactly as 0009 seeds the three stage skills, because a docs run's rules are not an operator's
 * choice: the run edits documentation and nothing else. Part 2 of LOB-195 is what enforces that
 * through the policy seam; this row is only what the run is told, and nothing selects it by name
 * yet — no column declares the `docs` skill, so the shipped default pipeline is unchanged (B4's
 * columns keep the skills 0010 bound to them).
 *
 * **A new row, never an update.** The insert runs only when no row has the name (`WHERE NOT EXISTS`;
 * it was `ON CONFLICT (name)` until 0037 keyed skills by name and version), so a second pass over a
 * database that already holds the row — any version of it — changes nothing, which is also why this
 * migration cannot rewrite `specify`, `implement` or `review`: it names one name.
 *
 * The body states the three rules a docs run works under, in the form the loader injects as a
 * prompt section (`packages/harness/src/loader.ts`): edit documentation, never code; make the
 * smallest edit that is true; list what changed so the PR body can carry it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    INSERT INTO skills (name, version, description, body, attachments)
    SELECT
      'docs',
      1,
      'Update documentation only: the smallest edit that is true, listed for the PR body.',
      ${"# Docs\n\nEdit the documentation, not the code. A docs run changes prose, tables and examples in markdown; it never changes a source file.\n\nMake the smallest edit that is true. Correct what the code made wrong and leave the rest alone — a docs run that rewrites a page it did not need to is a review the PR body cannot justify.\n\nList what changed: each file, and the one sentence that says why, so the pull request body can carry it.\n"},
      '[]'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = 'docs')
  `;
});
