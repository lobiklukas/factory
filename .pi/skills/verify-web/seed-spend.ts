#!/usr/bin/env bun
// Seed the spend drive's board (LOB-162), through the real `TaskService` against the run's
// `DATABASE_URL` — the database `spend.sh` started the API with.
//
//   REPO=verify-spend-<tag>/board bun seed-spend.ts
//
// One board instance on `REPO` and two cards in `specifying`, a working column, so a run can be
// started on each: one by `factory board start` (actor `cli`), one by the card pane's **Start run**
// (actor `dashboard`). The repo is the drive's own, so the (repo, actor) pairs those two runs land in
// hold nothing else, and the drive can require each to hold exactly one session.
//
// The column is written directly rather than moved into: a move is the card pane's subject, and the
// spend drive proves only who a run started from a card is attributed to.
//
// Prints one JSON line: {"boardId":"brd_…","repo":"…","cli":"tsk_…","dashboard":"tsk_…"}.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TaskService, TaskServiceLive } from "@repo/core";
import { DatabaseLive } from "@repo/storage-postgres";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const REPO = process.env["REPO"] ?? "";
const ACTOR = "person:verify-spend";

const program = Effect.gen(function* () {
  if (REPO === "") return yield* Effect.fail("REPO is required");
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;

  const boardId = `brd_${hex(13)}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${REPO}, 'default', 1)
  `;
  const ids: Record<string, string> = {};
  for (const key of ["cli", "dashboard"]) {
    const task = yield* tasks.create({
      boardId,
      title: `spend: a run started by ${key}`,
      // The board's repo, which the card would inherit unnamed too (LOB-255): every run started
      // from it is bound to that repo.
      repo: REPO,
      actor: ACTOR,
    });
    yield* sql`
      UPDATE tasks SET "column" = 'specifying', revision = revision + 1, updated_at = now()
      WHERE id = ${task.id}
    `;
    ids[key] = task.id;
  }
  return { boardId, repo: REPO, ...ids };
});

Effect.runPromise(
  program.pipe(
    Effect.provide(TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive))),
  ),
).then(
  (out) => {
    console.log(JSON.stringify(out));
    process.exit(0);
  },
  (error) => {
    console.error(`seed-spend: ${String(error)}`);
    process.exit(1);
  },
);
