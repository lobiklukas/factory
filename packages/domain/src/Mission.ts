/**
 * The mission contract: starting one, and reading the phase it reached (LOB-230, part 2 of
 * LOB-192).
 *
 * **The surface decision.** Two shapes were open to this part: a `MissionRpc` group of its own, or
 * a member of `SessionRpc` with the phase riding `getSession`'s snapshot. It is a member of
 * `SessionRpc`, because a mission is not a thing a client holds — it is state *of a session*. A
 * client that starts a mission and then loses its id still has to be able to ask what that session
 * is doing, and the session's snapshot is where every other durable fact about a session is read
 * (`live`, `usage`, `tasks`, `approvals`). A separate group would have made the phase reachable
 * only through an id the client might have dropped.
 *
 * `startMission` answers the mission's id, because that is what a caller needs to name the mission
 * it started; the *phase* is read off the snapshot's `mission`, so there is exactly one answer to
 * "what phase is this session's mission in" and it is the log's.
 *
 * This module imports `@repo/domain/Ids` and nothing else of this package, the way `Approval` does:
 * `Session.ts` imports *this* module for the snapshot's `mission` field, so a `SessionSummary` here
 * would be a cycle. A caller that wants the session summary reads the session (`getSession`), which
 * is what the snapshot is for.
 */
import { Schema } from "effect";
import { SessionId } from "@repo/domain/Ids";

/**
 * The phases a mission passes through, in order (`packages/harness/src/mission.ts`).
 *
 * Defined here, once, and imported by the harness: a phase the wire accepts and a phase the durable
 * task can enter cannot drift apart.
 */
export const MISSION_PHASES = ["plan", "implement", "verify"] as const;

export const MissionPhase = Schema.Literals(MISSION_PHASES);
export type MissionPhase = typeof MissionPhase.Type;

/** Whether a value a log holds is a phase this contract can carry. */
export const isMissionPhase = (value: unknown): value is MissionPhase =>
  typeof value === "string" &&
  (MISSION_PHASES as readonly string[]).includes(value);

/**
 * One session's mission, as its snapshot reports it: the mission's id, the phase it is in, and the
 * phases it has passed through in order.
 *
 * `phase` cannot be empty here: a mission that has entered no phase is not reported at all, which is
 * why the snapshot's field is optional. "No phase yet" and "no mission" are different facts, and a
 * client handed an empty phase would have to guess which one it got.
 */
export const MissionSnapshot = Schema.Struct({
  taskId: Schema.String,
  phase: MissionPhase,
  entered: Schema.Array(MissionPhase),
});
export type MissionSnapshot = typeof MissionSnapshot.Type;

/**
 * The mission task's definition version (`packages/harness/src/mission.ts`), which every document
 * the mission commits records as its `definitionVersion`.
 *
 * Defined here, beside the table that reads an older document forward, because both read paths —
 * the harness's `readMission` and the session snapshot's `missionSnapshot` — have to read a
 * document through the definition that wrote it, and a version the table and the task disagree on
 * would be a document read under the wrong rules.
 */
export const MISSION_VERSION = 2;

/** What a mission's document says, read under the current definition: the phase, and how it got there. */
export type MissionPhaseRecord = {
  /** The phase the mission's checkpoint is in — what a resume continues from. */
  readonly phase: MissionPhase;
  /** Every phase the mission entered, in the order it entered them. */
  readonly entered: readonly MissionPhase[];
};

/** The phase after `phase`, or `phase` itself when it is the last one. */
const successor = (phase: MissionPhase): MissionPhase =>
  MISSION_PHASES[
    Math.min(MISSION_PHASES.indexOf(phase) + 1, MISSION_PHASES.length - 1)
  ] ?? phase;

/**
 * How a document an older definition wrote reads under this one, keyed by the version that wrote
 * it; a document is carried through every step from its version up to `MISSION_VERSION`.
 *
 * Version 1 (LOB-233) recorded the phase whose handler *ran*, in the same commit that moved the
 * checkpoint to the *next* phase, so its document lags the checkpoint by one: a v1 `plan` is a
 * mission in `implement`, and a v1 `implement` is a mission in `verify`. A v1 `verify` is the
 * mission in `verify` — that phase's commit settles the mission, so there is no next phase for it to
 * lag behind. `entered` gains the phase read forward, so the list still ends in the phase the
 * mission is in.
 *
 * One v1 document cannot be read exactly from the document alone: the seed v1's `startMission`
 * wrote (`plan`, `[plan]`) is the document v1's plan commit leaves, value for value. So this table
 * is the rule only where nothing better is at hand. A reader holding the live task record passes
 * its checkpoint to `readMissionDoc`, and a live v1 mission — including one killed between its start
 * and its first phase, which sits `pending` until a caller asks for progress — reads the phase the
 * checkpoint names. Two readers have no checkpoint, and for them a v1 seed reads `implement` for
 * good: the folded read of a released session, and a v1 mission that settled (aborted, or faulted)
 * before plan ran, whose terminal record holds no checkpoint and whose document no commit rewrites.
 */
const MISSION_DOC_MIGRATIONS: Readonly<
  Record<number, (record: MissionPhaseRecord) => MissionPhaseRecord>
> = {
  1: ({ phase, entered }) => {
    const next = successor(phase);
    return {
      phase: next,
      entered:
        entered[entered.length - 1] === next ? entered : [...entered, next],
    };
  },
};

