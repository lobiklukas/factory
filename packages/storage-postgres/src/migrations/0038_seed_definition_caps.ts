import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  BoardCaps,
  BoardColumn,
  DEFAULT_BOARD_CAPS,
  definitionProblems,
} from "@repo/domain/Task";

/**
 * Run caps become definition data (docs/board.md B9, LOB-71), and the default pipeline, version 5,
 * is the first version to carry them: 2 runs in flight per board, 1 per task, 2 per repository.
 *
 * The board, task and repository caps are the version's, so they are a new column,
 * `board_definitions.caps` (JSONB, `BoardCaps`); `NULL` is a version written before the column
 * existed, which caps nothing. A column's WIP limit is the column's, so it lives in the existing
 * `columns` JSONB as `BoardColumn.wipLimit` and needs no DDL; the default pipeline declares none
 * (the board cap already bounds every column to two). No new table.
 *
 * **A new row rather than an update**, for 0010's, 0018's and 0026's reason: B2 says a definition
 * version is never edited in place, and a card pins the version it started under — so the cards on
 * versions 1–4 keep starting runs uncapped, and only boards made from now on (`createBoard` pins the
 * newest) get the caps. Version 5 is version 4 read back with the caps added, held to
 * `definitionProblems` like 0026's seed and to `BoardCaps` by its own encoder.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE board_definitions
      ADD COLUMN IF NOT EXISTS caps JSONB
  `;

  const previous = yield* sql<{
    columns: string;
    name: string;
    initialColumn: string | null;
  }>`
    SELECT columns::text AS columns, name, initial_column
    FROM board_definitions
    WHERE id = 'default' AND version = 4
  `;
  const version4 = previous[0];
  // Nothing to version: 0026 did not run against this database, as 0026 itself tolerates 0018.
  if (version4 === undefined) return;

  const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));
  const columns = yield* Schema.decodeEffect(ColumnsJson)(version4.columns);
  const problems = definitionProblems({
    columns,
    ...(version4.initialColumn === null
      ? {}
      : { initialColumn: version4.initialColumn }),
  });
  if (problems.length > 0) {
    return yield* Effect.die(
      new Error(
        `default version 5 would not be usable: ${problems.join("; ")}`,
      ),
    );
  }
  const encodedColumns = yield* Schema.encodeEffect(ColumnsJson)(columns);
  const encodedCaps = yield* Schema.encodeEffect(
    Schema.fromJsonString(BoardCaps),
  )(DEFAULT_BOARD_CAPS);

  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns, initial_column, caps)
    VALUES (
      'default', 5, ${version4.name}, ${encodedColumns}::jsonb,
      ${version4.initialColumn}, ${encodedCaps}::jsonb
    )
    ON CONFLICT (id, version) DO NOTHING
  `;
});
