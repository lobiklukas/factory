#!/usr/bin/env bun
// The probes `start-body.sh` cannot make from a terminal (LOB-260): a card created with a body, a
// base ref and an external ref over the API's `createTask` (the door a trigger uses — no `factory`
// command creates a card yet), and, once `factory board start` has run on it, what the run's log says
// it was told and which commit its worktree was cut from.
//
//   MODE=create                  two cards on BOARD_ID: one with BODY, base ref `release` and an
//                                external ref, one with nothing; each read back with `getTask`.
//                                Writes {"bodyTask":"tsk_…","bareTask":"tsk_…"} into CARD_FILE.
//   MODE=told SESSION_ID=… BARE_SESSION_ID=… RELEASE_SHA=… MAIN_SHA=…
//                                both runs settled; the body card's run is bound to `release`, its
//                                worktree stands on RELEASE_SHA, and its recorded prompt carries the
//                                body verbatim as `task_body`; the bare card's run is on MAIN_SHA and
//                                its prompt has no `task_body` at all.
//
// Env: API_URL, MODE, BOARD_ID, CARD_FILE, SESSION_ID, BARE_SESSION_ID, RELEASE_SHA, MAIN_SHA,
// DATABASE_URL (for `told`'s log read), EVIDENCE_DIR. Writes `body-<mode>.json` and exits non-zero
// when a check fails.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import { BoardInstanceId } from "@repo/domain/Task";
import {
  BODY_SECTION_KEY,
  readPromptSections,
  renderBody,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Schema, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const CARD_FILE = process.env["CARD_FILE"] ?? ".verify/run/body-cards.json";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const BARE_SESSION = (process.env["BARE_SESSION_ID"] ?? "") as SessionId;
const RELEASE_SHA = process.env["RELEASE_SHA"] ?? "";
const MAIN_SHA = process.env["MAIN_SHA"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

/**
 * The card's body: markdown with a heading, a list, an em dash, and edges — leading spaces, trailing
 * blank lines — that a trim or a re-wrap on the way into the prompt would lose.
 */
const BODY =
  "  ## Goal\n\nWrite the release notes for the next cut — **every** merged PR.\n\n" +
  "- keep port 5442\n- no new env vars\n\n";
const BASE_REF = "release";
const EXTERNAL_REF = "LOB-260";

const observed: {
  mode: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { mode: MODE, facts: {}, checks: {} };
const check = makeChecker(observed);

const tag = randomBytes(3).toString("hex");

const create = Effect.gen(function* () {
  const boardId = yield* Schema.decodeEffect(BoardInstanceId)(BOARD_ID);
  const client = yield* RpcClient.make(RpcApi);
  const card = yield* client.createTask({
    boardId,
    title: `verify-board body card ${tag}`,
    body: BODY,
    baseRef: BASE_REF,
    externalRef: EXTERNAL_REF,
    actor: "verify-board",
  });
  const bare = yield* client.createTask({
    boardId,
    title: `verify-board bare card ${tag}`,
    actor: "verify-board",
  });
  const read = yield* client.getTask({ taskId: card.id });
  const bareRead = yield* client.getTask({ taskId: bare.id });
  observed.facts["created"] = { card, bare };
  observed.facts["readBack"] = { card: read, bare: bareRead };
  check(
    "createTask stores the body verbatim, the base ref and the external ref",
    card.body === BODY &&
      card.baseRef === BASE_REF &&
      card.externalRef === EXTERNAL_REF,
    `${card.id} body ${card.body?.length ?? 0} chars, base ${card.baseRef ?? "-"}, external ${card.externalRef ?? "-"}`,
  );
  check(
    "getTask reads the three back as createTask returned them",
    read.body === BODY &&
      read.baseRef === BASE_REF &&
      read.externalRef === EXTERNAL_REF,
    `${read.id} body ${read.body?.length ?? 0} chars, base ${read.baseRef ?? "-"}`,
  );
  check(
    "a card created with none has no body, no base ref and no external ref",
    bareRead.body === undefined &&
      bareRead.baseRef === undefined &&
      bareRead.externalRef === undefined,
    `${bareRead.id}`,
  );
  return { bodyTask: card.id, bareTask: bare.id };
});

/** The prompt sections the run's own log leaves in effect: what the model was sent. */
const promptOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) => readPromptSections(storage),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));

