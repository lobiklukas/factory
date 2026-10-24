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
      version: "1",
      description:
        "Turn a task into a checkable specification before implementation.",
      body: "# Specify\n\nClarify the goal, scope, acceptance criteria, and risks before writing code.\n",
    },
    {
      name: "implement",
      version: "1",
      description:
        "Implement the smallest change that satisfies the acceptance criteria.",
      body: "# Implement\n\nMake the smallest change that meets the criteria; add tests as you go.\n",
    },
    {
      name: "review",
      version: "1",
      description:
        "Review a change against standards and spec; report evidenced findings.",
      body: "# Review\n\nCheck the diff against the issue and repo standards; report P0/P1/P2 findings.\n",
    },
  ];

  for (const s of seeds) {
    yield* sql`
      INSERT INTO skills (name, version, description, body, attachments)
      VALUES (${s.name}, ${s.version}, ${s.description}, ${s.body}, '[]'::jsonb)
      ON CONFLICT (name) DO NOTHING
    `;
  }
});
