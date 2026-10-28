import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Skills kernel storage: a `skills` table holding named, versioned skill
 * documents (name, version, description, body markdown, attachments).
 * Seeded with the three stage skills: specify, implement, review.
 * (LOB-172, part 1 of LOB-48.)
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `;

  const seeds = [
    {
      name: "specify",
      description:
        "Turn a task into a checkable specification before implementation.",
      body: "# Specify\n\nClarify the goal, scope, acceptance criteria, and risks before writing code.\n",
    },
    {
      name: "implement",
      description:
        "Implement the smallest change that satisfies the acceptance criteria.",
      body: "# Implement\n\nMake the smallest change that meets the criteria; add tests as you go.\n",
    },
    {
      name: "review",
      description:
        "Review a change against standards and spec; report evidenced findings.",
      body: "# Review\n\nCheck the diff against the issue and repo standards; report P0/P1/P2 findings.\n",
    },
  ];

  // A seed is inserted only when no row has its name (`WHERE NOT EXISTS`, version the literal `1`).
  // It was `ON CONFLICT (name) DO NOTHING` until 0037 keyed skills by `(name, version)`, which left
  // that clause no constraint to name; this guard reads the same on the text column 0009 creates and
  // on the integer one 0037 makes, so running 0009 again on a migrated database changes nothing.
  for (const s of seeds) {
    yield* sql`
      INSERT INTO skills (name, version, description, body, attachments)
      SELECT ${s.name}, 1, ${s.description}, ${s.body}, '[]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = ${s.name})
    `;
  }
});
