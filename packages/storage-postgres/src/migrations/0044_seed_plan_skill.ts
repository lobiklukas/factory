import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { BoardCaps, BoardColumn, definitionProblems } from "@repo/domain/Task";

/**
 * The planning stage gets its rules (docs/board.md B4, B6; D10): a seeded `plan` skill, and a new
 * version of the default pipeline binding it to `planning`.
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
 *   cards on earlier versions keep a planning column with no skill — their planners are still
 *   read-only and offered the tool, because both follow the role, not the skill — and boards made
 *   from now on (`createBoard` pins the newest) get it.
 * - **At the newest version + 1, never a fixed number** (docs/board.md, "Seed migrations and
 *   authored versions share one id space"): since D4 an operator may author `default` v6 or later,
 *   and a seed of a fixed v6 would then do nothing, silently. `bindPlanSkill` takes the advisory
 *   lock `defineBoard` takes, reads the id's newest version — whoever wrote it — and writes that
 *   version back with `plan` added to `planning`'s skills, caps and initial column included, held to
 *   `definitionProblems` first. On a database whose newest is 0038's v5 that is v6. Nothing is
 *   written when the id has no version, the newest has no `planning` column, or its `planning`
 *   already binds `plan` — so a second pass writes no second row.
 */
/**
 * Bind `plan` to `planning` on `definitionId`'s newest version, as a new version (newest + 1), under
 * the definition's advisory lock. Exported so the storage suite can drive it on an id of its own,
 * with an authored newest version already in place, without touching the shared `default`.
 */
export const bindPlanSkill = (definitionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          SELECT pg_advisory_xact_lock(hashtext(${`board_definitions:${definitionId}`}))
        `;
        const rows = yield* sql<{
          version: number;
          columns: string;
          name: string;
          initialColumn: string | null;
          caps: string | null;
        }>`
          SELECT version, columns::text AS columns, name, initial_column, caps::text AS caps
          FROM board_definitions
          WHERE id = ${definitionId}
          ORDER BY version DESC
          LIMIT 1
        `;
        const newest = rows[0];
        // Nothing to version: the id was never seeded here (0038 tolerates a missing 0026 the same way).
        if (newest === undefined) return;

        const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));
        const columns = yield* Schema.decodeEffect(ColumnsJson)(newest.columns);
        const planning = columns.find((column) => column.name === "planning");
        // An operator's pipeline with no planning column, or one that already binds the skill (a
        // second pass, or an author who bound it first): there is nothing to add.
        if (planning === undefined || planning.skills.includes("plan")) return;

        const withPlan = columns.map((column) =>
          column.name === "planning"
            ? { ...column, skills: [...column.skills, "plan"] }
            : column,
        );
        const version = newest.version + 1;
        const problems = definitionProblems({
          columns: withPlan,
          ...(newest.initialColumn === null
            ? {}
            : { initialColumn: newest.initialColumn }),
        });
        if (problems.length > 0) {
          return yield* Effect.die(
            new Error(
              `${definitionId} version ${version} would not be usable: ${problems.join("; ")}`,
            ),
          );
        }
        const encodedColumns =
          yield* Schema.encodeEffect(ColumnsJson)(withPlan);
        // The caps are the newest version's, read back through their own schema so a malformed row
        // fails here.
        const caps =
          newest.caps === null
            ? null
            : yield* Schema.encodeEffect(Schema.fromJsonString(BoardCaps))(
                yield* Schema.decodeEffect(Schema.fromJsonString(BoardCaps))(
                  newest.caps,
                ),
              );

        yield* sql`
          INSERT INTO board_definitions (id, version, name, columns, initial_column, caps)
          VALUES (
            ${definitionId}, ${version}, ${newest.name}, ${encodedColumns}::jsonb,
            ${newest.initialColumn}, ${caps}::jsonb
          )
        `;
      }),
    );
  });

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

  yield* bindPlanSkill("default");
});
