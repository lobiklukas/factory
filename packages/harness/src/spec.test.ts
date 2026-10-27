/**
 * The spec validator on its own (LOB-72): which values are specs, and what a refusal names. The
 * commit, the reopen and the fold are `session.test.ts`'s, over Postgres; these cases need no log.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeSpec, projectSpec, SpecRefused } from "./spec";

const SPEC = {
  goal: "the board shows every card in its lane",
  acceptance: ["a blocked card stays in its own lane"],
  gaps: [],
  openQuestions: [],
};

const refused = (input: unknown) =>
  Effect.runSync(Effect.flip(decodeSpec(input)));

describe("decodeSpec", () => {
  it("accepts a spec whose gaps are declared as []", () => {
    expect(Effect.runSync(decodeSpec(SPEC))).toEqual(SPEC);
  });

  it("accepts declared gaps and the questions that would close them", () => {
    const thin = {
      goal: "add the board view",
      acceptance: [],
      gaps: ["the card names no acceptance criteria"],
      openQuestions: ["what must the board show to be done?"],
    };
    expect(Effect.runSync(decodeSpec(thin))).toEqual(thin);
  });

  it("refuses a spec with no gaps field as missing, and says how to declare none", () => {
    const { gaps: _gaps, ...input } = SPEC;
    const error = refused(input);
    expect(error).toBeInstanceOf(SpecRefused);
    expect(error).toMatchObject({ field: "gaps", reason: "missing" });
    expect(error.message).toContain("`[]` when there are none");
  });

  it("tells an absent gaps field from one that is present and wrong", () => {
    // `undefined` is a present key with no list in it: the same field, refused as invalid.
    expect(refused({ ...SPEC, gaps: undefined })).toMatchObject({
      field: "gaps",
      reason: "invalid",
    });
    expect(refused({ ...SPEC, gaps: "none" })).toMatchObject({
      field: "gaps",
      reason: "invalid",
    });
  });

  it("names the item, not just the list, when a declared gap says nothing", () => {
    expect(refused({ ...SPEC, gaps: ["a real gap", ""] })).toMatchObject({
      field: "gaps.1",
      reason: "invalid",
    });
  });

  it("names every other field it requires", () => {
    const { goal: _goal, ...noGoal } = SPEC;
    expect(refused(noGoal)).toMatchObject({ field: "goal", reason: "missing" });
    expect(refused({ ...SPEC, goal: "" })).toMatchObject({
      field: "goal",
      reason: "invalid",
    });
    const { acceptance: _acceptance, ...noAcceptance } = SPEC;
    expect(refused(noAcceptance)).toMatchObject({
      field: "acceptance",
      reason: "missing",
    });
    // A model that spells the field its own way has not declared it.
    const { openQuestions: _openQuestions, ...snake } = SPEC;
    expect(refused({ ...snake, open_questions: [] })).toMatchObject({
      field: "openQuestions",
      reason: "missing",
    });
  });

  it("names a missing gaps field even when other fields are wrong too, and lists every fault", () => {
    // Under first-error decoding both of these were refused for `goal` and never mentioned `gaps`.
    const noGoalNoGaps = refused({ acceptance: [], openQuestions: [] });
    expect(noGoalNoGaps).toMatchObject({ field: "gaps", reason: "missing" });
    expect(noGoalNoGaps.fields).toEqual(["goal", "gaps"]);
    expect(noGoalNoGaps.message).toContain("`[]` when there are none");
    expect(noGoalNoGaps.message).toContain("`goal`");

    const emptyGoalNoGaps = refused({
      goal: "",
      acceptance: [],
      openQuestions: [],
    });
    expect(emptyGoalNoGaps).toMatchObject({ field: "gaps", reason: "missing" });
    expect(emptyGoalNoGaps.fields).toEqual(["goal", "gaps"]);
  });

  it("leads with the first fault in field order when gaps is not missing", () => {
    const error = refused({
      goal: "",
      acceptance: [""],
      gaps: [],
      openQuestions: [],
    });
    expect(error).toMatchObject({ field: "goal", reason: "invalid" });
    expect(error.fields).toEqual(["goal", "acceptance.0"]);
    expect(error.message).toContain("`acceptance.0`");
  });

  it("lists only the one field when only one is wrong", () => {
    const { gaps: _gaps, ...input } = SPEC;
    expect(refused(input).fields).toEqual(["gaps"]);
  });

  it("refuses a value that is not an object at all, naming the spec", () => {
    expect(refused(null)).toMatchObject({ field: "spec", reason: "invalid" });
    expect(refused([SPEC])).toMatchObject({ field: "spec", reason: "invalid" });
  });
});

describe("projectSpec", () => {
  it("reads the document's seed as no spec", () => {
    expect(
      projectSpec({ goal: "", acceptance: [], gaps: [], openQuestions: [] }),
    ).toBeUndefined();
  });

  it("reads a stored value the validator would refuse as no spec", () => {
    const { gaps: _gaps, ...noGaps } = SPEC;
    expect(projectSpec(noGaps)).toBeUndefined();
    expect(projectSpec(undefined)).toBeUndefined();
    expect(projectSpec(SPEC)).toEqual(SPEC);
  });
});
