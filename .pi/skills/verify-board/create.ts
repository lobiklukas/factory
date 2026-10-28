#!/usr/bin/env bun
// The drive's first phase (LOB-84): create a card the way a trigger does — `createTask` over the
// API's RPC surface — and read it back with `getTask`.
//
// The card names NO repository (LOB-255): it inherits the board's, which is what gives every run on
// it a branch, so the drive taking this card through build, PR and review is the proof that a card
// made without a repo reaches review. A second create naming another repository is refused as
// `BoardRepoMismatch`, naming both, and leaves no card behind.
//
// `drive.sh` makes its card with `factory board add` (LOB-261, `add.ts` reads it back); this script is
// the card factory for the drivers that need a card and not the command (`triage.sh`,
// `board-create.sh`), over the same RPC client the CLI and the dashboard build. A fresh card per
// drive is what makes a drive's revisions true on a second run against one `./up.sh` instance.
//
// Env: API_URL, BOARD_ID, EVIDENCE_DIR, CARD_FILE. Writes `create.json` (the created card, its
// read-back and the checks) and, when every check passed, one JSON line into CARD_FILE for
// `drive.sh`: {"taskId":"tsk_…","revision":1,"column":"intake","title":"…"}. Its checks print on
// stdout as the other drivers' do. Exits non-zero when a check fails.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { BoardInstanceId } from "@repo/domain/Task";
import { Effect, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
const CARD_FILE = process.env["CARD_FILE"] ?? ".verify/run/card.json";
const TITLE = `verify-board card ${randomBytes(3).toString("hex")}`;

const observed: {
  apiUrl: string;
  boardId: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, boardId: BOARD_ID, facts: {}, checks: {} };
const check = makeChecker(observed);

const create = Effect.gen(function* () {
  // Decoded, not cast: a board id that cannot be one is this script's bug, not a server refusal.
  const boardId = yield* Schema.decodeEffect(BoardInstanceId)(BOARD_ID);
  const client = yield* RpcClient.make(RpcApi);
  // No repo on the card: it inherits the board's (LOB-255), and every run on it is bound to that
  // repo, which is what gives the build run a branch to publish.
  const board = yield* client.getBoard({ boardId });
  const created = yield* client.createTask({
    boardId,
    title: TITLE,
    actor: "verify-board",
  });
  const read = yield* client.getTask({ taskId: created.id });
  observed.facts["created"] = created;
  observed.facts["readBack"] = read;

  check(
    "a card created with no repo inherits the board's repository",
    created.repo === board.instance.repo,
    `${created.id} repo=${created.repo ?? "none"}, board ${board.instance.id} over ${board.instance.repo}`,
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
  const cards = yield* client.listTasks({ boardId });
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
  check(
    "and the refused create wrote no card",
    !cards.some((card) => card.title === refusedTitle),
    `${cards.length} cards on ${boardId}`,
  );

  check(
    "createTask opens the card in intake at revision 1",
    created.column === "intake" && created.revision === 1,
    `${created.id} in ${created.column} at revision ${created.revision}`,
  );
  check(
    "getTask reads back the card createTask returned",
    read.id === created.id &&
      read.title === TITLE &&
      read.repo === board.instance.repo &&
      read.column === created.column &&
      read.revision === created.revision &&
      read.boardId === boardId,
    `${read.id} "${read.title}" ${read.column} r${read.revision} on ${read.boardId} (${read.repo ?? "no repo"})`,
  );
  return created;
});

const line = await Effect.runPromise(
  Effect.scoped(create).pipe(
    Effect.provide(protocolFor(API_URL)),
    Effect.map((task) =>
      JSON.stringify({
        taskId: task.id,
        revision: task.revision,
        column: task.column,
        title: task.title,
        repo: task.repo ?? "",
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        check("the create phase ran", false, String(error));
        return undefined;
      }),
    ),
  ),
);

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "create.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const passed =
  line !== undefined && Object.values(observed.checks).every((c) => c.passed);
if (passed) await writeFile(CARD_FILE, `${line}\n`);
process.exit(passed ? 0 : 1);
