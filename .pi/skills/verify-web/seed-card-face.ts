#!/usr/bin/env bun
// Seed and mark the card-face drive's board (C10), through the real `TaskService` and the run's
// `DATABASE_URL` — the database `card-face.sh` started the API with.
//
//   REPO=verify-card-face/<tag> bun seed-card-face.ts                       # board: one board, cards
//   MARK_SESSION=ses_… MARK_PR=https://… MARK_COST=0.25 bun seed-card-face.ts   # mark: a run's PR/cost
//   MORE_BOARD=brd_… MORE=6 bun seed-card-face.ts                           # more: extra bare cards
//
// `board` makes one board on `REPO` and three cards in `specifying`, a working column, so a run can
// be started on each: `live` (the drive starts a run that stays busy), `done` (the drive starts two
// runs, then marks them with a cost and a PR) and `bare` (no run, so its face says nothing). The
// column is written directly, as seed-spend.ts does: a move is the card pane's subject.
//
// `mark` writes what the PR step and a cost-reporting provider leave behind on a run's index rows:
// `sessions.pr_url` (what `recordPr` writes) and `session_activity.cost_total` (what the faux
// provider does not report, LOB-222). The PR step itself is `pr.sh`'s subject; this drive's is that
// a PR which exists reaches the card face within one poll interval.
//
// Prints one JSON line.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TaskService, TaskServiceLive } from "@repo/core";
import { DatabaseLive } from "@repo/storage-postgres";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const REPO = process.env["REPO"] ?? "";
const ACTOR = "person:verify-card-face";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;

  const markSession = process.env["MARK_SESSION"] ?? "";
  if (markSession !== "") {
    const pr = process.env["MARK_PR"] ?? "";
    const cost = Number(process.env["MARK_COST"] ?? "0");
    if (pr !== "") {
      yield* sql`UPDATE sessions SET pr_url = ${pr} WHERE id = ${markSession}`;
    }
    yield* sql`
      UPDATE session_activity SET cost_total = ${cost} WHERE session_id = ${markSession}
    `;
    return { marked: markSession };
  }

  const moreBoard = process.env["MORE_BOARD"] ?? "";
  if (moreBoard !== "") {
    const count = Number(process.env["MORE"] ?? "0");
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const task = yield* tasks.create({
        boardId: moreBoard,
        title: `extra ${n}`,
        actor: ACTOR,
      });
      ids.push(task.id);
    }
    return { added: ids };
  }

  if (REPO === "") return yield* Effect.fail("REPO is required");
  const boardId = `brd_${hex(13)}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${REPO}, 'default', 1)
  `;
  const ids: Record<string, string> = {};
  for (const key of ["live", "done", "bare"]) {
    const task = yield* tasks.create({
      boardId,
      title: `face: ${key}`,
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
    console.error(`seed-card-face: ${String(error)}`);
    process.exit(1);
  },
);
