/**
 * The proposed-issues contract (`Decomposition.ts`, LOB-201).
 *
 * The claim this file exists for is the issue's second criterion — a proposal with an empty
 * acceptance list, or a duplicate title, is refused rather than stored — and its fourth: removing
 * the validation must fail a test. Every rule therefore has a case that is accepted with the rule
 * met and refused with it broken, and each refusal is asserted by the fault it names, so a validator
 * that refused for the wrong reason (or for every reason) does not pass.
 *
 * Pure schema work: no database, no model.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";
import {
  MAX_PROPOSALS,
  decodeProposedIssues,
  projectProposedIssues,
  type ProposalFault,
  type ProposedIssue,
} from "./Decomposition";

const proposal = (
  title: string,
  overrides: Partial<ProposedIssue> = {},
): ProposedIssue => ({
  title,
  goal: `the goal of ${title}`,
  change: `the change for ${title}`,
  acceptance: [`${title} is observable`],
  blockedBy: [],
  ...overrides,
});

/** The faults `input` was refused with, or a test failure if it was accepted. */
const faultsOf = (input: unknown): readonly ProposalFault[] => {
  const exit = Effect.runSyncExit(decodeProposedIssues(input));
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected a refusal, got ${JSON.stringify(exit.value)}`);
  }
  const error = Option.getOrThrow(Exit.findErrorOption(exit));
  expect(error._tag).toBe("ProposalsRefused");
  expect(error.message).toContain("proposals refused");
  return error.faults;
};

const reasons = (input: unknown) =>
  faultsOf(input).map((fault) => [fault.index, fault.reason]);

const accepted = (input: unknown) =>
  Effect.runSync(decodeProposedIssues(input)).proposals;

describe("decodeProposedIssues", () => {
  it("accepts a set whose every proposal has a title, acceptance lines, and real edges", () => {
    const proposals = [
      proposal("Schema"),
      proposal("Run", { blockedBy: [0] }),
      proposal("Proof", { blockedBy: [0, 1] }),
    ];
    expect(accepted({ proposals })).toEqual(proposals);
  });

  it("refuses a proposal with an empty acceptance list, by index", () => {
    expect(
      reasons({
        proposals: [proposal("A"), proposal("B", { acceptance: [] })],
      }),
    ).toEqual([[1, "no_acceptance"]]);
  });

  it("refuses an acceptance line that says nothing", () => {
    expect(
      reasons({
        proposals: [proposal("A", { acceptance: ["fine", "   "] })],
      }),
    ).toEqual([[0, "empty_acceptance_line"]]);
  });

  it("refuses a duplicate title, naming the later proposal and the earlier one", () => {
    const faults = faultsOf({
      proposals: [proposal("Add the schema"), proposal("  add  the SCHEMA ")],
    });
    expect(faults.map((fault) => [fault.index, fault.reason])).toEqual([
      [1, "duplicate_title"],
    ]);
    expect(faults[0]?.detail).toContain("proposal 0");
  });

  it("refuses an empty or blank title", () => {
    expect(reasons({ proposals: [proposal("  ")] })).toEqual([
      [0, "empty_title"],
    ]);
  });

  it("refuses a set with no proposals, and one with more than the cap", () => {
    expect(reasons({ proposals: [] })).toEqual([[null, "none"]]);
    const many = Array.from({ length: MAX_PROPOSALS + 1 }, (_, index) =>
      proposal(`P${index}`),
    );
    expect(reasons({ proposals: many })).toEqual([[null, "too_many"]]);
    expect(accepted({ proposals: many.slice(0, MAX_PROPOSALS) })).toHaveLength(
      MAX_PROPOSALS,
    );
  });

  it("refuses an edge to no proposal, an edge to itself, and a cycle", () => {
    expect(
      reasons({
        proposals: [proposal("A", { blockedBy: [3] }), proposal("B")],
      }),
    ).toEqual([[0, "unknown_blocker"]]);
    expect(reasons({ proposals: [proposal("A", { blockedBy: [0] })] })).toEqual(
      [[0, "self_blocker"]],
    );
    expect(
      reasons({
        proposals: [
          proposal("A"),
          proposal("B", { blockedBy: [2] }),
          proposal("C", { blockedBy: [1] }),
        ],
      }),
    ).toEqual([[null, "cycle"]]);
  });

  it("names every fault at once, not only the first", () => {
    expect(
      reasons({
        proposals: [
          proposal("A", { acceptance: [] }),
          proposal("A"),
          proposal("", { blockedBy: [9] }),
        ],
      }),
    ).toEqual([
      [0, "no_acceptance"],
      [1, "duplicate_title"],
      [2, "empty_title"],
      [2, "unknown_blocker"],
    ]);
  });

  it("refuses what is not the shape, as unreadable rather than as a crash", () => {
    expect(reasons("not json")).toEqual([[null, "unreadable"]]);
    expect(reasons({ proposals: [{ title: "A" }] })).toEqual([
      [null, "unreadable"],
    ]);
    expect(
      reasons({ proposals: [proposal("A", { blockedBy: [0.5] })] }),
    ).toEqual([[null, "unreadable"]]);
  });

  it("stores trimmed text, deduplicated edges, and `blockedBy: []` when a writer left it out", () => {
    const { blockedBy: _omitted, ...withoutEdges } = proposal("A");
    expect(
      accepted({
        proposals: [
          { ...withoutEdges, title: "  A  ", acceptance: [" a line "] },
          proposal("B", { blockedBy: [0, 0] }),
        ],
      }),
    ).toEqual([
      { ...proposal("A"), acceptance: ["a line"] },
      proposal("B", { blockedBy: [0] }),
    ]);
  });
});

describe("projectProposedIssues", () => {
  it("reads a stored set back, and the seed or a refused value as none", () => {
    const proposals = [proposal("A")];
    expect(projectProposedIssues({ proposals })).toEqual({ proposals });
    // The document's seed: a session that never decomposed reports no proposals, not an empty set.
    expect(projectProposedIssues({ proposals: [] })).toBeUndefined();
    expect(projectProposedIssues(undefined)).toBeUndefined();
    // A value only a writer that bypassed the validator could have left does not read back.
    expect(
      projectProposedIssues({
        proposals: [proposal("A"), proposal("A")],
      }),
    ).toBeUndefined();
  });
});

describe("a proposal's created issue (LOB-202)", () => {
  const created = { id: "uuid-1", identifier: "ENG-101" };

  it("reads back from a stored document, beside the proposals that have none", () => {
    const proposals = [proposal("A", { created }), proposal("B")];
    expect(projectProposedIssues({ proposals })).toEqual({ proposals });
  });

  it("is not something a model's answer may claim: a draft drops it", () => {
    // A decomposition's answer is a fresh draft; if it could say `created`, a model could mark a
    // proposal as already in the tracker and `approveProposals` would never create it.
    expect(accepted({ proposals: [proposal("A", { created })] })).toEqual([
      proposal("A"),
    ]);
  });

  it("makes a stored set unreadable when it is not an id and an identifier", () => {
    expect(
      projectProposedIssues({
        proposals: [{ ...proposal("A"), created: { id: 7 } }],
      }),
    ).toBeUndefined();
  });
});
