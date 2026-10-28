// Two phases of one driver, so one file owns both halves of the mission-restart story (LOB-231).
//
//   MODE=arm     register the checkout, create a session on it, and start a mission whose implement
//                fans out to two workers. The API runs with a faux command that sleeps, so each
//                worker's conversation is in flight on a `bash` call; once the mission waits in
//                implement on both, with both workers' tool calls live, write what was seen to
//                MISSION_RESTART_STATE and exit. ./mission-restart.sh kills that API.
//   MODE=verify  against a fresh API that nobody sent anything: the boot reopened the session, the
//                checkpoint and the `factory.mission` document both say implement, and the mission
//                waits on the same workers in the same conversations. Each worker's check holds on a
//                file this driver writes, so that is read while the mission is still in implement;
//                released, the workers finish, the mission enters verify (and only verify — not plan
//                again), and the repo's verify command runs.
//
// Env: API_URL, MODE, MISSION_RESTART_STATE, EVIDENCE_DIR, MISSION_RESTART_CHECKOUT (the checkout
// the session's worktree is cut from), MISSION_RESTART_REPO (the slug it is registered as),
// MISSION_RESTART_HOLD (the directory the release file is written to).
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import {
  RepoSlug,
  type SessionId,
  type SessionTask,
} from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9410";
const MODE = process.env["MODE"] ?? "arm";
const STATE =
  process.env["MISSION_RESTART_STATE"] ??
  ".verify/run/mission-restart/state.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const CHECKOUT =
  process.env["MISSION_RESTART_CHECKOUT"] ??
  ".verify/run/mission-restart/checkout";
const HOLD =
  process.env["MISSION_RESTART_HOLD"] ?? ".verify/run/mission-restart/hold";
const REPO = RepoSlug.make(
  process.env["MISSION_RESTART_REPO"] ?? "lobiklukas/factory-mission-restart",
);

const WORKER_IDS = ["a", "b"] as const;
const MISSION_KIND = "factory.mission";
const WORKER_KIND = "factory.mission.worker";
/** What the repo's verify command leaves in the worktree: the mission ran verify, to the end. */
const VERIFIED = ".mission-verified";

/** The file a worker's check appends one line to per run, in the worktree. */
const runsFile = (worker: string) => `.mission-${worker}.runs`;
/** How many times a worker's check has started. */
const runsOf = (worktree: string, worker: string): number => {
  const file = path.join(worktree, runsFile(worker));
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;
};

type Armed = {
  readonly sessionId: SessionId;
  readonly missionId: string;
  readonly worktree: string;
  readonly workers: ReadonlyArray<{
    readonly id: string;
    readonly conversations: ReadonlyArray<string>;
  }>;
};

