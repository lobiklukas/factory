import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { BoardColumn, VERIFIED_REQUIREMENT } from "@repo/domain/Task";

/**
 * The default pipeline, version 3: version 2's columns, with `review` requiring a passing
 * verification of the card's change before the card leaves it (docs/board.md B5, B8; LOB-80, part 3
 * of LOB-16).
 *
 * LOB-78 made a run's verification a record in its log and LOB-79 put it on the PR body; B8 makes
 * it what a gate checks, so `review → done` stops being a move a reviewer can make over a PR whose
 * evidence they skipped. `TaskService.move` checks the requirement against the `verify` records of
 * the card's runs and refuses the move, naming `verified`, when it is not met.
 *
 * **A new row rather than an update**, for 0010's reason: B2 says a definition version is never
 * edited in place, so a card pinned to version 1 or 2 keeps the exit it started under and only a
 * board on version 3 gets the gate. The column set is read back from version 2, so the only thing
 * this migration can get wrong is the one requirement it adds, and the requirement goes first in
 * `review`'s list because it is the one a refusal names.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  const previous = yield* sql<{ columns: string; name: string }>`
    SELECT columns::text AS columns, name
    FROM board_definitions
    WHERE id = 'default' AND version = 2
  `;
  const version2 = previous[0];
  // Nothing to version: 0010 did not run against this database, as 0010 itself tolerates 0007.
  if (version2 === undefined) return;

  const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));
  const columns = yield* Schema.decodeEffect(ColumnsJson)(version2.columns);
  const withVerified = columns.map((column) =>
    column.name !== "review" ||
    column.requires.some(
      (requirement) => requirement.key === VERIFIED_REQUIREMENT,
    )
      ? column
      : {
          ...column,
          requires: [
            {
              key: VERIFIED_REQUIREMENT,
              description:
                "a passing verification of every surface the card's change touched",
            },
            ...column.requires,
          ],
        },
  );
  const encoded = yield* Schema.encodeEffect(ColumnsJson)(withVerified);

  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns)
    VALUES ('default', 3, ${version2.name}, ${encoded}::jsonb)
    ON CONFLICT (id, version) DO NOTHING
  `;
});
