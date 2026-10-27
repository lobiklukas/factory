#!/usr/bin/env bun
// The drive's first phase (LOB-84): create a card the way a trigger does — `createTask` over the
// API's RPC surface — and read it back with `getTask`.
//
// No `factory` command creates a card (card creation is a trigger's job, docs/board.md B2), so the
// create is made from here, over the same RPC client the CLI and the dashboard build. Everything
// after it — the lanes, the moves and the three refusals — is driven through `factory board` in
// `drive.sh`. A fresh card per drive is what makes the drive's revisions true on a second run
// against one `./up.sh` instance.
//
// Env: API_URL, BOARD_ID, EVIDENCE_DIR, CARD_FILE. Writes `create.json` (the created card, its
// read-back and the checks) and, when every check passed, one JSON line into CARD_FILE for
// `drive.sh`: {"taskId":"tsk_…","revision":1,"column":"intake","title":"…"}. Its checks print on
// stdout as the other drivers' do. Exits non-zero when a check fails.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
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
  const created = yield* client.createTask({
    boardId,
    title: TITLE,
    actor: "verify-board",
  });
  const read = yield* client.getTask({ taskId: created.id });
  observed.facts["created"] = created;
  observed.facts["readBack"] = read;

  check(
    "createTask opens the card in intake at revision 1",
    created.column === "intake" && created.revision === 1,
    `${created.id} in ${created.column} at revision ${created.revision}`,
  );
  check(
    "getTask reads back the card createTask returned",
    read.id === created.id &&
      read.title === TITLE &&
      read.column === created.column &&
      read.revision === created.revision &&
      read.boardId === boardId,
    `${read.id} "${read.title}" ${read.column} r${read.revision} on ${read.boardId}`,
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
