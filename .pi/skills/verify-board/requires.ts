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
//                                      checks the surface and result EXPECT names.
//
// Everything a person reads — the refusal, its words, its exit code, the move that goes through —
// is read by `requires.sh` through `factory board`.
//
// Env: API_URL, MODE, REPO_ROOT, SESSION_ID, LABEL, EXPECT (`<surface>:<tag>[:<exit>]`),
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
import { readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9402";
const MODE = process.env["MODE"] ?? "";
const REPO_ROOT = process.env["REPO_ROOT"] ?? "";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const LABEL = process.env["LABEL"] ?? "run";
const EXPECT = process.env["EXPECT"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;
  const client = yield* RpcClient.make(RpcApi);
  const newest = yield* sql<{ version: number }>`
    SELECT max(version)::int AS version FROM board_definitions WHERE id = 'default'
  `;
  const version = newest[0]?.version ?? 1;
  const repo = RepoSlug.make(`verify-board/requires-${hex(4)}`);
  // Registered through the API, so the run `board start` opens is a worktree of the fixture.
  yield* client.registerRepo({
    repo,
    url: "https://example.invalid/verify-board/requires.git",
    localPath: REPO_ROOT,
  });
  const boardId = `brd_${hex(13)}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${repo}, 'default', ${version})
  `;
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
  const records = yield* Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, SESSION)),
      (storage) => readVerifyRecords(storage),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));
  observed.facts["records"] = records;
  const record = records[0];
  const result = record?._tag === "VerifyReport" ? record.results : [];
  const [surface, tag, exit] = EXPECT.split(":");
  observed.facts["changed"] =
    record?._tag === "VerifyReport" ? record.changed : [];
  check(
    `the ${LABEL} run's log holds one verify record over its change`,
    records.length === 1 &&
      record?._tag === "VerifyReport" &&
      record.changedCount > 0,
    `records=${records.length} changed=${record?._tag === "VerifyReport" ? record.changed.join(" ") : "-"}`,
  );
  const only = result.length === 1 ? result[0] : undefined;
  check(
    `the ${LABEL} record is ${EXPECT}`,
    only !== undefined &&
      only.surface === surface &&
      only._tag === tag &&
      (exit === undefined ||
        (only._tag === "VerifyRan" && String(only.exitCode) === exit)),
    result
      .map(
        (r) =>
          `${r.surface}:${r._tag}${r._tag === "VerifyRan" ? `:${r.exitCode}` : ""}`,
      )
      .join(" ") || "no results",
  );
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
} else if (MODE === "settled") {
  await runScoped(settled);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(
    path.join(EVIDENCE_DIR, `requires-${LABEL}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  process.exit(failed() ? 1 : 0);
} else {
  console.error("requires.ts: MODE must be one of seed, settled");
  process.exit(2);
}
