// Two phases of one driver, so a single file owns both halves of the approval-restart story (LOB-52).
//
//   MODE=arm     create a session and send it a task whose faux tool call is the gated command. The
//                run must park: one approval pending, the session idle long before the command's
//                sleep could have finished, the call blocked rather than run, and the request
//                committed to the log once (a pending answer is not memoized). Writes the session and
//                request ids to APPROVAL_STATE for ./approval-restart.sh, which kills the API.
//   MODE=verify  read the session the killed API left behind, from a fresh process: the approval is
//                still pending and the log holds one request. A new turn retries the same call,
//                records no second request, and is told it was not asked for again. Then a person
//                approves it, and the same call runs — once: the approval is spent, and the turn
//                after that asks a person again under a new request id.
//
// "One request" is counted in the log itself (`commits`), not in the pending list: the fold and the
// index both key a request by its id, so a duplicate request entry would be invisible to them.
//
// What this proves is the recorder's half: the request id is the call's identity across a killed
// process (the database answers a retry from the row it holds), and an approval covers one run.
// The kill lands after the tool task settled, so no recovery here reruns a task mid-ask; that the
// `api.memo` of a rerun task keeps it from spending a second approval is proven by
// packages/harness/src/policy.approval.test.ts, which loses the commit inside that window.
//
// Env: API_URL, MODE, APPROVAL_STATE, EVIDENCE_DIR, FAUX_COMMAND, DATABASE_URL.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApprovalsRpc, SessionRpc } from "@repo/domain/Rpc";
import type { SessionId, SessionSnapshot } from "@repo/domain/Session";
import { DatabaseLive } from "@repo/storage-postgres";
import { Clock, Effect, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import {
  makeChecker,
  protocolFor,
  recordedActor,
  waitUntil,
} from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9416";
const MODE = process.env["MODE"] ?? "arm";
const STATE =
  process.env["APPROVAL_STATE"] ?? ".verify/run/approval-restart/state.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const COMMAND = process.env["FAUX_COMMAND"] ?? "sleep 12 && echo gated-ran";
/** What the gated command prints once it runs, and how long it sleeps first. */
const RAN = "gated-ran";
const SLEEP_MS = Number(/sleep (\d+)/.exec(COMMAND)?.[1] ?? "12") * 1000;

const TASK = "publish the release";
const ACTOR = "verify-api operator";

await mkdir(path.dirname(STATE), { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

type TranscriptRow = {
  readonly kind: string;
  readonly text: string;
  readonly toolName: string | null;
  readonly isError: boolean | null;
};

type State = {
  readonly sessionId: SessionId;
  readonly requestId: string;
};

const observed: {
  apiUrl: string;
  mode: string;
  fauxCommand: string;
  sessionId: SessionId | null;
  requestId: string | null;
  log: Record<string, number>;
  approvals: Record<string, unknown>;
  transcript: ReadonlyArray<TranscriptRow>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  mode: MODE,
  fauxCommand: COMMAND,
  sessionId: null,
  requestId: null,
  log: {},
  approvals: {},
  transcript: [],
  checks: {},
};
const assert = makeChecker(observed);

const transcriptOf = (
  snapshot: SessionSnapshot,
): ReadonlyArray<TranscriptRow> =>
  snapshot.entries.map((entry) => ({
    kind: entry.kind,
    text: entry.text,
    toolName: entry.toolName ?? null,
    isError: entry.isError ?? null,
  }));

const toolResults = (snapshot: SessionSnapshot) =>
  snapshot.entries.filter((entry) => entry.kind === "toolResult");

/**
 * How many commits in the session's log carry `needle`. The log is the truth (D7): a second request
 * entry, or a second memo write, is a second commit holding it, whatever any fold makes of it.
 */
const commitsHolding = (sessionId: SessionId, needle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT count(*)::int AS count FROM commits
      WHERE log_id = ${sessionId} AND strpos(writes::text, ${needle}) > 0
    `;
    return rows[0]?.count ?? 0;
  });

const REQUEST_KIND = "factory.approval.requested";
const USED_KIND = "factory.approval.used";
const memoKey = (requestId: string) => `factory.approval:${requestId}`;

/** Poll a session until `done`, for longer than `waitUntil`'s budget: an approved run sleeps. */
const settle = <E, R>(
  get: Effect.Effect<SessionSnapshot, E, R>,
  done: (snapshot: SessionSnapshot) => boolean,
  label: string,
  budgetMs: number,
) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    for (;;) {
      const snapshot = yield* get;
      if (done(snapshot)) return snapshot;
      if ((yield* Clock.currentTimeMillis) - start > budgetMs) {
        return yield* Effect.die(new Error(`timed out waiting for ${label}`));
      }
      yield* Effect.sleep(100);
    }
  });

/**
 * Arm: a gated call parks the run on an approval, and the ask is in the log exactly once.
 */
const arm = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const approvals = yield* RpcClient.make(ApprovalsRpc);
  const created = yield* client.createSession({ title: "approval restart" });
  observed.sessionId = created.id;

  const started = yield* Clock.currentTimeMillis;
  const sent = yield* client.sendMessage({
    sessionId: created.id,
    content: TASK,
  });
  assert(
    "the task is admitted as a run",
    sent.placement === "run",
    `placement=${sent.placement}`,
  );

  // Parked: an approval is pending and the run is over. Polled together, so "idle" cannot be the
  // moment before the run started.
  const parked = yield* waitUntil(
    Effect.gen(function* () {
      const pending = yield* approvals.listApprovals({
        sessionId: created.id,
      });
      const snapshot = yield* client.getSession({ sessionId: created.id });
      return pending.approvals.length > 0 &&
        !snapshot.live.busy &&
        toolResults(snapshot).length > 0
        ? { pending, snapshot }
        : undefined;
    }),
    "the run to park on an approval",
  );
  // `waitUntil` returns only a value that is not `undefined`; this says so to the type checker.
  if (parked === undefined) return yield* Effect.die("unreachable");
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  observed.transcript = transcriptOf(parked.snapshot);
  observed.approvals["pending"] = parked.pending.approvals;
  const request = parked.pending.approvals[0];
  observed.requestId = request?.requestId ?? null;

  assert(
    "the run parks on one pending approval for the gated command",
    parked.pending.approvals.length === 1 &&
      request?.action === "sleep" &&
      request.detail === COMMAND,
    `pending=${parked.pending.approvals.length} action=${request?.action} detail=${JSON.stringify(request?.detail)}`,
  );
  assert(
    "the snapshot carries the same pending approval",
    parked.snapshot.approvals.length === 1 &&
      parked.snapshot.approvals[0]?.requestId === request?.requestId,
    `snapshot approvals=${parked.snapshot.approvals.map((approval) => approval.requestId).join(", ")}`,
  );
  assert(
    "the parked run is not busy: idle long before the command's sleep could end",
    parked.snapshot.session.status === "idle" &&
      !parked.snapshot.live.busy &&
      elapsed < SLEEP_MS / 2,
    `status=${parked.snapshot.session.status} busy=${parked.snapshot.live.busy} parked after ${elapsed}ms; FAUX_COMMAND sleeps ${SLEEP_MS}ms`,
  );
  const blocked = toolResults(parked.snapshot)[0];
  assert(
    "the gated call was blocked, not run",
    blocked?.isError === true &&
      blocked.text.includes("one has been asked for") &&
      !blocked.text.includes(RAN),
    `toolResult=${JSON.stringify(blocked?.text)}`,
  );

  const requestId = request?.requestId ?? "";
  const requests = yield* commitsHolding(created.id, REQUEST_KIND);
  const memos = yield* commitsHolding(created.id, memoKey(requestId));
  observed.log["requestCommits"] = requests;
  observed.log["memoCommits"] = memos;
  assert(
    "the log holds the request once",
    requests === 1,
    `commits holding ${REQUEST_KIND}: ${requests}`,
  );
  assert(
    "a pending answer is not memoized: the recorder's row is what a retry reads",
    memos === 0,
    `commits holding ${memoKey(requestId)}: ${memos}`,
  );

  const state: State = { sessionId: created.id, requestId };
  yield* Effect.promise(() => writeFile(STATE, JSON.stringify(state)));
  console.log(`armed ${created.id}: parked on ${requestId} — kill is safe now`);
  return created.id;
});

/**
 * Verify: a fresh process folds the approval, re-asks nothing, and runs the call once approved.
 */
const verify = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const approvals = yield* RpcClient.make(ApprovalsRpc);
  // The ids came from the server that minted them; a driver reading them back out of a file has to
  // say so rather than re-parse the pattern.
  const state = JSON.parse(
    yield* Effect.promise(() => readFile(STATE, "utf8")),
  ) as State;
  const { sessionId, requestId } = state;
  observed.sessionId = sessionId;
  observed.requestId = requestId;

  // 1. The fold: no process owns the session, so this is the log read back.
  const folded = yield* client.getSession({ sessionId });
  observed.transcript = transcriptOf(folded);
  assert(
    "the killed session folds from its log",
    folded.session.mode === "historical" && folded.session.status === "idle",
    `mode=${folded.session.mode} status=${folded.session.status}`,
  );
  assert(
    "the approval is still pending in the fold",
    folded.approvals.length === 1 &&
      folded.approvals[0]?.requestId === requestId,
    `snapshot approvals=${folded.approvals.map((approval) => approval.requestId).join(", ")}`,
  );
  const listed = yield* approvals.listApprovals({ sessionId });
  observed.approvals["afterRestart"] = listed.approvals;
  assert(
    "and in the pending list",
    listed.approvals.length === 1 &&
      listed.approvals[0]?.requestId === requestId,
    `pending=${listed.approvals.map((approval) => approval.requestId).join(", ")}`,
  );
  const afterRestart = yield* commitsHolding(sessionId, REQUEST_KIND);
  observed.log["requestCommitsAfterRestart"] = afterRestart;
  assert(
    "no second request after the restart",
    afterRestart === 1,
    `commits holding ${REQUEST_KIND}: ${afterRestart}`,
  );

  // 2. The agent retries the gated call (FAUX_EVERY_TURN): the same request, asked for nothing new.
  yield* client.sendMessage({ sessionId, content: "try again" });
  const retried = yield* settle(
    client.getSession({ sessionId }),
    (snapshot) => !snapshot.live.busy && toolResults(snapshot).length >= 2,
    "the retried turn to settle",
    20_000,
  );
  observed.transcript = transcriptOf(retried);
  const retry = toolResults(retried)[1];
  const afterRetry = yield* commitsHolding(sessionId, REQUEST_KIND);
  const pendingAfterRetry = yield* approvals.listApprovals({ sessionId });
  observed.log["requestCommitsAfterRetry"] = afterRetry;
  observed.approvals["afterRetry"] = pendingAfterRetry.approvals;
  assert(
    "the retried call is blocked and records no second request",
    retry?.isError === true &&
      !retry.text.includes(RAN) &&
      retry.text.includes("is not asked for again") &&
      afterRetry === 1 &&
      pendingAfterRetry.approvals.length === 1 &&
      pendingAfterRetry.approvals[0]?.requestId === requestId,
    `toolResult=${JSON.stringify(retry?.text)} requestCommits=${afterRetry} pending=${pendingAfterRetry.approvals.length}`,
  );

  // 3. A person approves; the next retry runs the command — busy for its sleep, then its output.
  const decision = yield* approvals.decideApproval({
    sessionId,
    requestId,
    decision: "approved",
    actor: ACTOR,
  });
  observed.approvals["decision"] = decision;
  const approvedAt = yield* Clock.currentTimeMillis;
  yield* client.sendMessage({ sessionId, content: "approved, go ahead" });
  const running = yield* waitUntil(
    client
      .getSession({ sessionId })
      .pipe(Effect.map((snapshot) => snapshot.live.busy || undefined)),
    "the approved run to start",
  );
  assert(
    "the approved call runs, and is busy while it does",
    running === true,
    `busy=${running}`,
  );
  const ran = yield* settle(
    client.getSession({ sessionId }),
    (snapshot) => !snapshot.live.busy && toolResults(snapshot).length >= 3,
    "the approved run to finish",
    SLEEP_MS + 30_000,
  );
  const ranFor = (yield* Clock.currentTimeMillis) - approvedAt;
  observed.transcript = transcriptOf(ran);
  const result = toolResults(ran)[2];
  const pendingAfterApproval = yield* approvals.listApprovals({ sessionId });
  const afterApproval = yield* commitsHolding(sessionId, REQUEST_KIND);
  observed.log["requestCommitsAfterApproval"] = afterApproval;
  observed.approvals["afterApproval"] = pendingAfterApproval.approvals;
  assert(
    "once approved, the same call ran to its output",
    result?.isError === false &&
      result.text.includes(RAN) &&
      ranFor >= SLEEP_MS,
    `toolResult=${JSON.stringify(result?.text)} after ${ranFor}ms`,
  );
  assert(
    "the approval is settled and still asked for once",
    pendingAfterApproval.approvals.length === 0 &&
      decision.actor === recordedActor(ACTOR) &&
      afterApproval === 1,
    `pending=${pendingAfterApproval.approvals.length} actor=${decision.actor} requestCommits=${afterApproval}`,
  );
  const used = yield* commitsHolding(sessionId, USED_KIND);
  const memos = yield* commitsHolding(sessionId, memoKey(requestId));
  observed.log["usedCommits"] = used;
  observed.log["memoCommitsAfterApproval"] = memos;
  // `>= 1`, not `=== 1`: a task row is rewritten whole, so the commit that records the run's
  // intent carries the memo the commit before it wrote.
  assert(
    "the approval was spent on that run, and the run memoized its answer",
    used === 1 && memos >= 1,
    `commits holding ${USED_KIND}: ${used}; holding ${memoKey(requestId)}: ${memos}`,
  );

  // 4. The agent runs the same call again: a new run needs a new yes, asked under a new id.
  yield* client.sendMessage({ sessionId, content: "run it again" });
  const again = yield* settle(
    client.getSession({ sessionId }),
    (snapshot) => !snapshot.live.busy && toolResults(snapshot).length >= 4,
    "the repeated turn to settle",
    20_000,
  );
  observed.transcript = transcriptOf(again);
  const repeated = toolResults(again)[3];
  const pendingAgain = yield* approvals.listApprovals({ sessionId });
  const afterRepeat = yield* commitsHolding(sessionId, REQUEST_KIND);
  observed.log["requestCommitsAfterRepeat"] = afterRepeat;
  observed.approvals["afterRepeat"] = pendingAgain.approvals;
  const second = `${requestId}-2`;
  assert(
    "the same call after the approved run asks again, under a new request id",
    repeated?.isError === true &&
      !repeated.text.includes(RAN) &&
      repeated.text.includes("one has been asked for") &&
      repeated.text.includes(second) &&
      pendingAgain.approvals.length === 1 &&
      pendingAgain.approvals[0]?.requestId === second &&
      afterRepeat === 2,
    `toolResult=${JSON.stringify(repeated?.text)} pending=${pendingAgain.approvals.map((approval) => approval.requestId).join(", ")} requestCommits=${afterRepeat}`,
  );
  return sessionId;
});

const ClientLive = Layer.mergeAll(protocolFor(API_URL), DatabaseLive);

const phase = MODE === "arm" ? arm : verify;
try {
  await Effect.runPromise(
    phase.pipe(Effect.provide(ClientLive), Effect.scoped),
  );
} catch (error) {
  assert(`${MODE} phase completed`, false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, `approval-restart-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, `approval-restart-${MODE}-transcript.txt`),
  `${observed.transcript
    .map(
      (entry) =>
        `${entry.kind}${entry.isError === true ? " (error)" : ""}: ${entry.text}${entry.toolName ? ` (${entry.toolName})` : ""}`,
    )
    .join("\n")}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
