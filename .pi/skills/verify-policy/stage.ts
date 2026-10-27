// Drive the read-only stage through the real session API (LOB-74, docs/board.md B4/B6).
//
//   FAUX_COMMAND="echo stage > stage-probe.txt && echo wrote stage-probe.txt" API_PORT=9600 ./up.sh
//   API_URL=http://localhost:9600 bun stage.ts
//
// Env:
//   API_URL       default http://localhost:9600
//   DATABASE_URL  the database the API runs on (the cards are seeded there, and the logs read back)
//   EVIDENCE_DIR  default .verify/evidence/latest
//
// One drive, two runs, the same tool call: a card in `specifying` and a card in `building` on one
// board, each started as a run through `createSession`, and the faux script calls `bash` with the
// same command in both — a redirect into a file inside the run's own worktree. In `specifying` the
// policy must refuse it in the stage's words and the file must not exist; in `building` it must run
// and the file must be there. A policy that refused the write everywhere fails the second half, and
// one that refused it nowhere fails the first: the rule is the stage's, not the session's.
//
// The cards are seeded with SQL, as `.pi/skills/verify-board/seed.ts` seeds its board: a card is
// created by a trigger (B2), and walking one through `planning`'s human gate is not what this
// surface is about. The run is the part under test, and it goes through the API.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { readSessionLog } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";

const API_URL = process.env["API_URL"] ?? "http://localhost:9600";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const CASE = "stage";
/** The file the scripted command writes, relative to the run's worktree. */
const PROBE = "stage-probe.txt";

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

await mkdir(EVIDENCE_DIR, { recursive: true });

const checks: Record<
  string,
  { readonly passed: boolean; readonly detail: string }
> = {};
const assert = (name: string, condition: unknown, detail: string): boolean => {
  checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

const observed: Record<string, unknown> = {
  case: CASE,
  apiUrl: API_URL,
  fauxCommand: process.env["FAUX_COMMAND"],
  probe: PROBE,
};

assert(
  "the api url is loopback, so the drive stays on this machine",
  LOOPBACK.test(API_URL),
  `apiUrl=${API_URL}`,
);

const ProtocolLive = RpcClient.layerProtocolHttp({
  url: `${API_URL}/rpc`,
}).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Poll until `check` yields anything but `false`, so the driver never depends on a fixed delay. */
const waitUntil = <A, E, R>(
  check: Effect.Effect<A | false | undefined, E, R>,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const value = yield* check;
      if (value !== false && value !== undefined) return value;
      yield* Effect.sleep(100);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/**
 * One board over the default pipeline (version 2, whose columns declare the roles) and one card in
 * each column. Fresh ids per drive, so a database this has run against before is only added to.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const hex = (bytes: number) => randomBytes(bytes).toString("hex");
  const boardId = `brd_${hex(13)}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${`verify-policy/${hex(6)}`}, 'default', 2)
  `;
  const card = (column: string) =>
    Effect.gen(function* () {
      const id = `tsk_${hex(13)}`;
      yield* sql`
        INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
        VALUES (${id}, ${boardId}, ${`verify-policy stage card in ${column}`}, ${column}, 2, 1)
      `;
      return id;
    });
  return {
    boardId,
    specifying: yield* card("specifying"),
    building: yield* card("building"),
  };
});

/** Start a run on a card in `column`, let its one tool call settle, and read what it left. */
const runIn = (column: string, taskId: string) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(SessionRpc);
    const sql = yield* SqlClient;
    const prompt = `verify-policy stage ${column}`;

    const created = yield* client.createSession({
      title: prompt,
      taskId,
      taskColumn: column,
    });
    const worktree = (yield* client.getSession({ sessionId: created.id }))
      .workspace.path;
    const sent = yield* client.sendMessage({
      sessionId: created.id,
      content: prompt,
    });

    // Settled means: the tool call has a result AND the run is idle — idle alone can be read before
    // the run starts.
    const snapshot = yield* waitUntil(
      client
        .getSession({ sessionId: created.id })
        .pipe(
          Effect.map((state) =>
            state.entries.some((entry) => entry.kind === "toolResult") &&
            !state.live.busy
              ? state
              : false,
          ),
        ),
      `the ${column} run's tool result to settle`,
    );

    // The run's log itself, read without the owner the way a rebuild reads it (D7): the refusal has
    // to be a fact in the log, not only in the API's live view of it.
    const storage = yield* Effect.promise(() =>
      PostgresStorage.reader(sql, created.id),
    );
    const log = yield* readSessionLog(storage).pipe(
      Effect.ensuring(Effect.promise(() => storage.dispose())),
    );

    const probePath = join(worktree, PROBE);
    const run = (yield* sql<{ column: string }>`
      SELECT "column" FROM task_runs WHERE session_id = ${created.id}
    `)[0];
    return {
      sessionId: created.id,
      placement: sent.placement,
      worktree,
      prompt,
      runColumn: run?.column,
      result: snapshot.entries.find((entry) => entry.kind === "toolResult"),
      logged: log.entries.find((entry) => entry.kind === "toolResult"),
      answer: snapshot.entries
        .filter((entry) => entry.kind === "assistant")
        .at(-1),
      wrote: existsSync(probePath),
      content: existsSync(probePath) ? readFileSync(probePath, "utf8") : null,
      entries: snapshot.entries.map((entry) => ({
        kind: entry.kind,
        isError: entry.isError,
        toolName: entry.toolName,
        text: entry.text,
      })),
    };
  });