const headOf = (cwd: string): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    return `no HEAD: ${String(error).split("\n")[0]}`;
  }
};

const told = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  // Settled: the run took its turn (the faux script sleeps, then asks), so its prompt is committed.
  const settle = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const started = Date.now();
      for (;;) {
        const snapshot = yield* client.getSession({ sessionId });
        const settled =
          !snapshot.live.busy &&
          snapshot.entries.some((entry) => entry.kind === "assistant");
        if (settled || Date.now() - started > 45_000) return snapshot;
        yield* Effect.sleep(200);
      }
    });
  const run = yield* settle(SESSION);
  const bare = yield* settle(BARE_SESSION);
  observed.facts["session"] = {
    session: run.session,
    workspace: run.workspace,
  };
  observed.facts["bareSession"] = {
    session: bare.session,
    workspace: bare.workspace,
  };
  check(
    "both runs settled, each having taken its turn",
    [run, bare].every(
      (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant"),
    ),
    `busy=${run.live.busy}/${bare.live.busy}`,
  );

  check(
    "the body card's run is bound to the card's base ref",
    run.session.baseRef === BASE_REF && run.workspace.baseRef === BASE_REF,
    `session base ${run.session.baseRef ?? "-"}, workspace base ${run.workspace.baseRef ?? "-"}`,
  );
  const head = headOf(run.workspace.path);
  observed.facts["head"] = head;
  check(
    "its worktree is cut from release's commit, not main's",
    RELEASE_SHA !== "" && head === RELEASE_SHA && head !== MAIN_SHA,
    `${run.workspace.path} HEAD ${head.slice(0, 12)}, release ${RELEASE_SHA.slice(0, 12)}, main ${MAIN_SHA.slice(0, 12)}`,
  );
  const bareHead = headOf(bare.workspace.path);
  observed.facts["bareHead"] = bareHead;
  check(
    "the bare card's run starts from the repository's default, main",
    bare.session.baseRef === "main" && bareHead === MAIN_SHA,
    `base ${bare.session.baseRef ?? "-"}, HEAD ${bareHead.slice(0, 12)}`,
  );

  const sections = yield* promptOf(SESSION);
  const section = sections[BODY_SECTION_KEY];
  observed.facts["recordedBodySection"] = section;
  check(
    "the run's recorded prompt carries the body verbatim as task_body",
    section ===
      `<${BODY_SECTION_KEY}>\n${renderBody(BODY) ?? ""}\n</${BODY_SECTION_KEY}>` &&
      section.includes(BODY),
    `task_body ${section?.length ?? 0} chars`,
  );
  const bareSections = yield* promptOf(BARE_SESSION);
  observed.facts["bareSectionKeys"] = Object.keys(bareSections);
  // The bare run took its turn (checked above), so its prompt is committed; the body run's read
  // proves the reader finds a section that is there.
  check(
    "a card with no body gives its run no task_body section",
    bareSections[BODY_SECTION_KEY] === undefined,
    `sections: ${Object.keys(bareSections).join(", ") || "none"}`,
  );
});

/** Run one phase; a phase that fails outright is a failed check, not a crash with no evidence. */
const runPhase = <A, E>(
  phase: Effect.Effect<A, E, RpcClient.Protocol | Scope.Scope>,
): Promise<A | undefined> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check(`the ${MODE} probe ran`, false, String(error));
          return undefined;
        }),
      ),
    ),
  );

if (MODE === "create") {
  const cards = await runPhase(create);
  if (cards !== undefined) {
    await writeFile(CARD_FILE, `${JSON.stringify(cards)}\n`);
  }
} else if (MODE === "told") {
  await runPhase(told);
} else {
  console.error("body.ts: MODE must be one of create, told");
  process.exit(2);
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `body-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
