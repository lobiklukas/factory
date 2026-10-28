// Two phases of one driver, so one file owns both halves of the run-restart story (LOB-25).
//
//   MODE=arm     create a scratch session and send it one message under a request id. The API runs
//                with a faux command that counts its run into the worktree and then holds on a file
//                this drive never writes until the end, so the run is genuinely in flight on a `bash`
//                call; once it is, write what was seen to RUN_RESTART_STATE and exit.
//                ./run-restart.sh kills that API (SIGKILL by default).
//   MODE=verify  against a fresh API that nobody sent anything: the boot reopened the session and the
//                run carried on — the same submission, the transcript the dead process left as its
//                start, the interrupted tool call settled as interrupted rather than run again, and
//                an answer after it. A client retrying the request it never heard back about gets the
//                same submission, and the transcript still holds one message.
//
// Env: API_URL, MODE, RUN_RESTART_STATE, EVIDENCE_DIR.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9430";
const MODE = process.env["MODE"] ?? "arm";
const STATE =
  process.env["RUN_RESTART_STATE"] ?? ".verify/run/run-restart/state.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

const PROMPT = "run restart probe";
const REQUEST_ID = "run-restart-probe";
/** The file the faux command appends one line to per run, in the worktree. */
const RUNS = "run-restart.runs";

const runsIn = (worktree: string): number => {
  const file = path.join(worktree, RUNS);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;
};

type Armed = {
  readonly sessionId: SessionId;
  readonly submissionId: string;
  readonly worktree: string;
  /** The transcript's entry ids when the process was killed: what the resumed run must extend. */
  readonly entryIds: ReadonlyArray<string>;
};

type TranscriptRow = {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly isError: boolean | null;
};

await mkdir(path.dirname(STATE), { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  mode: string;
  sessionId: SessionId | null;
  transcript: ReadonlyArray<TranscriptRow>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  mode: MODE,
  sessionId: null,
  transcript: [],
  checks: {},
};
const assert = makeChecker(observed);

const transcriptOf = (
  entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly text: string;
    readonly isError?: boolean | undefined;
  }>,
): ReadonlyArray<TranscriptRow> =>
  entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    isError: entry.isError ?? null,
  }));

/** Arm: one message, its run on a `bash` call that holds — the moment the script kills the API. */
const arm = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const created = yield* client.createSession({ title: PROMPT });
  observed.sessionId = created.id;
  const sent = yield* client.sendMessage({
    sessionId: created.id,
    content: PROMPT,
    requestId: REQUEST_ID,
  });
  const worktree = (yield* client.getSession({ sessionId: created.id }))
    .workspace.path;
  yield* waitUntil(
    Effect.sync(() => runsIn(worktree) === 1 || undefined),
    "the run's tool call to start",
  );
  const snapshot = yield* client.getSession({ sessionId: created.id });
  observed.transcript = transcriptOf(snapshot.entries);
  assert(
    "the run is in flight on its tool call when the process is killed",
    snapshot.live.busy && runsIn(worktree) === 1,
    `busy=${snapshot.live.busy} runs=${runsIn(worktree)} submission=${sent.submissionId}`,
  );
  const armed: Armed = {
    sessionId: created.id,
    submissionId: sent.submissionId,
    worktree,
    entryIds: snapshot.entries.map((entry) => entry.id),
  };
  yield* Effect.promise(() => writeFile(STATE, JSON.stringify(armed)));
  return created.id;
});

/** Verify: what a fresh API, sent nothing, made of the run the dead one left. */
const verify = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const armed = JSON.parse(
    yield* Effect.promise(() => readFile(STATE, "utf8")),
  ) as Armed;
  observed.sessionId = armed.sessionId;

  // The boot resumes in the background; a session it reopened reads live, and settles once the run
  // has answered.
  const settled = yield* waitUntil(
    client
      .getSession({ sessionId: armed.sessionId })
      .pipe(
        Effect.map(
          (snapshot) =>
            snapshot.session.mode === "live" && !snapshot.live.busy && snapshot,
        ),
      ),
    "the resumed run to settle",
  );
  observed.transcript = transcriptOf(settled.entries);
  assert(
    "the boot reopened the session: it reads live though nobody sent it anything",
    settled.session.mode === "live",
    `mode=${settled.session.mode} status=${settled.session.status}`,
  );
  const ids = settled.entries.map((entry) => entry.id);
  assert(
    "the same run: the transcript the dead process left is the start of this one",
    armed.entryIds.every((id, index) => ids[index] === id) &&
      ids.length > armed.entryIds.length,
    `${armed.entryIds.length} entries before, ${ids.length} after`,
  );
  const users = settled.entries.filter((entry) => entry.kind === "user");
  assert(
    "one message, sent once",
    users.length === 1 && users[0]?.text === PROMPT,
    `users=${users.length}`,
  );
  const results = settled.entries.filter(
    (entry) => entry.kind === "toolResult",
  );
  assert(
    "the tool call the kill interrupted is settled as interrupted",
    results.length === 1 &&
      results[0]?.isError === true &&
      results[0].text.includes("interrupted"),
    `results=${JSON.stringify(results.map((entry) => entry.text))}`,
  );
  assert(
    "and was not run a second time",
    runsIn(armed.worktree) === 1,
    `runs=${runsIn(armed.worktree)}`,
  );
  assert(
    "the run answered after it",
    settled.entries.at(-1)?.kind === "assistant",
    `last=${settled.entries.at(-1)?.kind ?? "none"}`,
  );

  const retried = yield* client.sendMessage({
    sessionId: armed.sessionId,
    content: PROMPT,
    requestId: REQUEST_ID,
  });
  const after = yield* client.getSession({ sessionId: armed.sessionId });
  assert(
    "a client retrying its request gets the same submission, and nothing is submitted twice",
    retried.submissionId === armed.submissionId &&
      after.entries.filter((entry) => entry.kind === "user").length === 1,
    `submission=${retried.submissionId} expected=${armed.submissionId} users=${after.entries.filter((entry) => entry.kind === "user").length}`,
  );
  return armed.sessionId;
});

const phase = MODE === "arm" ? arm : verify;
let sessionId: SessionId | null = null;
try {
  sessionId = await Effect.runPromise(
    phase.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
  );
} catch (error) {
  assert(`${MODE} phase completed`, false, `threw: ${String(error)}`);
}

observed.sessionId = sessionId ?? observed.sessionId;
// One file per phase: the arm phase's evidence (a run in flight) is as much a fact as the verify
// phase's, and a shared name would overwrite it.
await writeFile(
  path.join(EVIDENCE_DIR, `run-restart-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
