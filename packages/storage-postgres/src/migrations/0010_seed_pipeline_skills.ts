import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { BoardColumn } from "@repo/domain/Task";

/**
 * The default pipeline, version 2: the same columns as 0007, with the seed's skills bound to the
 * stages that need them (docs/board.md B4, B6; LOB-174, part 3 of LOB-48).
 *
 * 0007 seeded every column with `skills: []`, because skills did not exist yet. 0009 then seeded
 * the three stage skills — `specify`, `implement`, `review` — "whose bodies encode the stages'
 * rules" (B6). This migration is the row that binds them: a run in `specifying` is told the
 * specifier's rules, one in `building` the implementer's, one in `review` the reviewer's, through
 * the loader at `openSession` (`packages/harness/src/loader.ts`).
 *
 * **A new row rather than an update.** B2 is explicit that a definition version is never edited in
 * place: a card pins the version it started under, so rewriting version 1 would change what work
 * already in flight is told. Version 2 is therefore added beside version 1, which stays exactly as
 * it was. A board instance on version 2 is what a run needs to get these sections; **no production
 * code creates a board instance yet** — `TaskService.create` only reads the version off an existing
 * row — so today a run gets them on a board the tests or a person made directly. That gap is the
 * board-creation path's, not this migration's.
 *
 * The column set is read back from version 1 rather than copied into this file, so the only thing
 * this migration can get wrong is the one thing it changes. Both reads and the insert are schema
 * decoded and encoded, as 0007's seed is, so a column set that does not satisfy `BoardColumn` fails
 * here rather than landing as a bad row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  /**
   * The skills 0009 seeds are the three working stages' rules (B6), so each lands on its stage.
   * `intake` and the two terminal columns stay empty: nothing runs there.
   */
  const STAGE_SKILLS: Readonly<Record<string, readonly string[]>> = {
    specifying: ["specify"],
    building: ["implement"],
    review: ["review"],
  };

  const previous = yield* sql<{ columns: string; name: string }>`
    SELECT columns::text AS columns, name
    FROM board_definitions
    WHERE id = 'default' AND version = 1
  `;
  const version1 = previous[0];
  // Nothing to version: 0007 did not run against this database. Not an error — a database that has
  // not been through the earlier migration has no pipeline to give skills to.
  if (version1 === undefined) return;

  const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));
  const columns = yield* Schema.decodeEffect(ColumnsJson)(version1.columns);
  const withSkills = columns.map((column) => ({
    ...column,
    skills: STAGE_SKILLS[column.name] ?? column.skills,
  }));
  const encoded = yield* Schema.encodeEffect(ColumnsJson)(withSkills);

  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns)
    VALUES ('default', 2, ${version1.name}, ${encoded}::jsonb)
    ON CONFLICT (id, version) DO NOTHING
  `;
});
