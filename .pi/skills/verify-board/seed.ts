#!/usr/bin/env bun
// Seed the board this skill drives: one board instance over the seeded `default` definition and one
// card in `intake`, both through the real `TaskService` against the run's `DATABASE_URL` — the board
// through `createBoard` (LOB-208), the writer `factory board create` reaches, not an insert here.
//
// A card has to exist before any command can be proven: `factory board ls` prints lanes from the
// definition and cards from the rows, and `board move` needs a revision to expect. This seed makes
// its card through the service, not a command; `factory board add` is the command (LOB-261), which
// `drive.sh` and the getting-started guide's walk (`guide.sh`, G1) use for theirs.
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
// `SEED_REPO_SLUG` and `SEED_REPO_URL` name the board's repository and its forge (LOB-40): verify-workflow
// maps a Linear label to the repository before the API boots, so it picks the slug, and its pushes
// go to a loopback git forge, so the URL is that forge's. Unset, a fresh `verify-board/<hex>` slug
// whose URL is `example.invalid`, which nothing reaches.
//
// `SEED_BOARD_ID=brd_…` seeds the card on that board and creates none (C5): verify-web's drive makes
// its board with the dashboard's **New board** form, as an operator does, and asks this seed for the
// card alone — the board's repository and version are read back from the server, not assumed.
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
const BOARD_ID = process.env["SEED_BOARD_ID"] ?? "";
const REPO_ROOT = process.env["SEED_REPO_ROOT"] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const REPO_SLUG = process.env["SEED_REPO_SLUG"] ?? "";
const REPO_URL = process.env["SEED_REPO_URL"] ?? "";

const program = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const repo = RepoSlug.make(
    REPO_SLUG === "" ? `verify-board/${hex(6)}` : REPO_SLUG,
  );

  if (BOARD_ID !== "") {
    // The board is the caller's: read it back, add the card, and print the same line.
    const { instance } = yield* tasks.getBoard(BOARD_ID);
    const boardId = instance.id;
    const task = yield* tasks.create({ boardId, title: TITLE, actor: "cli" });
    return JSON.stringify({
      boardId,
      repo: instance.repo,
      definitionVersion: instance.definitionVersion,
      taskId: task.id,
      revision: task.revision,
      title: task.title,
    });
  }

  if (REPO_ROOT !== "") {
    // Through the API, as `requires.ts` does: the session service the runs open in is the one
    // that reads the registration back.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(RpcApi);
        yield* client.registerRepo({
          repo,
          url:
            REPO_URL === "" ? `https://example.invalid/${repo}.git` : REPO_URL,
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
