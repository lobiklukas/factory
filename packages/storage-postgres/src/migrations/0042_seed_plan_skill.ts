import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  BoardCaps,
  BoardColumn,
  definitionProblems,
} from "@repo/domain/Task";

/**
 * The planning stage gets its rules (docs/board.md B4, B6; D10): a seeded `plan` skill, and the
 * default pipeline, version 6, binding it to `planning`.
 *
 * 0009 seeded the three stage skills and 0010 bound them to `specifying`, `building` and `review`;
 * `planning` was left with none, so a run there was told nothing about its stage and could only
 * answer in prose. The planner is now a read-only stage offered a `plan` tool (`@repo/harness`'s
 * `./rolePolicy` and `./planning`), and `plan_doc` is checked on the way out (`@repo/core`'s
 * `./requirements`): this is the text that tells the run so.
 *
 * - **The skill: a new row, never an update.** Inserted only when no row has the name (`WHERE NOT
 *   EXISTS`, as 0015 and 0036 seed theirs), so an operator's own `plan` — any version — is kept.
 * - **The version: a new row rather than an update**, for 0010's and 0038's reason: B2 says a
 *   definition version is never edited in place, and a card pins the version it started under. So
 *   cards on versions 1–5 keep a planning column with no skill — their planners are still read-only
 *   and offered the tool, because both follow the role, not the skill — and boards made from now on
 *   (`createBoard` pins the newest) get it. Version 6 is version 5 read back, caps and initial column
 *   included, with `plan` added to `planning`'s skills, held to `definitionProblems` before it is
 *   written. A database where version 5 is missing (0038 did not run) gets the skill and no version;
 *   one that already holds a version 6 (`ON CONFLICT`) keeps it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    INSERT INTO skills (name, version, description, body, attachments)
    SELECT
      'plan',
      1,
      'Plan the change a card asks for, for a person to approve before any code is written: steps, surfaces and risks, declared with the plan tool.',
      ${"# Plan\n\nYou plan; you do not build. This stage is read-only: you may read and search the repository, and nothing you run may change it.\n\nRead the card, its spec and its thread, then the code the change will touch. Declare the plan with the `plan` tool, once you know it:\n\n- `summary`: the change in one statement.\n- `steps`: what the building run will do, in order, each a step a reviewer could check off.\n- `surfaces`: the packages and apps the change touches (`apps/web`, `packages/core`, or the `verify-<surface>` names), so the building column knows what it must verify.\n- `risks`: what could go wrong — a migration, a shared file, a behaviour a test pins. `[]` when there are none; leaving it out is refused.\n\nAgents overestimate scope: plan the smallest change that meets the spec's acceptance, and nothing it does not ask for. A person approves the plan by moving the card on; do not move it yourself. If the spec leaves a question you cannot answer from the code, ask it with the ask tool rather than guessing.\n"},
      '[]'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = 'plan')
  `;

  const previous = yield* sql<{
    columns: string;
    name: string;
    initialColumn: string | null;
    caps: string | null;
  }>`
    SELECT columns::text AS columns, name, initial_column, caps::text AS caps
    FROM board_definitions
    WHERE id = 'default' AND version = 5
  `;
  const version5 = previous[0];
  // Nothing to version: 0038 did not run against this database, as 0038 itself tolerates 0026.
  if (version5 === undefined) return;

  const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));
  const columns = yield* Schema.decodeEffect(ColumnsJson)(version5.columns);
  const withPlan = columns.map((column) =>
    column.name === "planning" && !column.skills.includes("plan")
      ? { ...column, skills: [...column.skills, "plan"] }
      : column,
  );
  const problems = definitionProblems({
    columns: withPlan,
    ...(version5.initialColumn === null
      ? {}
      : { initialColumn: version5.initialColumn }),
  });
  if (problems.length > 0) {
    return yield* Effect.die(
      new Error(
        `default version 6 would not be usable: ${problems.join("; ")}`,
      ),
    );
  }
  const encodedColumns = yield* Schema.encodeEffect(ColumnsJson)(withPlan);
  // The caps are version 5's, read back through their own schema so a malformed row fails here.
  const caps =
    version5.caps === null
      ? null
      : yield* Schema.encodeEffect(Schema.fromJsonString(BoardCaps))(
          yield* Schema.decodeEffect(Schema.fromJsonString(BoardCaps))(
            version5.caps,
          ),
        );

  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns, initial_column, caps)
    VALUES (
      'default', 6, ${version5.name}, ${encodedColumns}::jsonb,
      ${version5.initialColumn}, ${caps}::jsonb
    )
    ON CONFLICT (id, version) DO NOTHING
  `;
});
