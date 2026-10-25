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
 * A mission read back from the two documents it commits: the binding names its task id, and the
 * mission's own document names the phase it reached.
 *
 * The document values are `unknown` because one function serves both read paths — a live harness
 * snapshot and a raw document folded out of a released session's log — and because a document is
 * data a previous version wrote. A phase or an `entered` entry this contract does not know is
 * dropped rather than carried, which is what the harness's own reopen does. `undefined` is "this
 * mission has entered no phase", which is a mission whose document still holds its seed.
 */
export const missionSnapshot = (
  taskId: string,
  doc: { readonly phase?: unknown; readonly entered?: unknown },
): MissionSnapshot | undefined => {
  if (!isMissionPhase(doc.phase)) return undefined;
  const entered = Array.isArray(doc.entered) ? doc.entered : [];
  return { taskId, phase: doc.phase, entered: entered.filter(isMissionPhase) };
};

/**
 * What starting a mission needs: the session it runs in, and the feature it takes through the
 * phases.
 *
 * The workspace is not here. The server resolves it from the session, so a client cannot point a
 * mission at a directory that session does not own — the same rule every other session call
 * follows.
 */
export const StartMissionInput = Schema.Struct({
  sessionId: SessionId,
  feature: Schema.String,
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
