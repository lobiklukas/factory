/**
 * The plan-freshness contract (`PlanFreshness.ts`, LOB-45).
 *
 * The claim this file exists for is the issue's fourth criterion: each proposal is one of `add`,
 * `rescope` or `close` and goes through the validator, and a `rescope`/`close` naming an issue
 * outside the input set, or two proposals about one issue, is refused with every fault named. Every
 * rule has a case accepted with the rule met and refused with it broken, asserted by the fault it
 * names, so a validator that refused for the wrong reason — or for every reason — does not pass.
 *
 * Pure schema work: no database, no model.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  acceptanceOfDescription,
  MAX_PLAN_PROPOSALS,
  type PlanFault,
  type PlanIssue,
  projectPlanRevisions,
  type PlanRevision,
  validatePlanProposals,
} from "./PlanFreshness";
import { SessionId } from "./Ids";

const issue = (
  identifier: string,
  title: string,
  overrides: Partial<PlanIssue> = {},
): PlanIssue => ({
  id: `uuid-${identifier}`,
  identifier,
  title,
  state: "Todo",
  closed: false,
  acceptance: [`${title} works`],
  ...overrides,
});

const ISSUES: readonly PlanIssue[] = [
  issue("ENG-1", "The schema"),
  issue("ENG-2", "The service"),
  issue("ENG-3", "The old dashboard", { state: "Done", closed: true }),
];

const add = (title: string) => ({
  kind: "add",
  title,
  goal: `the goal of ${title}`,
  change: `the change for ${title}`,
  acceptance: [`${title} is observable`],
});
const rescope = (identifier: string) => ({
  kind: "rescope",
  issue: identifier,
  title: `${identifier}, narrower`,
  goal: "a narrower goal",
  change: "a smaller change",
  acceptance: ["the narrower thing is observable"],
});
const close = (
  identifier: string,
  reason = "the spec no longer asks for it",
) => ({
  kind: "close",
  issue: identifier,
  reason,
});

/** The faults `proposals` were refused with, or a test failure if they were accepted. */
const faultsOf = (
  proposals: unknown,
  issues: readonly PlanIssue[] = ISSUES,
): readonly PlanFault[] => {
  const result = validatePlanProposals(
    typeof proposals === "string" ? proposals : { proposals },
    issues,
  );
  if (Result.isSuccess(result)) {
    throw new Error(
      `expected a refusal, got ${JSON.stringify(result.success)}`,
    );
  }
  return result.failure;
};

const accepted = (proposals: unknown, issues = ISSUES) => {
  const result = validatePlanProposals({ proposals }, issues);
  if (Result.isFailure(result)) {
    throw new Error(
      `expected acceptance, got ${JSON.stringify(result.failure)}`,
    );
  }
  return result.success;
};

