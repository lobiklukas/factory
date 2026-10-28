// Per-worker cost attribution in a mission's snapshot (LOB-194, part 3 of LOB-35).
//
//   bun mission-cost.ts      (via ./mission-cost.sh, which owns the API instance this drives)
//
// The API this talks to runs the faux model priced at FAUX_COST (a cent a request); pi-ai's faux
// reports no cost on its own, so on any other instance there would be nothing to attribute. The faux
// script is two requests a run, so each worker costs two requests and the numbers are known without
// asking the snapshot: a worker's `usage.costTotal` is 2 * FAUX_COST, the two workers' costs add up to
// the session's `usage` and to the list's `costTotal` (which a database row, not the snapshot, holds),
// and the model's own request count is what the faux provider served.
//
// MODE=run     start a mission with two workers (and one that fans out to none, as the control),
//              read the breakdown while the owner holds the session and again once it is released
//              (the fold), and write the session id for the second pass
// MODE=reopen  read the same session after the API process was restarted — nothing in the new
//              process remembers the mission; the breakdown comes from the log
//
// Env: API_URL, EVIDENCE_DIR, FAUX_COST, MODE.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type { SessionId, SessionSnapshot } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9430";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const COST = Number(process.env["FAUX_COST"] ?? "0.01");
const MODE = process.env["MODE"] ?? "run";
const STATE_FILE = path.join(EVIDENCE_DIR, "mission-cost-session.json");

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  fauxCost: number;
  mode: string;
  sessions: Record<string, SessionId>;
  breakdowns: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  fauxCost: COST,
  mode: MODE,
  sessions: {},
  breakdowns: {},
  checks: {},
};
const assert = makeChecker(observed);

const close = (left: number, right: number) => Math.abs(left - right) < 1e-9;

const spentOf = (snapshot: SessionSnapshot): number =>
  [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
    (total, bucket) => total + bucket.usage.costTotal,
    0,
  );

const costsOf = (snapshot: SessionSnapshot): readonly number[] =>
  (snapshot.mission?.workers ?? []).map((worker) => worker.usage.costTotal);

const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);

/** The breakdown reconciles with the session's total, and each worker's cost is what two requests cost. */
const reconciles = (snapshot: SessionSnapshot): boolean => {
  const costs = costsOf(snapshot);
  return (
    costs.length === 2 &&
    costs.every((cost) => close(cost, 2 * COST)) &&
    close(sum(costs), spentOf(snapshot))
  );
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const read = (sessionId: SessionId) => client.getSession({ sessionId });

  if (MODE === "run") {
    const session = yield* client.createSession({
      requestId: `verify-mission-cost-${Date.now()}`,
    });
    observed.sessions["fanned"] = session.id;
    const started = yield* client.startMission({
      sessionId: session.id,
      feature: "verify-api per-worker cost probe",
      workers: [
        { id: "a", prompt: "do part a" },
        { id: "b", prompt: "do part b" },
      ],
    });
    // A scratch session declares no verify command, so the mission settles `failed` in verify once
    // both workers are done: the honest end of this probe, and after the workers' spend.
    const settled = yield* waitUntil(
      read(session.id).pipe(
        Effect.map((snapshot) =>
          snapshot.tasks.length === 0 &&
          snapshot.mission?.taskId === started.taskId &&
          snapshot.mission.phase === "verify"
            ? snapshot
            : undefined,
        ),
      ),
      "the mission to settle",
    );
    observed.breakdowns["live"] = settled.mission;
    assert(
      "two workers report two separate costs, each what two requests cost, in input order",
      settled.mission?.workers?.map((worker) => worker.id).join(",") ===
        "a,b" && costsOf(settled).every((cost) => close(cost, 2 * COST)),
      `workers=${JSON.stringify(settled.mission?.workers ?? null)}`,
    );
    assert(
      "the workers' costs add up to the session's total spend",
      reconciles(settled),
      `workers=${costsOf(settled).join("+")} session=${spentOf(settled)}`,
    );
    const workerConversations = (settled.mission?.workers ?? []).map(
      (worker) => worker.conversationId,
    );
    assert(
      "each worker is attributed to a conversation of its own",
      workerConversations.every((id) => id !== undefined) &&
        new Set(workerConversations).size === 2,
      `conversations=${workerConversations.join(",")}`,
    );
    const listed = (yield* client.listSessions({})).sessions.find(
      (each) => each.id === session.id,
    );
    assert(
      "the list's costTotal (an index row, not the snapshot) is the workers' sum",
      listed !== undefined &&
        close(listed.costTotal, sum(costsOf(settled))) &&
        listed.costTotal > 0,
      `listed=${listed?.costTotal ?? "none"}`,
    );

    // A mission with no workers has no breakdown, not an empty one.
    const lone = yield* client.createSession({
      requestId: `verify-mission-cost-lone-${Date.now()}`,
    });
    observed.sessions["lone"] = lone.id;
    const loneStarted = yield* client.startMission({
      sessionId: lone.id,
      feature: "verify-api no-worker probe",
    });
    const loneSettled = yield* waitUntil(
      read(lone.id).pipe(
        Effect.map((snapshot) =>
          snapshot.tasks.length === 0 &&
          snapshot.mission?.taskId === loneStarted.taskId &&
          snapshot.mission.phase === "verify"
            ? snapshot
            : undefined,
        ),
      ),
      "the worker-less mission to settle",
    );
    assert(
      "a mission that fanned out to none reports no workers",
      loneSettled.mission?.workers === undefined,
      `mission=${JSON.stringify(loneSettled.mission ?? null)}`,
    );

    // The fold: the owner is released once the session has been idle for the timeout (2s here), and
    // a read of a live session counts as use — so this reads far less often than the timeout, and
    // the first read waits for it, instead of polling the owner awake.
    const folded = yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.sleep("4 seconds");
        const snapshot = yield* read(session.id);
        if (snapshot.session.mode === "historical") return snapshot;
      }
      return yield* Effect.die(
        new Error("timed out waiting for the session's owner to be released"),
      );
    });
    observed.breakdowns["folded"] = folded.mission;
    assert(
      "a released session reports the same breakdown, read from the log",
      JSON.stringify(folded.mission?.workers) ===
        JSON.stringify(settled.mission?.workers) && reconciles(folded),
      `workers=${costsOf(folded).join("+")} session=${spentOf(folded)}`,
    );
    yield* Effect.promise(() =>
      writeFile(
        STATE_FILE,
        `${JSON.stringify({ sessionId: session.id, workers: settled.mission?.workers })}\n`,
      ),
    );
  } else {
    const state = (yield* Effect.promise(() =>
      readFile(STATE_FILE, "utf8"),
    ).pipe(Effect.map((text) => JSON.parse(text)))) as {
      sessionId: SessionId;
      workers: unknown;
    };
    observed.sessions["fanned"] = state.sessionId;
    const reopened = yield* read(state.sessionId);
    observed.breakdowns["reopened"] = reopened.mission;
    assert(
      "after the API restarted, the session's breakdown is the one the first process read",
      JSON.stringify(reopened.mission?.workers) ===
        JSON.stringify(state.workers) && reconciles(reopened),
      `workers=${costsOf(reopened).join("+")} session=${spentOf(reopened)}`,
    );
  }
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, `mission-cost-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