await mkdir(path.dirname(STATE), { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  mode: string;
  sessionId: SessionId | null;
  snapshots: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  mode: MODE,
  sessionId: null,
  snapshots: {},
  checks: {},
};
const assert = makeChecker(observed);

const workersIn = (tasks: ReadonlyArray<SessionTask>) =>
  tasks.filter((task) => task.kind === WORKER_KIND);

/**
 * What a snapshot says about the mission, for the evidence and the checks: its task (the
 * checkpoint's phase, what it waits on), its workers, and the document's phase.
 */
const missionView = (snapshot: {
  readonly session: { readonly mode: string };
  readonly mission?:
    | {
        readonly taskId: string;
        readonly phase: string;
        readonly entered: ReadonlyArray<string>;
      }
    | undefined;
  readonly tasks: ReadonlyArray<SessionTask>;
}) => ({
  mode: snapshot.session.mode,
  document: snapshot.mission ?? null,
  tasks: snapshot.tasks,
});

/**
 * Arm: a mission waiting in implement on two workers whose conversations are each on a `bash` call
 * that sleeps. That is the moment the script sends SIGTERM in.
 */
const arm = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  yield* client.registerRepo({ repo: REPO, localPath: CHECKOUT });
  const created = yield* client.createSession({
    title: "mission restart probe",
    repo: REPO,
    baseRef: "main",
  });
  observed.sessionId = created.id;
  const worktree = (yield* client.getSession({ sessionId: created.id }))
    .workspace.path;
  // Each check counts its run in the worktree, then holds until the driver's release exists: an
  // absolute path outside the worktree is only read, which the session's policy allows.
  const release = path.join(HOLD, "release");
  const started = yield* client.startMission({
    sessionId: created.id,
    feature: "a mission that outlives its process",
    workers: WORKER_IDS.map((id) => ({
      id,
      prompt: `do part ${id}`,
      check: `echo run >> ${runsFile(id)}; while [ ! -f ${release} ]; do sleep 0.05; done`,
    })),
  });
  const inFlight = yield* waitUntil(
    client.getSession({ sessionId: created.id }).pipe(
      Effect.map((snapshot) => {
        const mission = snapshot.tasks.find(
          (task) => task.id === started.taskId,
        );
        const workers = workersIn(snapshot.tasks);
        // A tool call is a task its generation owns, and the session's own conversation is idle:
        // so every `bash` live here is a worker's.
        const tools = snapshot.tasks.filter(
          (task) => task.kind === "pi.tool" && task.phase === "execute",
        );
        return mission?.status === "waiting" &&
          mission.phase === "implement" &&
          workers.length === WORKER_IDS.length &&
          workers.every((worker) => worker.phase === "converse") &&
          tools.length === WORKER_IDS.length &&
          !snapshot.live.busy
          ? snapshot
          : undefined;
      }),
    ),
    "the mission to wait in implement with both workers' tool calls in flight",
  );
  observed.snapshots["inFlight"] = missionView(inFlight);
  const mission = inFlight.tasks.find((task) => task.id === started.taskId);
  const workers = workersIn(inFlight.tasks);
  assert(
    "the mission's checkpoint is implement, waiting on its two workers",
    mission?.kind === MISSION_KIND &&
      mission.status === "waiting" &&
      mission.phase === "implement" &&
      mission.waitingOn.join(",") === workers.map((each) => each.id).join(","),
    `mission=${JSON.stringify(mission ?? null)}`,
  );
  assert(
    "the mission's document says implement too",
    inFlight.mission?.taskId === started.taskId &&
      inFlight.mission.phase === "implement" &&
      inFlight.mission.entered.join(",") === "plan,implement",
    `document=${JSON.stringify(inFlight.mission ?? null)}`,
  );
  assert(
    "each worker is in its conversation, on a tool call, and no check has run",
    workers.every(
      (worker) =>
        worker.owner === started.taskId &&
        worker.phase === "converse" &&
        worker.conversations.length === 1,
    ) && WORKER_IDS.every((id) => runsOf(worktree, id) === 0),
    `workers=${JSON.stringify(workers)} runs=${WORKER_IDS.map((id) => runsOf(worktree, id)).join(",")}`,
  );
  const armed: Armed = {
    sessionId: created.id,
    missionId: started.taskId,
    worktree,
    workers: workers.map((worker) => ({
      id: worker.id,
      conversations: worker.conversations,
    })),
  };
  yield* Effect.promise(() => writeFile(STATE, JSON.stringify(armed)));
  console.log(
    `armed ${created.id}: mission ${started.taskId} in implement — SIGTERM is safe now`,
  );
  return created.id;
});

/**
 * Verify: what the interrupted API left behind, resumed by a fresh one that no client has sent
 * anything to.
 */
