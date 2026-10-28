#!/usr/bin/env bun
// What `pr-settle.sh` cannot do from a terminal (F14, F16): seed a card straight into `building`, and
// read a run's session back while the drive waits on it.
//
//   MODE=seed REPO=…                     one board over the newest `default` definition on the
//                                        already-registered REPO, one card on it moved straight into
//                                        `building` (the walk there is requires.sh's), printed as one
//                                        JSON line: {"boardId":…,"taskId":…}.
//   MODE=wait SESSION_ID=… [ANSWERS=n]   until the session is idle with at least ANSWERS assistant
//             [UNTIL=text]               entries (default 1) and, when UNTIL is set, an entry whose
//                                        text holds it — then one JSON line: busy, prUrl, the
//                                        entries the control plane wrote (kind `other`), and the
//                                        worktree. Exits 1 when that does not happen within 90 s.
//   MODE=record SESSION_ID=…             the session's `factory.pr` record as its log holds it, read
//                                        with no owner: {"url":…,"commit":…}, or {} for none.
//
// Env: API_URL, MODE, REPO, SESSION_ID, ANSWERS, UNTIL, DATABASE_URL.
import { Effect, Layer, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { TaskService, TaskServiceLive } from "@repo/core";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { readRecordedPullRequest } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { protocolFor } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9407";
const MODE = process.env["MODE"] ?? "";
const REPO = process.env["REPO"] ?? "";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const ANSWERS = Number(process.env["ANSWERS"] ?? "1");
const UNTIL = process.env["UNTIL"] ?? "";

const seed = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const sql = yield* SqlClient;
  const board = yield* tasks.createBoard({
    repo: RepoSlug.make(REPO),
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  const card = yield* tasks.create({
    boardId: BoardInstanceId.make(board.id),
    title: "verify-board pr-settle card",
    repo: RepoSlug.make(REPO),
    actor: "cli",
  });
  // Straight into `building`, whose exit requires the PR this drive is about.
  yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
  console.log(JSON.stringify({ boardId: board.id, taskId: card.id }));
}).pipe(Effect.provide(TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive))));

const wait = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const started = Date.now();
  for (;;) {
    const snapshot = yield* client.getSession({ sessionId: SESSION });
    const answers = snapshot.entries.filter(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    ).length;
    const done =
      !snapshot.live.busy &&
      answers >= ANSWERS &&
      (UNTIL === "" ||
        snapshot.entries.some((entry) => entry.text.includes(UNTIL)));
    if (done || Date.now() - started > 90_000) {
      console.log(
        JSON.stringify({
          done,
          busy: snapshot.live.busy,
          answers,
          prUrl: snapshot.session.prUrl ?? null,
          worktree: snapshot.workspace.path,
          said: snapshot.entries
            .filter((entry) => entry.kind === "other")
            .map((entry) => entry.text),
        }),
      );
      if (!done) process.exit(1);
      return;
    }
    yield* Effect.sleep(200);
  }
});

const record = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const pr = yield* Effect.acquireUseRelease(
    Effect.promise(() => PostgresStorage.reader(sql, SESSION)),
    (storage) => readRecordedPullRequest(storage),
    (storage) => Effect.promise(() => storage.dispose()),
  );
  console.log(
    JSON.stringify(
      pr === undefined ? {} : { url: pr.url, commit: pr.commit ?? "" },
    ),
  );
}).pipe(Effect.provide(DatabaseLive));

const runScoped = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(Effect.provide(protocolFor(API_URL))),
  );

if (MODE === "seed") {
  await Effect.runPromise(seed);
} else if (MODE === "wait") {
  await runScoped(wait);
} else if (MODE === "record") {
  await Effect.runPromise(record);
} else {
  console.error("pr-settle.ts: MODE must be one of seed, wait, record");
  process.exit(2);
}
process.exit(0);
