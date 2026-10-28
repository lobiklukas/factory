#!/usr/bin/env bun
// The drive's read-back of its cards (LOB-84, LOB-261): the cards `factory board add` made in a real
// terminal, read back over the API's RPC surface, and the refusals the terminal cannot show.
//
// The drive's own card is made by `factory board add` in the pane (drive.sh), not here: no card the
// drive takes through the board is created by a direct RPC. This script reads what the command made
// — `getTask` for the drive's card, `listTasks` for the lane — and checks:
//
//  * the drive's card names NO repository (LOB-255): it inherited the board's, which is what gives
//    every run on it a branch, so the drive taking it through build, PR and review is the proof
//    that a card made without a repo reaches review. The title and body the command was given are
//    stored verbatim.
//  * a card naming another repository is refused as `BoardRepoMismatch`, naming both, and leaves no
//    card behind.
//  * the equivalence (LOB-261, LOB-275): the CLI made a second card from a fixed set of inputs; this
//    script makes a third with `createTask` from the same inputs — the call the dashboard's 'New
//    card' form makes — and the board lists both with the same title, body, repo, priority and base
//    ref. The third card is the only direct create here, and it exists to be compared.
//  * the refused `BoardRepoMismatch` create wrote no card on this board: it holds the cards it did
//    before (`CARDS_BEFORE`) plus the form's one. The refused commands are not counted here: the empty
//    title never reaches a server (`--api` is a closed port) and the unknown board is another board's.
//
// Env: API_URL, BOARD_ID, TASK_ID (the drive's card), TITLE, BODY (what it was given), PAIR_ID (the
// CLI's equivalence card), PAIR_TITLE, PAIR_BODY, PAIR_PRIORITY, PAIR_BASE_REF (what it was given),
// CARDS_BEFORE, EVIDENCE_DIR. Writes `add.json` (the read-backs and the checks); its checks
// print on stdout as the other drivers' do. Exits non-zero when a check fails.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { BoardInstanceId, TaskId, TaskPriority } from "@repo/domain/Task";
import { Effect, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const env = (name: string): string => process.env[name] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = env("BOARD_ID");
const TASK_ID = env("TASK_ID");
const PAIR_ID = env("PAIR_ID");
const TITLE = env("TITLE");
const BODY = env("BODY");
const PAIR_TITLE = env("PAIR_TITLE");
const PAIR_BODY = env("PAIR_BODY");
const PAIR_BASE_REF = env("PAIR_BASE_REF");
const CARDS_BEFORE = Number(env("CARDS_BEFORE"));
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const observed: {
  apiUrl: string;
  boardId: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, boardId: BOARD_ID, facts: {}, checks: {} };
const check = makeChecker(observed);

const readBack = Effect.gen(function* () {
  // Decoded, not cast: an id that cannot be one is this script's bug, not a server refusal.
  const boardId = yield* Schema.decodeEffect(BoardInstanceId)(BOARD_ID);
  const taskId = yield* Schema.decodeEffect(TaskId)(TASK_ID);
  const pairId = yield* Schema.decodeEffect(TaskId)(PAIR_ID);
  const priority = yield* Schema.decodeUnknownEffect(TaskPriority)(
    env("PAIR_PRIORITY"),
  );
  const client = yield* RpcClient.make(RpcApi);
  const board = yield* client.getBoard({ boardId });
  const read = yield* client.getTask({ taskId });
  observed.facts["readBack"] = read;

  check(
    "a card added with no repo inherits the board's repository",
    read.repo === board.instance.repo,
    `${read.id} repo=${read.repo ?? "none"}, board ${board.instance.id} over ${board.instance.repo}`,
  );
  check(
    "getTask reads back the title, body and board the command was given",
    read.title === TITLE && read.body === BODY && read.boardId === boardId,
    `${read.id} "${read.title}" body ${read.body?.length ?? 0} chars on ${read.boardId}`,
  );

  // Another repository than the board's is refused, naming both, and writes no card.
  const other = yield* Schema.decodeEffect(RepoSlug)(
    `${board.instance.repo}-elsewhere`,
  );
  const refusedTitle = `${TITLE} elsewhere`;
  const refused = yield* client
    .createTask({
      boardId,
      title: refusedTitle,
      repo: other,
      actor: "verify-board",
    })
    .pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: (task) => task,
      }),
    );
  observed.facts["refused"] = refused;
  check(
    "a card naming another repository is refused, naming both",
    "_tag" in refused &&
      refused._tag === "BoardRepoMismatch" &&
      refused.boardRepo === board.instance.repo &&
      refused.repo === other &&
      refused.message.includes(board.instance.repo) &&
      refused.message.includes(other),
    "_tag" in refused ? `${refused._tag}: ${refused.message}` : "created",
  );

  // The dashboard's form: `createTask` with the inputs the CLI's second card was made from.
  const formCard = yield* client.createTask({
    boardId,
    title: PAIR_TITLE,
    repo: board.instance.repo,
    priority,
    body: PAIR_BODY,
    baseRef: PAIR_BASE_REF,
    actor: "verify-board-form",
  });
  const cards = yield* client.listTasks({ boardId });
  const shape = (id: TaskId) => {
    const card = cards.find((candidate) => candidate.id === id);
    return card === undefined
      ? undefined
      : {
          title: card.title,
          body: card.body,
          repo: card.repo,
          priority: card.priority,
          baseRef: card.baseRef,
          column: card.column,
          revision: card.revision,
        };
  };
  const cliShape = shape(pairId);
  const formShape = shape(formCard.id);
  observed.facts["equivalence"] = { cli: cliShape, form: formShape };
  check(
    "a card from board add and one from createTask with the same inputs list the same",
    cliShape !== undefined &&
      JSON.stringify(cliShape) === JSON.stringify(formShape) &&
      cliShape.title === PAIR_TITLE &&
      cliShape.body === PAIR_BODY &&
      cliShape.repo === board.instance.repo &&
      cliShape.priority === priority &&
      cliShape.baseRef === PAIR_BASE_REF,
    JSON.stringify(observed.facts["equivalence"]),
  );
  check(
    "the refused BoardRepoMismatch create wrote no card on this board",
    !cards.some((card) => card.title === refusedTitle) &&
      cards.length === CARDS_BEFORE + 1,
    `${cards.length} cards on ${boardId}, ${CARDS_BEFORE} before the form's card`,
  );
});

const failed = await Effect.runPromise(
  Effect.scoped(readBack).pipe(
    Effect.provide(protocolFor(API_URL)),
    Effect.as(false),
    Effect.catch((error) =>
      Effect.sync(() => {
        check("the read-back phase ran", false, String(error));
        return true;
      }),
    ),
  ),
);

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "add.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(
  !failed && Object.values(observed.checks).every((c) => c.passed) ? 0 : 1,
);