const verify = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const armed = JSON.parse(
    yield* Effect.promise(() => readFile(STATE, "utf8")),
  ) as Armed;
  const { sessionId, missionId, worktree } = armed;
  observed.sessionId = sessionId;

  // The boot's own resume is the only thing that can make this session live: the driver has only
  // read it, and a read of a session nobody owns is a fold.
  const resumed = yield* waitUntil(
    client
      .getSession({ sessionId })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.session.mode === "live" &&
          workersIn(snapshot.tasks).every(
            (worker) => worker.phase === "check",
          ) &&
          WORKER_IDS.every((id) => runsOf(worktree, id) === 1)
            ? snapshot
            : undefined,
        ),
      ),
    "the boot to resume the mission and its workers to reach their check",
  );
  observed.snapshots["resumed"] = missionView(resumed);
  const mission = resumed.tasks.find((task) => task.id === missionId);
  const workers = workersIn(resumed.tasks);
  assert(
    "the boot reopened the session nobody sent anything to",
    resumed.session.mode === "live",
    `mode=${resumed.session.mode}`,
  );
  assert(
    "after the restart the mission's checkpoint is still implement",
    mission?.kind === MISSION_KIND &&
      mission.status === "waiting" &&
      mission.phase === "implement",
    `mission=${JSON.stringify(mission ?? null)}`,
  );
  assert(
    "and its factory.mission document says implement, entered plan then implement once",
    resumed.mission?.taskId === missionId &&
      resumed.mission.phase === "implement" &&
      resumed.mission.entered.join(",") === "plan,implement",
    `document=${JSON.stringify(resumed.mission ?? null)}`,
  );
  assert(
    "it waits on the same workers, in the same conversations — nothing fanned out again",
    mission?.waitingOn.join(",") ===
      armed.workers.map((worker) => worker.id).join(",") &&
      JSON.stringify(
        workers.map((worker) => ({
          id: worker.id,
          conversations: worker.conversations,
        })),
      ) === JSON.stringify(armed.workers),
    `before=${JSON.stringify(armed.workers)} after=${JSON.stringify(workers.map((worker) => ({ id: worker.id, conversations: worker.conversations })))}`,
  );
  assert(
    "each worker's interrupted conversation answered and its check started, once",
    workers.every((worker) => worker.phase === "check") &&
      WORKER_IDS.every((id) => runsOf(worktree, id) === 1),
    `phases=${workers.map((worker) => worker.phase).join(",")} runs=${WORKER_IDS.map((id) => runsOf(worktree, id)).join(",")}`,
  );

  yield* Effect.promise(() => writeFile(path.join(HOLD, "release"), ""));
  const settled = yield* waitUntil(
    client
      .getSession({ sessionId })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.tasks.length === 0 && snapshot.mission?.phase === "verify"
            ? snapshot
            : undefined,
        ),
      ),
    "the resumed mission to settle",
  );
  observed.snapshots["settled"] = missionView(settled);
  assert(
    "the workers ran to completion and the mission moved on to verify",
    settled.mission?.taskId === missionId &&
      settled.mission.phase === "verify" &&
      settled.tasks.length === 0,
    `document=${JSON.stringify(settled.mission ?? null)} tasks=${settled.tasks.length}`,
  );
  assert(
    "the mission was never restarted from plan",
    settled.mission?.entered.join(",") === "plan,implement,verify",
    `entered=${settled.mission?.entered.join(",") ?? "none"}`,
  );
  assert(
    "verify ran the repo's command, so the mission completed rather than failing",
    existsSync(path.join(worktree, VERIFIED)),
    `${VERIFIED} ${existsSync(path.join(worktree, VERIFIED)) ? "present" : "absent"}`,
  );
  assert(
    "each worker's check ran exactly once across the restart",
    WORKER_IDS.every((id) => runsOf(worktree, id) === 1),
    `runs=${WORKER_IDS.map((id) => runsOf(worktree, id)).join(",")}`,
  );
  return sessionId;
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
// One file per phase: the arm phase's evidence (a mission in flight) is as much a fact as the
// verify phase's, and a shared name would overwrite it.
await writeFile(
  path.join(EVIDENCE_DIR, `mission-restart-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
