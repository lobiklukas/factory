#!/usr/bin/env bun
// Seed the board this skill drives: one board instance over the seeded `default` definition and one
// card in `intake`, both through the real `TaskService` against the run's `DATABASE_URL` — the board
// through `createBoard` (LOB-208), the writer `factory board create` reaches, not an insert here.
//
// A card has to exist before any command can be proven: `factory board ls` prints lanes from the
// definition and cards from the rows, and `board move` needs a revision to expect. No command
// creates a card, because card creation is a trigger's job (docs/board.md B2) and this skill drives
// the *reading and moving* that a person does by hand.
//
// `SEED_CARD=0` seeds the board alone (LOB-84): `./up.sh` does, because `drive.sh` creates its own
// card through the API's `createTask` — the door a trigger uses — so every drive starts from a card
// at revision 1 and the drive can be run twice against one instance. `ask.sh` keeps the default.
//
// Prints one JSON line: {"boardId":"brd_…","taskId":"tsk_…","revision":1,"title":"…"}, or
// {"boardId":"brd_…"} with `SEED_CARD=0`.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { TaskService, TaskServiceLive } from "@repo/core";
import { RepoSlug } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const TITLE = "verify-board card";
const WITH_CARD = process.env["SEED_CARD"] !== "0";

const program = Effect.gen(function* () {
  const tasks = yield* TaskService;

  // Version 1 by name, not the newest: the drive's moves and refusals are version 1's exits, and a
  // later version (0018's `verified` on review) would change what the drive has to prove.
  const board = yield* tasks.createBoard({
    repo: RepoSlug.make(`verify-board/${hex(6)}`),
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
    definitionVersion: 1,
  });
  const boardId = board.id;

  if (!WITH_CARD) return JSON.stringify({ boardId });

  const task = yield* tasks.create({ boardId, title: TITLE, actor: "cli" });

  return JSON.stringify({
    boardId,
    taskId: task.id,
    revision: task.revision,
    title: task.title,
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
    console.error(`seed: ${String(error)}`);
    process.exit(1);
  },
);
