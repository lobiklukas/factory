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
  MAX_REMOVED_DRAFTS,
  decodeProposedIssues,
  projectProposedIssues,
  type ProposalFault,
  type ProposedIssue,
  type ProposedIssues,
  reconcileProposals,
  type RemovedProposal,
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

describe("reconcileProposals (LOB-203)", () => {
  const created = { id: "uuid-1", identifier: "ENG-101" };
  const gone = (
    title: string,
    overrides: Partial<RemovedProposal> = {},
  ): RemovedProposal => ({
    title,
    goal: `the goal of ${title}`,
    change: `the change for ${title}`,
    acceptance: [`${title} is observable`],
    ...overrides,
  });
  const set = (proposals: ProposedIssue[], removed?: RemovedProposal[]) =>
    ({
      proposals,
      ...(removed === undefined ? {} : { removed }),
    }) satisfies ProposedIssues;

  it("adds everything for a session that never decomposed", () => {
    const result = reconcileProposals(
      undefined,
      set([proposal("A"), proposal("B")]),
    );
    expect(result.diff).toEqual({
      added: ["A", "B"],
      updated: [],
      unchanged: [],
      removed: [],
    });
    expect(result.proposals).toEqual([proposal("A"), proposal("B")]);
    expect(result.removed).toEqual([]);
  });

  it("keeps the recorded issues and changes nothing when the same set comes again", () => {
    const previous = set([
      proposal("A", { created }),
      proposal("B", { blockedBy: [0] }),
    ]);
    const result = reconcileProposals(
      previous,
      set([proposal("A"), proposal("B", { blockedBy: [0] })]),
    );
    expect(result.diff).toEqual({
      added: [],
      updated: [],
      unchanged: ["A", "B"],
      removed: [],
    });
    expect(result.proposals).toEqual(previous.proposals);
    expect(result.proposals[0]?.created).toEqual(created);
  });

  it("matches by title, not by index or spelling: a reorder is not an update", () => {
    const previous = set([
      proposal("A", { created }),
      proposal("B", { blockedBy: [0] }),
    ]);
    // B first and A second, A spelled differently: the edge still names A, and A is still A.
    const result = reconcileProposals(
      previous,
      set([proposal("B", { blockedBy: [1] }), proposal("a")]),
    );
    expect(result.diff.added).toEqual([]);
    expect(result.diff.removed).toEqual([]);
    // Only A's spelling differs, which is content.
    expect(result.diff.updated).toEqual(["a"]);
    expect(result.diff.unchanged).toEqual(["B"]);
    expect(result.proposals.map((p) => p.title)).toEqual(["B", "a"]);
    expect(result.proposals[1]?.created).toEqual(created);
  });

  it("updates a proposal in place when its content or its blockers' titles change", () => {
    const previous = set([
      proposal("A", { created }),
      proposal("B", { created: { id: "uuid-2", identifier: "ENG-102" } }),
      proposal("C"),
    ]);
    const result = reconcileProposals(
      previous,
      set([
        proposal("A", { goal: "a new goal" }),
        proposal("B", { blockedBy: [0] }),
        proposal("C"),
      ]),
    );
    expect(result.diff).toEqual({
      added: [],
      updated: ["A", "B"],
      unchanged: ["C"],
      removed: [],
    });
    expect(result.proposals[0]?.goal).toBe("a new goal");
    expect(result.proposals[0]?.created).toEqual(created);
    expect(result.proposals[1]?.created?.identifier).toBe("ENG-102");
  });

  it("marks a dropped proposal removed with its recorded issue, rather than deleting it", () => {
    const previous = set([
      proposal("A"),
      proposal("B", { created }),
      proposal("C"),
    ]);
    const result = reconcileProposals(
      previous,
      set([proposal("A"), proposal("D")]),
    );
    expect(result.diff).toEqual({
      added: ["D"],
      updated: [],
      unchanged: ["A"],
      removed: ["B", "C"],
    });
    expect(result.proposals.map((p) => p.title)).toEqual(["A", "D"]);
    expect(result.removed).toEqual([gone("B", { created }), gone("C")]);
  });

  it("brings a removed proposal back with the issue it had", () => {
    const previous = set([proposal("A")], [gone("B", { created }), gone("C")]);
    const result = reconcileProposals(
      previous,
      set([proposal("A"), proposal("B", { blockedBy: [0] })]),
    );
    // Revived is added to the set again; its issue was never lost.
    expect(result.diff.added).toEqual(["B"]);
    expect(result.proposals[1]?.created).toEqual(created);
    expect(result.proposals[1]?.blockedBy).toEqual([0]);
    expect(result.removed).toEqual([gone("C")]);
    expect(result.diff.removed).toEqual([]);
  });

  it("forgets only removed drafts nothing was created for, oldest first, past the cap", () => {
    const old = Array.from({ length: MAX_REMOVED_DRAFTS }, (_, i) =>
      gone(`old ${i}`),
    );
    const previous = set(
      [proposal("A"), proposal("B")],
      [gone("kept", { created }), ...old],
    );
    const result = reconcileProposals(previous, set([proposal("A")]));
    // "B" joins the end; one draft (the oldest) ages out; the created one is never forgotten.
    expect(result.removed).toHaveLength(MAX_REMOVED_DRAFTS + 1);
    expect(result.removed[0]).toEqual(gone("kept", { created }));
    expect(result.removed.some((p) => p.title === "old 0")).toBe(false);
    expect(result.removed.at(-1)?.title).toBe("B");
  });
});

describe("a stored set's removed proposals (LOB-203)", () => {
  const created = { id: "uuid-1", identifier: "ENG-101" };
  const removed = [
    {
      title: "Gone",
      goal: "g",
      change: "c",
      acceptance: ["a"],
      created,
    },
  ];

  it("read back from a stored document, and absent when there are none", () => {
    const proposals = [proposal("A")];
    expect(projectProposedIssues({ proposals, removed })).toEqual({
      proposals,
      removed,
    });
    expect(projectProposedIssues({ proposals, removed: [] })).toEqual({
      proposals,
    });
  });

  it("is not something a model's answer may carry: a draft drops it, and is not refused for it", () => {
    expect(accepted({ proposals: [proposal("A")], removed })).toEqual([
      proposal("A"),
    ]);
    expect(
      Effect.runSync(
        decodeProposedIssues({ proposals: [proposal("A")], removed: 5 }),
      ),
    ).toEqual({ proposals: [proposal("A")] });
  });

  it("makes a stored set unreadable when a removed entry is not a proposal", () => {
    expect(
      projectProposedIssues({
        proposals: [proposal("A")],
        removed: [{ title: "x" }],
      }),
    ).toBeUndefined();
  });
});
