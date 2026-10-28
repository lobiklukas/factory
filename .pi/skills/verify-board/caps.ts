#!/usr/bin/env bun
// The facts `caps.sh` (LOB-71) cannot make or read from a terminal: a definition with caps of its
// own, a second board over one repository, and what a refused start wrote.
//
//   MODE=define                    a fresh definition `verify-caps-<hex>` with two versions, written
//                                  as a migration writes one (definitions have no authoring path
//                                  yet): v1 caps board 2 · task 1 · repo 2 and gives `review` a WIP
//                                  limit of 1; v2 caps board 3 · task 1 · repo 3 and no WIP limit.
//                                  Both are the default pipeline's newest columns otherwise. Prints
//                                  the id.
//   MODE=second-board REPO=… DEFINITION_ID=… VERSION=…
//                                  a second board instance over REPO, pinned to VERSION. Written as
//                                  an insert: `createBoard` makes one board per repository (more is
//                                  deferred board customization), and the repo cap is what holds the
//                                  line across boards. Prints the id.
//   MODE=writes TASK_ID=…          {"runs":N,"sessions":M,"logs":L}: the card's `task_runs` rows, and
//                                  every session row and session log in the database — what a
//                                  refused start must not add to.
//
// Env: MODE, DATABASE_URL, and the mode's own. Exits non-zero when the write or read fails.
import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { BoardColumn } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";

const MODE = process.env["MODE"] ?? "";
const env = (key: string) => process.env[key] ?? "";

class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
}) {}

const ColumnsJson = Schema.fromJsonString(Schema.Array(BoardColumn));

const define = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const newest = yield* sql<{
    columns: string;
    initialColumn: string | null;
  }>`
    SELECT columns::text AS columns, initial_column FROM board_definitions
    WHERE id = 'default' ORDER BY version DESC LIMIT 1
  `;
  const row = newest[0];
  if (row === undefined)
    return yield* new ProbeError({ message: "no default definition" });
  const columns = yield* Schema.decodeEffect(ColumnsJson)(row.columns);
  const id = `verify-caps-${randomBytes(4).toString("hex")}`;
  const versions = [
    {
      caps: { board: 2, task: 1, repo: 2 },
      columns: columns.map((column) =>
        column.name === "review" ? { ...column, wipLimit: 1 } : column,
      ),
    },
    { caps: { board: 3, task: 1, repo: 3 }, columns },
  ];
  for (const [index, version] of versions.entries()) {
    const encoded = yield* Schema.encodeEffect(ColumnsJson)(version.columns);
    yield* sql`
      INSERT INTO board_definitions (id, version, name, columns, initial_column, caps)
      VALUES (${id}, ${index + 1}, ${`verify-board caps v${index + 1}`}, ${encoded}::jsonb,
              ${row.initialColumn}, ${JSON.stringify(version.caps)}::jsonb)
    `;
  }
  return id;
});

const secondBoard = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const id = `brd_${randomBytes(13).toString("hex")}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${id}, ${env("REPO")}, ${env("DEFINITION_ID")}, ${Number(env("VERSION"))})
  `;
  return id;
});

const writes = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ runs: number; sessions: number; logs: number }>`
    SELECT
      (SELECT count(*)::int FROM task_runs WHERE task_id = ${env("TASK_ID")}) AS runs,
      (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(DISTINCT log_id)::int FROM commits) AS logs
  `;
  return JSON.stringify(rows[0]);
});

const modes: Record<
  string,
  Effect.Effect<string, ProbeError | SqlError | Schema.SchemaError, SqlClient>
> = {
  define,
  "second-board": secondBoard,
  writes,
};

const chosen = modes[MODE];
if (chosen === undefined) {
  console.error(`unknown MODE ${MODE}: define | second-board | writes`);
  process.exit(2);
}

const exit = await Effect.runPromiseExit(
  chosen.pipe(Effect.provide(DatabaseLive)),
);
if (exit._tag === "Failure") {
  console.error(`caps.ts ${MODE}: ${String(exit.cause)}`);
  process.exit(1);
}
console.log(exit.value);
process.exit(0);
