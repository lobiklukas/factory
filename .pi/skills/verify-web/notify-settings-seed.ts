#!/usr/bin/env bun
// Seed one event the notifier tells a person about, for the notification settings drive (F21),
// through the real `TaskService` against the run's `DATABASE_URL` — the scratch database
// `notify-settings.sh` started the API with.
//
//   MODE=question|approval  OWNER=<actor that creates the card>  TITLE=<card title>  LINK_BASE=<dashboard>
//
// One card on a board of its own, created by OWNER (the actor a card's notification is routed by),
// with a run: `question` parks the card on the run's own `ask` (B7, the service call the tool makes),
// `approval` records a pending approval the run asked. Prints one JSON line:
// `{"kind","title","link","taskId"}` — the link is what the notification carries, so the drive can
// find the message for this card among the others.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { cardLink, TaskService, TaskServiceLive } from "@repo/core";
import { DatabaseLive } from "@repo/storage-postgres";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const MODE = process.env["MODE"] ?? "";
const OWNER = process.env["OWNER"] ?? "dashboard";
const TITLE = process.env["TITLE"] ?? `notify-settings: ${MODE}`;
const LINK_BASE = process.env["LINK_BASE"] ?? "http://127.0.0.1:3100";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;
  const boardId = `brd_${hex(13)}`;
  const repo = `verify-web/notify-${hex(4)}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${repo}, 'default', 1)
  `;
  const column = MODE === "question" ? "specifying" : "building";
  const card = yield* tasks.create({ boardId, title: TITLE, actor: OWNER });
  yield* sql`
    UPDATE tasks SET "column" = ${column}, revision = revision + 1, updated_at = now()
    WHERE id = ${card.id}
  `;
  const sessionId = `ses_${hex(13)}`;
  yield* sql`INSERT INTO sessions (id, title, repo) VALUES (${sessionId}, ${TITLE}, ${repo})`;
  yield* sql`
    INSERT INTO task_runs (id, task_id, session_id, "column")
    VALUES (${`run_${sessionId}`}, ${card.id}, ${sessionId}, ${column})
  `;
  if (MODE === "question") {
    yield* tasks.ask({
      taskId: card.id,
      question: "Which locale is the default?",
      actor: sessionId,
      askId: `${sessionId}:notify-settings`,
    });
    return {
      kind: "question",
      title: TITLE,
      taskId: card.id,
      link: cardLink(LINK_BASE, { boardId, taskId: card.id, thread: true }),
    };
  }
  yield* sql`
    INSERT INTO session_approvals (session_id, request_id, action, detail, requested_at)
    VALUES (${sessionId}, 'notify-settings-1', 'bash', 'git push origin factory/notify', now())
  `;
  return {
    kind: "approval",
    title: TITLE,
    taskId: card.id,
    link: cardLink(LINK_BASE, { boardId, taskId: card.id, run: sessionId }),
  };
});

const seeded = await Effect.runPromise(
  program.pipe(
    Effect.provide(TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive))),
  ),
);
console.log(JSON.stringify(seeded));
