#!/usr/bin/env bun
// The two things `requires.sh` cannot do from a terminal (LOB-80): seed a card on a board whose
// definition declares `verified`, and read back what a run's `verify` call recorded.
//
//   MODE=seed REPO_ROOT=…              one board instance over the newest `default` definition (the
//                                      one whose `review` declares `verified`), the fixture repo
//                                      registered through the API's `registerRepo`, and one card on
//                                      that repo through the real `TaskService`. Prints one JSON line.
//   MODE=settled SESSION_ID=… LABEL=…  the run answered and is idle, and its log holds exactly one
//                                      `verify` record; writes it to `requires-<label>.json` and
//                                      checks it holds exactly the results EXPECT names, one per
//                                      surface (a comma-separated list, in any order).
//   MODE=answered SESSION_ID=… LABEL=… the run answered and is idle, and its log holds no `verify`
//                                      record — the builder run (LOB-240), whose change is committed
//                                      on its branch and whose PR is what `building` waits for.
//   MODE=faulted TASK_ID=… MODEL=…     a run of the card in `building` created on MODEL — the faux
//            LABEL=…                   model whose script fails every request (`FAUX_MODEL_SCRIPTS`'s
//                                      `fail`, F6) — and sent a message: it goes idle on an error
//                                      entry carrying `FAUX_FAIL_MESSAGE`. Prints `{"sessionId"}`.
//
// Everything a person reads — the refusal, its words, its exit code, the move that goes through —
// is read by `requires.sh` through `factory board`.
//
// Env: API_URL, MODE, REPO_ROOT, SESSION_ID, LABEL, EXPECT (`<surface>:<tag>[:<exit>]`[,…]),
// DATABASE_URL, EVIDENCE_DIR. Exits non-zero when a check fails.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { TaskService, TaskServiceLive } from "@repo/core";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { FAUX_FAIL_MESSAGE, readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9402";
const MODE = process.env["MODE"] ?? "";
const REPO_ROOT = process.env["REPO_ROOT"] ?? "";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const LABEL = process.env["LABEL"] ?? "run";
const EXPECT = process.env["EXPECT"] ?? "";
const TASK_ID = process.env["TASK_ID"] ?? "";
const MODEL = process.env["MODEL"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const seed = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const client = yield* RpcClient.make(RpcApi);
  const repo = RepoSlug.make(`verify-board/requires-${hex(4)}`);
  // Registered through the API, so the run `board start` opens is a worktree of the fixture.
  yield* client.registerRepo({
    repo,
    url: "https://example.invalid/verify-board/requires.git",
    localPath: REPO_ROOT,
  });
  // The newest version of the default pipeline, which is `createBoard`'s default (LOB-208).
  const made = yield* tasks.createBoard({
    repo,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  const boardId = made.id;
  const version = made.definitionVersion;
  const task = yield* tasks.create({
    boardId,
    title: "verify-board requires card",
    repo,
    actor: "cli",
  });
  const board = yield* tasks.getBoard(boardId);
  const review = board.definition.columns.find((c) => c.name === "review");
  console.log(
    JSON.stringify({
      boardId,
      taskId: task.id,
      revision: task.revision,
      repo,
      definitionVersion: version,
      reviewRequires: (review?.requires ?? []).map((r) => r.key).join(","),
    }),
  );
}).pipe(Effect.provide(TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive))));

const observed: {
  sessionId: string;
  label: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { sessionId: SESSION, label: LABEL, facts: {}, checks: {} };
const check = makeChecker(observed);

/** The run's `verify` records, read out of its log in Postgres rather than off the API. */
const verifyRecords = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* Effect.acquireUseRelease(
    Effect.promise(() => PostgresStorage.reader(sql, SESSION)),
    (storage) => readVerifyRecords(storage),
    (storage) => Effect.promise(() => storage.dispose()),
  );
}).pipe(Effect.provide(DatabaseLive));

const answered = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const started = Date.now();
  let snapshot = yield* client.getSession({ sessionId: SESSION });
  const done = () =>
    !snapshot.live.busy &&
    snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    );
  while (!done() && Date.now() - started < 60_000) {
    yield* Effect.sleep(100);
    snapshot = yield* client.getSession({ sessionId: SESSION });
  }
  check(
    `the ${LABEL} run made its change and answered`,
    done(),
    `busy=${snapshot.live.busy} after ${Date.now() - started}ms`,
  );
  const records = yield* verifyRecords;
  observed.facts["records"] = records;
  check(
    `the ${LABEL} run's log holds no verify record`,
    records.length === 0,
    `records=${records.length}`,
  );
});

