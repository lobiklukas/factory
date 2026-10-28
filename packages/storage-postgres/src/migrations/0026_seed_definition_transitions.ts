import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  BoardColumn,
  DEFAULT_INITIAL_COLUMN,
  defaultPipelineTransitions,
  definitionProblems,
} from "@repo/domain/Task";

/**
 * Transitions, human gates and the initial column become definition data (docs/board.md B2, B4, B5;
 * LOB-267), and the default pipeline, version 4, is the first version to carry them.
 *
 * Until now the moves each column allows and the two human gates were code tables keyed on the
 * default pipeline's column names (`DECLARED_TRANSITIONS`, `HUMAN_GATES`), and a new card always
 * started in `intake`, so a definition whose columns differ had no legal moves. A column now declares
 * `transitions: [{ to, gate? }]`, and a definition its `initialColumn`, which is this migration's new
 * `board_definitions.initial_column`. `NULL` there is a version written before the column existed,
 * which starts a card in its first column (`initialColumnOf`) — `intake` in versions 1–3.
 *
 * **A new row rather than an update**, for 0010's and 0018's reason: B2 says a definition version is
 * never edited in place. Versions 1–3 stay exactly as they were, and a card pinned to one keeps
 * resolving its moves through the code table, which is kept for them (`columnTransitions`). Version 4
 * is version 3's columns read back, each with exactly the table's moves for its name written on it,
 * so the only thing this migration can get wrong is the copy of the table — and the copy is the
 * table's own function, `defaultPipelineTransitions`. The seed is held to `definitionProblems`
 * before it is written: a move to a column version 3 does not declare fails here, not on a card.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE board_definitions
      ADD COLUMN IF NOT EXISTS initial_column TEXT
  `;

  const previous = yield* sql<{ columns: string; name: string }>`
    SELECT columns::text AS columns, name
    FROM board_definitions
    WHERE id = 'default' AND version = 3
  `;
  const version3 = previous[0];
  // Nothing to version: 0018 did not run against this database, as 0018 itself tolerates 0010.
  if (version3 === undefined) return;

  const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));
  const columns = yield* Schema.decodeEffect(ColumnsJson)(version3.columns);
  const withTransitions = columns.map((column) => ({
    ...column,
    transitions: defaultPipelineTransitions(column.name),
  }));
  const problems = definitionProblems({
    columns: withTransitions,
    initialColumn: DEFAULT_INITIAL_COLUMN,
  });
  if (problems.length > 0) {
    return yield* Effect.die(
      new Error(
        `default version 4 would not be usable: ${problems.join("; ")}`,
      ),
    );
  }
  const encoded = yield* Schema.encodeEffect(ColumnsJson)(withTransitions);

  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns, initial_column)
    VALUES ('default', 4, ${version3.name}, ${encoded}::jsonb, ${DEFAULT_INITIAL_COLUMN})
    ON CONFLICT (id, version) DO NOTHING
  `;
});
