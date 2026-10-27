#!/usr/bin/env bun
// Seed the attention drive's board (LOB-77), through the real `TaskService` against the run's
// `DATABASE_URL` — the database `./up.sh` started the API with.
//
//   MODE=board                                 a fresh board and five cards; prints their ids
//   MODE=ask TASK_ID= SESSION_ID= QUESTION=    the run SESSION_ID asks QUESTION on TASK_ID
//
// `board` makes the cards the drive needs, each in the column its check reads:
//
//   resting   `intake`        resting: nothing is asked of anyone yet, so it never needs a person
//   waiting   `planning`      blocked `dependency`; the drive gives it an idle run, so it sits at a
//                             human gate with its work done — and is still waiting on the dependency
//   gated     `planning`      the drive runs it, then it waits at the plan approval
//   asked     `specifying`    the drive starts a run, and this script's `ask` parks it on a question
//   approval  `building`      the drive starts a run and requests an approval on it
//
// The columns are written directly rather than walked with moves. The walk is the card pane's
// subject (`features/card-pane.md`); here it would only make the attention checks depend on whatever
// a move out of `specifying` requires (`requires[]`, LOB-80), which is not what they prove. The
// block and the ask go through the service, because they are what the attention view reads.
//
// `ask` is the run's own `ask` tool's service call (B7, LOB-73): a `question` comment and the
// `needs_input` block in one transaction, with the run's session id as the actor. The faux model
// asks only when the whole API is started with `FAUX_ASK`, which would make every run in the drive
// ask, so the drive makes this one call in-process instead.
//
// Prints one JSON line.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TaskService, TaskServiceLive } from "@repo/core";
import { DatabaseLive } from "@repo/storage-postgres";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const MODE = process.env["MODE"] ?? "";
const ACTOR = "person:verify-web";

const CARDS = [
  { key: "resting", title: "attention: resting in intake", column: "intake" },
  {
    key: "waiting",
    title: "attention: blocked on a dependency",
    column: "planning",
  },
  { key: "gated", title: "attention: plan waits", column: "planning" },
  { key: "asked", title: "attention: a run asks", column: "specifying" },
  {
    key: "approval",
    title: "attention: a run wants approval",
    column: "building",
  },
] as const;

const board = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;

  const boardId = `brd_${hex(13)}`;
  const repo = `verify-web/attention-${hex(4)}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${repo}, 'default', 1)
  `;

  const ids: Record<string, string> = {};
  for (const card of CARDS) {
    const task = yield* tasks.create({
      boardId,
      title: card.title,
      actor: ACTOR,
    });
    if (card.column !== "intake") {
      yield* sql`
        UPDATE tasks SET "column" = ${card.column}, revision = revision + 1, updated_at = now()
        WHERE id = ${task.id}
      `;
    }
    ids[card.key] = task.id;
  }
  const waiting = yield* tasks.get(ids["waiting"] ?? "");
  yield* tasks.block({
    taskId: waiting.id,
    expectedRevision: waiting.revision,
    reason: "dependency",
    note: "waits on the schema migration",
    actor: ACTOR,
  });
  return { boardId, repo, ...ids };
});

const ask = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const sessionId = process.env["SESSION_ID"] ?? "";
  const task = yield* tasks.ask({
    taskId: process.env["TASK_ID"] ?? "",
    question: process.env["QUESTION"] ?? "",
    actor: sessionId,
    askId: `${sessionId}:verify-web-attention`,
  });
  return {
    taskId: task.id,
    revision: task.revision,
    blocked: task.blocked?.reason ?? null,
  };
});

const program: Effect.Effect<unknown, unknown, SqlClient | TaskService> =
  MODE === "board"
    ? board
    : MODE === "ask"
      ? ask
      : Effect.fail(`MODE must be board or ask, not ${JSON.stringify(MODE)}`);

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
    console.error(`seed-attention: ${String(error)}`);
    process.exit(1);
  },
);