/** The phase a task record's checkpoint names, or `undefined` when it names none this contract knows. */
const checkpointPhase = (checkpoint: unknown): MissionPhase | undefined =>
  typeof checkpoint === "object" &&
  checkpoint !== null &&
  "phase" in checkpoint &&
  isMissionPhase(checkpoint.phase)
    ? checkpoint.phase
    : undefined;

/**
 * Read a mission's document under the current definition: the phase it names, read forward from
 * the version that wrote it.
 *
 * The values are `unknown` because a document is data a previous version wrote. A phase or an
 * `entered` entry this contract does not know is dropped rather than carried, which is what the
 * harness's own reopen does. A document with no `definitionVersion`, or one newer than this
 * definition, is read as written: there is no rule for it to be read through. `undefined` is "this
 * mission has entered no phase", which is a mission whose document still holds its seed.
 *
 * `checkpoint` is the live task record's checkpoint, when the reader has one. It decides only for a
 * document an older definition wrote: such a document was not committed under this definition's
 * rule that the document names the checkpoint's phase, so the checkpoint is the better witness, and
 * it is the one thing that tells a v1 seed from a v1 plan commit. A current document already names
 * the checkpoint's phase — the two are one commit — so it is read as written.
 */
export const readMissionDoc = (
  doc: {
    readonly phase?: unknown;
    readonly entered?: unknown;
    readonly definitionVersion?: unknown;
  },
  checkpoint?: unknown,
): MissionPhaseRecord | undefined => {
  if (!isMissionPhase(doc.phase)) return undefined;
  const entered = Array.isArray(doc.entered) ? doc.entered : [];
  let record: MissionPhaseRecord = {
    phase: doc.phase,
    entered: entered.filter(isMissionPhase),
  };
  const from = doc.definitionVersion;
  // A version below the first one is no definition's: the seed's `0` never names a phase.
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1)
    return record;
  if (from >= MISSION_VERSION) return record;
  const live = checkpointPhase(checkpoint);
  if (live !== undefined)
    return {
      phase: live,
      entered:
        record.entered[record.entered.length - 1] === live
          ? record.entered
          : [...record.entered, live],
    };
  for (let version = from; version < MISSION_VERSION; version++) {
    const migrate = MISSION_DOC_MIGRATIONS[version];
    if (migrate !== undefined) record = migrate(record);
  }
  return record;
};

/**
 * A mission read back from the two documents it commits: the binding names its task id, and the
 * mission's own document names the phase it reached, read through `readMissionDoc`.
 *
 * One function serves both read paths — a live harness snapshot and a raw document folded out of a
 * released session's log — so the two cannot read one document as two phases. `checkpoint` is the
 * live task's, which only the live path has; see `readMissionDoc`.
 */
export const missionSnapshot = (
  taskId: string,
  doc: {
    readonly phase?: unknown;
    readonly entered?: unknown;
    readonly definitionVersion?: unknown;
  },
  checkpoint?: unknown,
): MissionSnapshot | undefined => {
  const record = readMissionDoc(doc, checkpoint);
  return record === undefined ? undefined : { taskId, ...record };
};

/**
 * One independent subtask of a mission (LOB-193): a worker the implement phase fans out to, run as
 * a child task of the mission in a conversation it owns (`packages/harness/src/mission-worker.ts`).
 *
 * `id` names the worker within its mission — what a failure, an abort reason and a cost breakdown
 * are keyed by — so two workers of one mission may not share it. `prompt` is what the worker's
 * conversation is asked. `check` is the command, run in the session's workspace, that decides
 * whether the worker succeeded; a worker without one succeeds once its conversation answered.
 */
export const MissionWorker = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  check: Schema.optional(Schema.String),
});
export type MissionWorker = typeof MissionWorker.Type;

/**
 * How a mission's join treats a worker that settles other than `completed`: `failFast` aborts the
 * workers still running, `allSettled` lets them finish. The names are Pi Durable's `JoinPolicy`,
 * because that is the rule the durable wait applies. A mission with a failed worker fails either
 * way; the policy decides only what happens to the others.
 */
export const MISSION_JOIN_POLICIES = ["failFast", "allSettled"] as const;
export const MissionJoin = Schema.Literals(MISSION_JOIN_POLICIES);
export type MissionJoin = typeof MissionJoin.Type;

/**
 * What starting a mission needs: the session it runs in, the feature it takes through the phases,
 * and — optionally — the independent workers implement fans out to and the policy that joins them.
 *
 * The workspace is not here. The server resolves it from the session, so a client cannot point a
 * mission at a directory that session does not own — the same rule every other session call
 * follows. A worker's `check` runs in that workspace for the same reason.
 */
export const StartMissionInput = Schema.Struct({
  sessionId: SessionId,
  feature: Schema.String,
  workers: Schema.optional(Schema.Array(MissionWorker)),
  join: Schema.optional(MissionJoin),
});
export type StartMissionInput = typeof StartMissionInput.Type;

/**
 * What `startMission` answers: which session, and the id of the mission it started.
 *
 * The phase is deliberately absent. A mission that has just been created has entered `plan`
 * (`MissionTask.initial`) but the durable task may not have committed its first phase yet, so the
 * honest answer to "what phase did it reach" is still pending — the client reads it from the
 * snapshot's `mission` when it changes, which is also where it reads it after a restart.
 */
export const StartMissionResult = Schema.Struct({
  sessionId: SessionId,
  taskId: Schema.String,
});
export type StartMissionResult = typeof StartMissionResult.Type;