describe("validatePlanProposals", () => {
  it("accepts one of each kind, about issues of the input set, and normalizes the references", () => {
    const proposals = accepted([
      add("  The RPC  "),
      rescope("eng-1"),
      close("uuid-ENG-2"),
    ]);
    expect(proposals.map((proposal) => proposal.kind)).toEqual([
      "add",
      "rescope",
      "close",
    ]);
    expect(proposals[0]).toMatchObject({ title: "The RPC" });
    // The reference is resolved to the identifier the input set uses, by identifier or by id.
    expect(proposals[1]).toMatchObject({ issue: "ENG-1" });
    expect(proposals[2]).toMatchObject({ issue: "ENG-2" });
  });

  it("accepts no proposals at all: the plan is still fresh", () => {
    expect(accepted([])).toEqual([]);
  });

  it("drops an `applied` a draft claims: only an approval says a tracker write happened", () => {
    const [proposal] = accepted([
      { ...add("The RPC"), applied: { id: "x", identifier: "ENG-9" } },
    ]);
    expect(proposal).not.toHaveProperty("applied");
  });

  it("refuses a rescope and a close naming issues outside the input set, naming both", () => {
    const faults = faultsOf([rescope("ENG-77"), close("OPS-1")]);
    expect(faults.map((fault) => [fault.index, fault.reason])).toEqual([
      [0, "unknown_issue"],
      [1, "unknown_issue"],
    ]);
    expect(faults[0]?.detail).toContain("ENG-77");
    expect(faults[1]?.detail).toContain("OPS-1");
  });

  it("refuses two proposals about one issue, however it is named", () => {
    const faults = faultsOf([rescope("ENG-1"), close("uuid-ENG-1")]);
    expect(faults.map((fault) => [fault.index, fault.reason])).toEqual([
      [1, "duplicate_issue"],
    ]);
    expect(faults[0]?.detail).toContain("proposal 0");
  });

  it("names every fault of one answer at once, not the first", () => {
    const faults = faultsOf([
      rescope("ENG-77"),
      rescope("ENG-1"),
      close("ENG-1", ""),
      add(""),
      { ...add("The schema") },
      { ...add("The RPC"), acceptance: [] },
      { ...add("The rpc"), acceptance: ["fine", "  "] },
      close("ENG-3"),
    ]);
    expect(faults.map((fault) => [fault.index, fault.reason])).toEqual([
      [0, "unknown_issue"],
      [2, "duplicate_issue"],
      [2, "no_reason"],
      [3, "empty_title"],
      [4, "title_exists"],
      [5, "no_acceptance"],
      [6, "empty_acceptance_line"],
      [6, "duplicate_title"],
      [7, "closed_issue"],
    ]);
  });

  it("refuses an add or a rescope with no acceptance line, and accepts it with one", () => {
    expect(
      faultsOf([{ ...rescope("ENG-1"), acceptance: [] }]).map((f) => f.reason),
    ).toEqual(["no_acceptance"]);
    expect(accepted([rescope("ENG-1")])).toHaveLength(1);
  });

  it("refuses an add whose title is a tracker issue's, compared as titles are", () => {
    expect(faultsOf([add("  the   SERVICE ")]).map((f) => f.reason)).toEqual([
      "title_exists",
    ]);
  });

  it("refuses more than MAX_PLAN_PROPOSALS, and accepts exactly that many", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => add(`Piece ${index}`));
    expect(accepted(many(MAX_PLAN_PROPOSALS))).toHaveLength(MAX_PLAN_PROPOSALS);
    expect(faultsOf(many(MAX_PLAN_PROPOSALS + 1)).map((f) => f.reason)).toEqual(
      ["too_many"],
    );
  });

  it("refuses an unknown kind, a missing field and text that is not an answer as unreadable", () => {
    for (const input of [
      [{ kind: "split", issue: "ENG-1" }],
      [{ kind: "close", issue: "ENG-1" }],
      "not json at all",
    ]) {
      expect(faultsOf(input).map((f) => [f.index, f.reason])).toEqual([
        [null, "unreadable"],
      ]);
    }
  });
});

describe("projectPlanRevisions", () => {
  const revision: PlanRevision = {
    key: "merged:https://github.com/o/r/pull/1",
    at: "2026-10-28T00:00:00.000Z",
    trigger: { pr: "https://github.com/o/r/pull/1", number: 1 },
    spec: {
      sessionId: SessionId.make("ses_0123456789abcdefghjkmnpqrs"),
      goal: "the goal",
      digest: "abc",
    },
    issues: ISSUES,
    proposals: [],
    decision: "pending",
  };

  it("reads the revisions a document holds, and none from its seed", () => {
    expect(projectPlanRevisions({ revisions: [revision] })).toEqual([revision]);
    expect(projectPlanRevisions({ revisions: [] })).toBeUndefined();
    expect(projectPlanRevisions(undefined)).toBeUndefined();
  });

  it("leaves out an entry that does not decode rather than failing the read", () => {
    expect(projectPlanRevisions({ revisions: [{ key: 1 }, revision] })).toEqual(
      [revision],
    );
  });
});

describe("acceptanceOfDescription", () => {
  it("reads a description's checklist, checked or not, and nothing else", () => {
    expect(
      acceptanceOfDescription(
        "goal\n\n**Acceptance**\n\n- [ ] one\n- [x] two\n- plain bullet\n- [ ]   \n",
      ),
    ).toEqual(["one", "two"]);
  });
});
