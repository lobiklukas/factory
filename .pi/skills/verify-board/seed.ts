#!/usr/bin/env bun
// Seed the board this skill drives: one board instance over the seeded `default` definition and one
// card in `intake`, both through the real `TaskService` against the run's `DATABASE_URL` — the board
// through `createBoard` (LOB-208), the writer `factory board create` reaches, not an insert here.
//
// A card has to exist before any command can be proven: `factory board ls` prints lanes from the
// definition and cards from the rows, and `board move` needs a revision to expect. No command
// creates a card here: `drive.sh` adds its own with `factory board add` (LOB-261), and this skill
// drives the reading and moving that a person does by hand.
//
// `SEED_CARD=0` seeds the board alone (LOB-84): `./up.sh` does, because `drive.sh` creates its own
// card with `factory board add` — the command a person types — so every drive starts from a card
// at revision 1 and the drive can be run twice against one instance. `ask.sh` keeps the default.
//
// `SEED_DEFINITION_VERSION=newest` pins the default definition's newest version instead of version 1
// (LOB-86): `./up.sh` does, so the drive's card runs the shipped pipeline — `review` gated on
// `verified` — through build, review and the merge. `SEED_REPO_ROOT` (with `API_URL`) registers the
// board's repository through the API's `registerRepo`, pointing it at that checkout, so a run on one
// of its cards is a git worktree of it and has a branch a PR can publish.
//
// Prints one JSON line: {"boardId":"brd_…","repo":"…","definitionVersion":1,"taskId":"tsk_…",
// "revision":1,"title":"…"}, or the board's three fields alone with `SEED_CARD=0`.
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { TaskService, TaskServiceLive } from "@repo/core";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { protocolFor } from "../verify-api/harness.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const TITLE = "verify-board card";
const WITH_CARD = process.env["SEED_CARD"] !== "0";
const NEWEST = process.env["SEED_DEFINITION_VERSION"] === "newest";
const REPO_ROOT = process.env["SEED_REPO_ROOT"] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";

const program = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const repo = RepoSlug.make(`verify-board/${hex(6)}`);

  if (REPO_ROOT !== "") {
    // Through the API, as `requires.ts` does: the session service the runs open in is the one
    // that reads the registration back.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(RpcApi);
        yield* client.registerRepo({
          repo,
          url: `https://example.invalid/${repo}.git`,
          localPath: REPO_ROOT,
        });
      }),
    ).pipe(Effect.provide(protocolFor(API_URL)));
  }

  // Version 1 by name unless the newest is asked for: `ask.sh`'s story is version 1's exits, and the
  // drive (via `./up.sh`) takes its card through the newest pipeline's `verified` gate (LOB-86).
  const board = yield* tasks.createBoard({
    repo,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
    ...(NEWEST ? {} : { definitionVersion: 1 }),
  });
  const boardId = board.id;
  const pinned = {
    boardId,
    repo,
    definitionVersion: board.definitionVersion,
  };

  if (!WITH_CARD) return JSON.stringify(pinned);

  const task = yield* tasks.create({ boardId, title: TITLE, actor: "cli" });

  return JSON.stringify({
    ...pinned,
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