const settled = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const started = Date.now();
  let snapshot = yield* client.getSession({ sessionId: SESSION });
  const answered = () =>
    !snapshot.live.busy &&
    snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    );
  while (!answered() && Date.now() - started < 60_000) {
    yield* Effect.sleep(100);
    snapshot = yield* client.getSession({ sessionId: SESSION });
  }
  check(
    `the ${LABEL} run made its change, verified it and answered`,
    answered(),
    `busy=${snapshot.live.busy} after ${Date.now() - started}ms`,
  );
  const records = yield* verifyRecords;
  observed.facts["records"] = records;
  const record = records[0];
  const result = record?._tag === "VerifyReport" ? record.results : [];
  observed.facts["changed"] =
    record?._tag === "VerifyReport" ? record.changed : [];
  check(
    `the ${LABEL} run's log holds one verify record over its change`,
    records.length === 1 &&
      record?._tag === "VerifyReport" &&
      record.changedCount > 0,
    `records=${records.length} changed=${record?._tag === "VerifyReport" ? record.changed.join(" ") : "-"}`,
  );
  // One result per surface, compared as a set: a run on the card's branch (C19) also measures the
  // change the runs before it committed there, so its record names every surface the card touched.
  const spelled = result.map(
    (r) =>
      `${r.surface}:${r._tag}${r._tag === "VerifyRan" ? `:${r.exitCode}` : ""}`,
  );
  const expected = EXPECT.split(",");
  check(
    `the ${LABEL} record is ${EXPECT}`,
    EXPECT !== "" &&
      spelled.length === expected.length &&
      [...spelled].sort().join(",") === [...expected].sort().join(","),
    spelled.join(" ") || "no results",
  );
});

/**
 * A run of the card whose model request fails (F6): created on the failing faux model, as a client
 * names a model (LOB-274), in `building`, and sent the message `board start` would send. Its newest
 * turn ends on the failed answer, which is what `run_completed` reads as faulted.
 */
const faulted = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const run = yield* client.createSession({
    taskId: TASK_ID,
    taskColumn: "building",
    model: MODEL,
  });
  observed.sessionId = run.id;
  yield* client.sendMessage({ sessionId: run.id, content: "build this card" });
  const started = Date.now();
  let snapshot = yield* client.getSession({ sessionId: run.id });
  const errored = () =>
    snapshot.entries.find(
      (entry) => entry.kind === "assistant" && entry.isError === true,
    );
  while (
    (snapshot.live.busy || errored() === undefined) &&
    Date.now() - started < 60_000
  ) {
    yield* Effect.sleep(100);
    snapshot = yield* client.getSession({ sessionId: run.id });
  }
  const failure = errored();
  observed.facts["session"] = snapshot.session;
  observed.facts["error"] = failure?.error;
  check(
    `the ${LABEL} run on ${MODEL} is idle on its model's error`,
    !snapshot.live.busy &&
      snapshot.session.status === "idle" &&
      snapshot.session.model === MODEL &&
      failure?.error === FAUX_FAIL_MESSAGE,
    `busy=${snapshot.live.busy} status=${snapshot.session.status} model=${snapshot.session.model} error=${JSON.stringify(failure?.error)}`,
  );
  console.log(JSON.stringify({ sessionId: run.id }));
});

const failed = () => Object.values(observed.checks).some((c) => !c.passed);

const runScoped = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check(`the ${MODE} probe ran`, false, String(error));
        }),
      ),
    ),
  );

if (MODE === "seed") {
  await runScoped(seed);
  if (failed()) process.exit(1);
  process.exit(0);
} else if (MODE === "settled" || MODE === "answered" || MODE === "faulted") {
  await runScoped(
    MODE === "settled" ? settled : MODE === "faulted" ? faulted : answered,
  );
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(
    path.join(EVIDENCE_DIR, `requires-${LABEL}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  process.exit(failed() ? 1 : 0);
} else {
  console.error(
    "requires.ts: MODE must be one of seed, settled, answered, faulted",
  );
  process.exit(2);
}
