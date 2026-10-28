#!/usr/bin/env bun
// Seed a board over a definition whose columns are not the default pipeline's (LOB-267), for the
// card pane's "only the declared moves" check (`features/card-pane.md`): todo → doing → done, with a
// `sign-off` gate on doing → done, `todo` as the initial column, and a `review` column that declares
// no moves at all — a default pipeline name, so a pane that offered the default table by name would
// show moves here.
//
// The definition row is written as a migration writes one (an `INSERT` of a new id and version 1 —
// no RPC authors a definition yet); the board is made by `TaskService.createBoard`, the writer
// `factory board create` reaches, and the card by `TaskService.create`, so the card's column is the
// one `create` resolved from the definition, never one this script names.
//
// Prints one JSON line: {"definitionId":"syn…","boardId":"brd_…","taskId":"tsk_…","column":"todo",
// "revision":1}.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TaskService, TaskServiceLive } from "@repo/core";
import { RepoSlug } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const COLUMNS = [
  {
    name: "todo",
    kind: "resting",
    skills: [],
    requires: [],
    transitions: [{ to: "doing" }],
  },
  {
    name: "doing",
    kind: "working",
    skills: [],
    requires: [],
    transitions: [{ to: "done", gate: "sign-off" }],
  },
  { name: "review", kind: "working", skills: [], requires: [] },
  {
    name: "done",
    kind: "terminal",
    skills: [],
    requires: [],
    transitions: [],
  },
];

const program = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;
  const definitionId = DefinitionId.make(`syn${hex(4)}`);
  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns, initial_column)
    VALUES (${definitionId}, 1, 'Synthetic todo', ${JSON.stringify(COLUMNS)}::jsonb, 'todo')
  `;
  const board = yield* tasks.createBoard({
    repo: RepoSlug.make(`verify-web/synthetic-${hex(6)}`),
    definitionId,
  });
  const task = yield* tasks.create({
    boardId: board.id,
    title: "verify-web synthetic card",
    actor: "cli",
  });
  return JSON.stringify({
    definitionId,
    boardId: board.id,
    taskId: task.id,
    column: task.column,
    revision: task.revision,
  });
});

Effect.runPromise(
  program.pipe(
    Effect.provide(TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive))),
  ),
).then(
  (line) => {
    console.log(line);
    process.exit(0);
  },
  (error) => {
    console.error(`seed-definition: ${String(error)}`);
    process.exit(1);
  },
);