const program = Effect.gen(function* () {
  const cards = yield* seed;
  observed["boardId"] = cards.boardId;

  const specifying = yield* runIn("specifying", cards.specifying);
  const building = yield* runIn("building", cards.building);
  observed["specifying"] = specifying;
  observed["building"] = building;

  for (const run of [specifying, building]) {
    assert(
      `the ${run.prompt} message is admitted as a run on its card`,
      run.placement === "run" && run.runColumn !== undefined,
      `placement=${run.placement} session=${run.sessionId} column=${String(run.runColumn)}`,
    );
  }

  // The specifying half: refused, in the stage's words, recorded in the log, and nothing written.
  const refusal = specifying.result?.text ?? "";
  assert(
    "the specifying run's write is refused as the tool result, not a crash",
    specifying.result?.isError === true,
    `isError=${specifying.result?.isError} text=${JSON.stringify(refusal)}`,
  );
  for (const fragment of [
    "Tool call blocked",
    `redirecting output to ${PROBE} is refused`,
    "read-only specifying stage",
    'column "specifying"',
  ]) {
    assert(
      `the refusal says ${JSON.stringify(fragment)}`,
      refusal.includes(fragment),
      `text=${JSON.stringify(refusal)}`,
    );
  }
  assert(
    "the refusal is recorded in the run's log",
    specifying.logged?.isError === true && specifying.logged.text === refusal,
    `logged=${JSON.stringify(specifying.logged?.text)}`,
  );
  assert(
    "the refused write did not happen",
    specifying.wrote === false,
    `probe=${join(specifying.worktree, PROBE)} exists=${specifying.wrote}`,
  );
  assert(
    "the refusal reaches the model's next turn",
    specifying.answer?.text === `${refusal.trim()} (re: ${specifying.prompt})`,
    `answer=${JSON.stringify(specifying.answer?.text)}`,
  );

  // The building half: the same call, run, and the file is there.
  assert(
    "the same call in building is not refused",
    building.result?.isError === false,
    `isError=${building.result?.isError} text=${JSON.stringify(building.result?.text)}`,
  );
  assert(
    "the building run's write really happened",
    building.wrote === true && building.content === "stage\n",
    `probe=${join(building.worktree, PROBE)} content=${JSON.stringify(building.content)}`,
  );
  assert(
    "the answer is the scripted provider's echo of the tool result",
    building.answer?.text === `wrote ${PROBE} (re: ${building.prompt})`,
    `answer=${JSON.stringify(building.answer?.text)}`,
  );
}).pipe(Effect.provide(Layer.merge(ProtocolLive, DatabaseLive)), Effect.scoped);

try {
  await Effect.runPromise(program);
} catch (cause) {
  // Evidence is written either way: a driver that died must not look like a driver that passed.
  assert("the driver completed", false, `threw: ${String(cause)}`);
}

observed["checks"] = checks;
observed["passed"] = Object.values(checks).every((check) => check.passed);

const evidencePath = `${EVIDENCE_DIR}/refusal-${CASE}.json`;
await writeFile(evidencePath, `${JSON.stringify(observed, null, 2)}\n`);

// The same aggregate `drive.ts` writes, so `refusals.json` holds every case `refusals.sh` ran.
const aggregatePath = `${EVIDENCE_DIR}/refusals.json`;
const previous = await readFile(aggregatePath, "utf8")
  .then((text) => JSON.parse(text) as Record<string, unknown>)
  .catch(() => ({}) as Record<string, unknown>);
previous[CASE] = observed;
previous["passed"] = Object.values(previous)
  .filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null,
  )
  .every((value) => value["passed"] === true);
await writeFile(aggregatePath, `${JSON.stringify(previous, null, 2)}\n`);

console.log(`evidence ${evidencePath}`);
console.log(`${observed["passed"] ? "PASS" : "FAIL"}  case ${CASE}`);
// The pool `DatabaseLive` opened keeps the process alive; the verdict is the exit code.
process.exit(observed["passed"] ? 0 : 1);
