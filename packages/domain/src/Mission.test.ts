/**
 * The mission contract (`Mission.ts`, LOB-230).
 *
 * Two claims this file exists for, both of which a wire contract can get wrong silently:
 *
 * - The phase is a schema, so a phase the task cannot enter cannot cross the wire. `plan`,
 *   `implement` and `verify` are the only three values `MissionSnapshot` decodes, and a fourth is a
 *   refusal rather than a string the server happens to have sent.
 * - "No mission" is not "an empty phase". A document a mission has not written yet holds its seed
 *   (`phase: ""`), and reading that as a mission would tell a client it has one with no phase —
 *   which is why `missionSnapshot` answers `undefined` instead, and why the snapshot's field is
 *   optional.
 *
 * Pure schema work: no database, no subprocess, so the cases read as decodes that must succeed and
 * decodes that must throw.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Schema } from "effect";
import { SessionId } from "./Ids";
import {
  MISSION_PHASES,
  MissionPhase,
  MissionSnapshot,
  StartMissionInput,
  StartMissionResult,
  isMissionPhase,
  missionSnapshot,
} from "./Mission";

/** Whether `schema` refuses `value`, as a value rather than a throw, so a case reads as data. */
const refuses = (schema: Schema.Codec<unknown>, value: unknown): boolean =>
  !Exit.isSuccess(
    Effect.runSync(Effect.exit(Schema.decodeUnknownEffect(schema)(value))),
  );

/** A session id in the shape `Ids.ts` promises, built through the contract rather than cast. */
const A_SESSION_ID = SessionId.make(`ses_${"0".repeat(26)}`);

/** A mission record as the snapshot carries it. */
const aMission = {
  taskId: "7",
  phase: "implement",
  entered: ["plan", "implement"],
} as const;

describe("a mission's phase", () => {
  it("accepts exactly the phases the task can enter, and refuses any other", () => {
    for (const phase of MISSION_PHASES) {
      expect(refuses(MissionPhase, phase)).toBe(false);
      expect(isMissionPhase(phase)).toBe(true);
    }
    // A renamed phase is refused, which is the claim: the wire cannot carry a phase the durable
    // task has no handler for.
    expect(refuses(MissionPhase, "implementing")).toBe(true);
    expect(refuses(MissionPhase, "")).toBe(true);
    // The seed's empty phase and a non-string are not phases either.
    expect(isMissionPhase("")).toBe(false);
    expect(isMissionPhase(undefined)).toBe(false);
    expect(isMissionPhase(3)).toBe(false);
  });

  it("carries a phase, the id of the mission and the phases it passed through", () => {
    const decoded = Schema.decodeSync(MissionSnapshot)(aMission);
    expect(decoded).toEqual(aMission);
    // `entered` is phases, so a foreign value inside it is refused rather than carried along.
    expect(
      refuses(MissionSnapshot, { ...aMission, entered: ["plan", "nope"] }),
    ).toBe(true);
    expect(refuses(MissionSnapshot, { ...aMission, phase: "" })).toBe(true);
  });
});

describe("reading a mission out of the documents it commits", () => {
  it("reports no mission while the mission's document still holds its seed", () => {
    // The document's seed is `phase: ""`: a mission that never entered one. That is not a mission
    // with an empty phase, and the snapshot says so by carrying no mission at all.
    expect(missionSnapshot("7", { phase: "", entered: [] })).toBeUndefined();
    expect(missionSnapshot("7", {})).toBeUndefined();
    expect(missionSnapshot("7", { phase: "implementing" })).toBeUndefined();
  });

  it("keeps a phase it knows and drops the ones it does not", () => {
    expect(
      missionSnapshot("7", { phase: "verify", entered: ["plan", "verify"] }),
    ).toEqual({ taskId: "7", phase: "verify", entered: ["plan", "verify"] });
    // A value a previous version wrote is dropped rather than guessed at, the way the harness's own
    // reopen drops it: the phase the mission is in is the one that decides.
    expect(
      missionSnapshot("7", {
        phase: "verify",
        entered: ["plan", "renamed", "verify"],
      }),
    ).toEqual({ taskId: "7", phase: "verify", entered: ["plan", "verify"] });
    // A document with no `entered` at all (a version that did not write one) still reports a phase.
    expect(missionSnapshot("7", { phase: "plan" })).toEqual({
      taskId: "7",
      phase: "plan",
      entered: [],
    });
  });
});

describe("the startMission boundary", () => {
  it("decodes what a client sends and what the server answers", () => {
    const input = { sessionId: A_SESSION_ID, feature: "a mission" };
    expect(Schema.decodeSync(StartMissionInput)(input)).toEqual(input);
    // A session id in the shape the contract promises; anything else is refused at the boundary
    // rather than looked up as a session that cannot exist.
    expect(refuses(StartMissionInput, { ...input, sessionId: "lob-230" })).toBe(
      true,
    );
    expect(refuses(StartMissionInput, { feature: "no session" })).toBe(true);

    const result = { sessionId: A_SESSION_ID, taskId: "7" };
    expect(Schema.decodeSync(StartMissionResult)(result)).toEqual(result);
    expect(refuses(StartMissionResult, { sessionId: A_SESSION_ID })).toBe(true);
  });

  it("round-trips through the encoding the RPC protocol uses", () => {
    const result = { sessionId: A_SESSION_ID, taskId: "7" };
    // `encodeSync` then `decodeSync` is what the HTTP protocol does at each end of a call.
    const encoded = Schema.encodeSync(StartMissionResult)(result);
    expect(Schema.decodeSync(StartMissionResult)(encoded)).toEqual(result);
  });
});
