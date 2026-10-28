/**
 * The exit-requirement rules as pure functions of the evidence (LOB-80; docs/board.md B5, B8).
 *
 * The records here are the shapes the `verify` tool writes (`@repo/harness`'s `VerifyRecord`), built
 * by hand so each rule is pinned by one case; `TaskService.test.ts` drives the same rules through a
 * real run's log in Postgres.
 */
import { describe, expect, it } from "vitest";
import type { BoardColumn } from "@repo/domain/Task";
import type {
  RecordedReview,
  RunTurn,
  VerifyRecord,
  VerifyResult,
} from "@repo/harness";
import {
  type BranchDiff,
  CHECKED_REQUIREMENTS,
  exitRequirements,
  exitView,
  humanMergeVerdict,
  nonEmptyDiffVerdict,
  prLinkVerdict,
  requirementVerdict,
  type ReviewRunEvidence,
  reviewVerdictVerdict,
  runCompletedVerdict,
  specDocVerdict,
  VERIFIABLE_REMEDY,
  verifiedVerdict,
  type RunEvidence,
} from "./requirements";

const review: BoardColumn = {
  name: "review",
  kind: "working",
  role: "reviewer",
  skills: ["review"],
  requires: [
    { key: "verified", description: "a passing verification" },
    { key: "review_verdict", description: "a review verdict" },
    { key: "human_merge", description: "a human merge" },
  ],
};

/** The default pipeline's `building`, as 0007 seeds it. */
const building: BoardColumn = {
  name: "building",
  kind: "working",
  role: "builder",
  skills: [],
  requires: [
    { key: "run_completed", description: "a run that completed" },
    { key: "non_empty_diff", description: "a non-empty diff" },
    { key: "pr_link", description: "a PR link" },
  ],
};

const ran = (
  surface: string,
  exitCode: number,
  source: "skill" | "workspace" = "skill",
): VerifyResult => ({
  _tag: "VerifyRan",
  surface,
  source,
  directory: source === "skill" ? `.pi/skills/verify-${surface}` : ".",
  command: source === "skill" ? "bash drive.sh" : "bun run test",
  exitCode,
  output: "",
  truncated: false,
});

const report = (changed: string[], results: VerifyResult[]): VerifyRecord => ({
  _tag: "VerifyReport",
  changed,
  changedCount: changed.length,
  results,
});

/** The harness clock the hand-built calls are written at: each call one tick after the last. */
let clock = 0;

/** A run whose calls were written in the order given, each after every call built before it. */
const run = (
  sessionId: string,
  ...records: (VerifyRecord | undefined)[]
): RunEvidence => ({
  sessionId,
  calls: records.map((record) => ({ record, at: (clock += 1) })),
});

/** A run whose calls were written at the given times. */
const timed = (
  sessionId: string,
  ...calls: [at: number, record: VerifyRecord | undefined][]
): RunEvidence => ({
  sessionId,
  calls: calls.map(([at, record]) => ({ record, at })),
});

const reason = (runs: RunEvidence[]): string => {
  const verdict = verifiedVerdict(runs);
  if (verdict.met) throw new Error("expected the requirement to be unmet");
  return verdict.reason;
};

describe("exitRequirements", () => {
  it("checks only the keys it has a checker for, in declaration order", () => {
    expect([...CHECKED_REQUIREMENTS]).toEqual([
      "verified",
      "non_empty_diff",
      "pr_link",
      "review_verdict",
      "spec_doc",
      "run_completed",
      "human_merge",
    ]);
    // `human_merge` is checked against the card's PR's merge since C20, on a move into done only.
    expect(exitRequirements(review, "done").map((r) => r.key)).toEqual([
      "verified",
      "review_verdict",
      "human_merge",
    ]);
    // Sending a card back from review is no merge, so the move is not held to one.
    expect(exitRequirements(review, "building").map((r) => r.key)).toEqual([
      "verified",
      "review_verdict",
    ]);
    // All three of building's keys are checked since D9, in the order it declares them, which is the
    // order a refusal names the first unmet one.
    expect(exitRequirements(building, "review").map((r) => r.key)).toEqual([
      "run_completed",
      "non_empty_diff",
      "pr_link",
    ]);
    expect(exitRequirements(building, "canceled")).toEqual([]);
  });

  it("checks nothing on the way into canceled, or for a column the definition does not name", () => {
    expect(exitRequirements(review, "canceled")).toEqual([]);
    expect(exitRequirements(undefined, "done")).toEqual([]);
  });

  it("names a key without a checker as unchecked rather than met", () => {
    expect(
      requirementVerdict(
        { key: "plan_doc", description: "a plan doc" },
        { runs: [] },
      ),
    ).toEqual({ met: false, reason: '"plan_doc" has no checker' });
  });
});

/** One run whose newest turn ended as `turn` says (`runTurnOf`); none when `turn` is absent. */
const turned = (sessionId: string, turn?: RunTurn): RunEvidence => ({
  sessionId,
  calls: [],
  ...(turn === undefined ? {} : { turn }),
});

const unmet = (verdict: ReturnType<typeof specDocVerdict>): string => {
  if (verdict.met) throw new Error("expected the requirement to be unmet");
  return verdict.reason;
};

describe("the spec_doc requirement (D9)", () => {
  /** Mutation: treat a card with no `specified` event as met — the first case passes it. */
  it("is unmet for a card no run specified, and met once one did, whatever its gaps", () => {
    expect(unmet(specDocVerdict({ runs: [] }))).toContain(
      "the card has no spec",
    );
    expect(
      specDocVerdict({
        runs: [],
        specified: true,
      }),
    ).toEqual({ met: true });
  });

  it("is dispatched by key, so a card without a spec is refused on `spec_doc`", () => {
    expect(
      requirementVerdict(
        { key: "spec_doc", description: "a spec doc" },
        { runs: [turned("ses_a", "completed")] },
      ),
    ).toMatchObject({ met: false });
  });
});

describe("the run_completed requirement (D9)", () => {
  it("is unmet for a card with no runs", () => {
    expect(unmet(runCompletedVerdict({ runs: [] }))).toBe(
      "the card has no runs, so none completed a turn",
    );
  });

  /** Mutation: treat every settled turn as completed — a failed, stopped or unanswered run passes. */
  it.each([
    ["unfinished", "has not completed its turn"],
    ["truncated", "cut off at the output limit"],
    ["interrupted", "was interrupted"],
    ["budget", "was stopped by its budget"],
    ["failed", "faulted"],
  ] as const)("is unmet for a latest run whose turn is %s", (turn, words) => {
    const reason = unmet(
      runCompletedVerdict({ runs: [turned("ses_a", turn)] }),
    );
    expect(reason).toContain("ses_a");
    expect(reason).toContain(words);
  });

  /** Mutation: judge the newest run whatever column started it — a planner's completed run meets building's gate. */
  it("judges the newest run started in the column being left, not an earlier column's", () => {
    const runs = [
      { ...turned("ses_build", "failed"), column: "building" },
      { ...turned("ses_plan", "completed"), column: "planning" },
    ];
    expect(unmet(runCompletedVerdict({ column: "building", runs }))).toContain(
      "ses_build",
    );
    expect(
      unmet(
        runCompletedVerdict({
          column: "building",
          runs: [{ ...turned("ses_plan", "completed"), column: "planning" }],
        }),
      ),
    ).toContain("no run of the card was started in building");
    expect(
      runCompletedVerdict({
        column: "planning",
        runs,
      }),
    ).toEqual({ met: true });
  });

  it("is met for a latest run that completed", () => {
    expect(
      runCompletedVerdict({ runs: [turned("ses_a", "completed")] }),
    ).toEqual({ met: true });
  });

  /** Mutation: judge the first run, or any run — an earlier completed run carries a later fault. */
  it("judges the latest run only", () => {
    expect(
      runCompletedVerdict({
        runs: [turned("ses_old", "completed"), turned("ses_new", "failed")],
      }).met,
    ).toBe(false);
    expect(
      runCompletedVerdict({
        runs: [turned("ses_old", "failed"), turned("ses_new", "completed")],
      }),
    ).toEqual({ met: true });
  });

  it("is unmet, not met, when the evidence carries no turn at all", () => {
    expect(unmet(runCompletedVerdict({ runs: [turned("ses_a")] }))).toContain(
      "turn was not read",
    );
  });
});

describe("the human_merge requirement (C20)", () => {
  const PR = "https://github.com/o/r/pull/7";
  const OTHER = "https://github.com/o/r/pull/9";
  const unmet = (verdict: { met: boolean; reason?: string }): string => {
    if (verdict.met) throw new Error("expected the requirement to be unmet");
    return verdict.reason ?? "";
  };

  /**
   * Mutation: unmet with no PR on record — a box with no forge, or a card whose work needed no PR,
   * could never be completed, only canceled.
   */
  it("is met for a card with no PR on record: there is no merge to wait on", () => {
    expect(humanMergeVerdict({ runs: [run("ses_a"), run("ses_b")] })).toEqual({
      met: true,
    });
    expect(humanMergeVerdict({ runs: [] })).toEqual({ met: true });
  });

  /** Mutation: compare the URLs as strings — a legacy run's API-resource PR would never match its merge. */
  it("matches the merge of the card's PR by page or by API resource", () => {
    expect(
      humanMergeVerdict({
        runs: [
          {
            ...run("ses_a"),
            prUrl: "https://api.github.com/repos/o/r/pulls/7",
            mergedPr: PR,
          },
        ],
      }),
    ).toEqual({ met: true });
    expect(
      unmet(
        humanMergeVerdict({
          runs: [
            {
              ...run("ses_a"),
              prUrl: "https://api.github.com/repos/o/r/pulls/8",
              mergedPr: PR,
            },
          ],
        }),
      ),
    ).toContain("pulls/8");
  });

  /** Mutation: met on a recorded PR alone — an open PR would pass. */
  it("is unmet while the card's PR has no merge on record, naming the PR", () => {
    const reason = unmet(
      humanMergeVerdict({ runs: [{ ...run("ses_a"), prUrl: PR }] }),
    );
    expect(reason).toContain(`no merge of the card's PR ${PR} is on record`);
    expect(reason).toContain("closed without being merged");
  });

  it("is met once a run of the card recorded the merge of the card's PR", () => {
    expect(
      humanMergeVerdict({
        runs: [
          { ...run("ses_a"), prUrl: PR },
          { ...run("ses_b"), prUrl: PR, mergedPr: PR },
        ],
      }),
    ).toEqual({ met: true });
    // A card none of whose runs recorded the PR itself is judged on the PR its merge names.
    expect(
      humanMergeVerdict({ runs: [{ ...run("ses_a"), mergedPr: PR }] }),
    ).toEqual({ met: true });
  });

  /** Mutation: any recorded merge counts — a replaced PR's merge would pass the card's new one. */
  it("is not met by the merge of a PR the card's newest PR replaced", () => {
    expect(
      unmet(
        humanMergeVerdict({
          runs: [
            { ...run("ses_a"), prUrl: OTHER, mergedPr: OTHER },
            { ...run("ses_b"), prUrl: PR },
          ],
        }),
      ),
    ).toContain(PR);
  });

  it("is what requirementVerdict judges human_merge with, and exitView lists it as checked", () => {
    expect(
      requirementVerdict(
        { key: "human_merge", description: "a human merge" },
        { runs: [{ ...run("ses_a"), prUrl: PR, mergedPr: PR }] },
      ),
    ).toEqual({ met: true });
    expect(
      exitView(review, { runs: [{ ...run("ses_a"), prUrl: PR }] })[2],
    ).toMatchObject({ key: "human_merge", status: "unmet" });
  });
});

describe("exitView (D9)", () => {
  /** Mutation: mark an unchecked key `met` — `plan_doc` or `human_move` would read as satisfied. */
  it("lists every declared key in order: judged ones met or unmet with a reason, the rest unchecked", () => {
    const planning: BoardColumn = {
      name: "planning",
      kind: "working",
      skills: [],
      requires: [
        { key: "plan_doc", description: "a plan doc" },
        { key: "spec_doc", description: "a spec" },
        { key: "human_move", description: "a person's move" },
      ],
    };
    expect(exitView(planning, { runs: [] })).toEqual([
      { key: "plan_doc", description: "a plan doc", status: "unchecked" },
      {
        key: "spec_doc",
        description: "a spec",
        status: "unmet",
        reason: expect.stringContaining("no spec"),
      },
      {
        key: "human_move",
        description: "a person's move",
        status: "unchecked",
      },
    ]);
    expect(
      exitView(planning, {
        runs: [],
        specified: true,
      })[1],
    ).toEqual({ key: "spec_doc", description: "a spec", status: "met" });
  });
});

describe("the verified requirement", () => {
  it("is unmet for a card with no runs, and for runs that never verified a change", () => {
    expect(reason([])).toBe(
      "the card has no runs, so nothing verified its change",
    );
    expect(
      reason([
        run("ses_a"),
        run("ses_b", report([], []), {
          _tag: "VerifyUnmeasured",
          reason: "no-checkout",
          message: "not a checkout",
        }),
      ]),
    ).toBe(
      "none of the card's 2 run(s) recorded a verify call over a change (2 call(s) recorded)",
    );
  });

  it("is met when the surface the change touched passed its own skill", () => {
    expect(
      verifiedVerdict([
        run("ses_a", report(["apps/api/src/x.ts"], [ran("api", 0)])),
      ]),
    ).toEqual({ met: true });
  });

  it("is unmet when the touched surface failed, naming the surface and the exit code", () => {
    expect(
      reason([run("ses_a", report(["apps/api/src/x.ts"], [ran("api", 3)]))]),
    ).toBe(
      "run ses_a's latest verify call over the change: api: exit 3 (bash drive.sh in .pi/skills/verify-api)",
    );
  });

  it("is not satisfied by a passing verification of a different surface", () => {
    // The change is in `api`; the only passing result is `web`'s. A gate that accepted "some
    // verification passed" would let this through.
    expect(
      reason([run("ses_a", report(["apps/api/src/x.ts"], [ran("web", 0)]))]),
    ).toBe(
      "run ses_a's latest verify call over the change: api: no passing verification of it (the passing ones cover web)",
    );
  });

  it("reads the newest call that measured a change, across runs", () => {
    // An earlier run verified `web`; the newest change is in `api` and has no skill.
    const noApiSkill: VerifyResult = {
      _tag: "VerifyNoEvidence",
      surface: "api",
      reason: "no-verify-skill",
      message: "no verify-api skill",
    };
    expect(
      reason([
        run("ses_a", report(["apps/web/page.tsx"], [ran("web", 0)])),
        run("ses_b", report(["apps/api/src/x.ts"], [noApiSkill])),
      ]),
    ).toBe(
      `run ses_b's latest verify call over the change: api: no verification (no verify-api skill) (${VERIFIABLE_REMEDY})`,
    );
    // And the other way round: a newer passing call supersedes an older failing one.
    expect(
      verifiedVerdict([
        run(
          "ses_a",
          report(["apps/api/src/x.ts"], [ran("api", 1)]),
          report(["apps/api/src/x.ts"], [ran("api", 0)]),
        ),
      ]),
    ).toEqual({ met: true });
  });

  it("is not wiped out by a later call that measured nothing", () => {
    expect(
      verifiedVerdict([
        run("ses_a", report(["apps/api/src/x.ts"], [ran("api", 0)])),
        run("ses_b", report([], []), {
          _tag: "VerifyUnmeasured",
          reason: "git-failed",
          message: "git failed",
        }),
      ]),
    ).toEqual({ met: true });
  });

  it("takes the repo's declared command as covering every surface, and its failure as the repo's", () => {
    const changed = ["apps/api/src/x.ts", "apps/web/page.tsx", "src/app.ts"];
    expect(
      verifiedVerdict([
        run("ses_a", report(changed, [ran(".", 0, "workspace")])),
      ]),
    ).toEqual({ met: true });
    expect(
      reason([run("ses_a", report(changed, [ran(".", 1, "workspace")]))]),
    ).toBe(
      "run ses_a's latest verify call over the change: .: exit 1 (bun run test in .)",
    );
  });

  it("requires a path outside every package to be verified as the repo surface", () => {
    expect(
      reason([
        run(
          "ses_a",
          report(
            ["apps/api/src/x.ts", "docs/notes.md"],
            [
              ran("api", 0),
              {
                _tag: "VerifyNoEvidence",
                surface: ".",
                reason: "no-surface",
                message: "no declared verify command",
              },
            ],
          ),
        ),
      ]),
    ).toBe(
      `run ses_a's latest verify call over the change: .: no verification (no declared verify command) (${VERIFIABLE_REMEDY})`,
    );
  });

  it("orders calls across runs by when they were written, not by which run started last", () => {
    // Run A started first and verified `api`; run B started later and verified `web`. A person then
    // resumed A, which changed `api` again and failed. The newest verification of the card failed.
    const a = timed(
      "ses_a",
      [10, report(["apps/api/src/x.ts"], [ran("api", 0)])],
      [30, report(["apps/api/src/x.ts"], [ran("api", 1)])],
    );
    const b = timed("ses_b", [
      20,
      report(["apps/web/page.tsx"], [ran("web", 0)]),
    ]);
    expect(reason([a, b])).toBe(
      "run ses_a's latest verify call over the change: api: exit 1 (bash drive.sh in .pi/skills/verify-api)",
    );
    // Without the resumed call, B's pass is the newest and the card may leave.
    expect(
      verifiedVerdict([
        timed("ses_a", [10, report(["apps/api/src/x.ts"], [ran("api", 1)])]),
        b,
      ]),
    ).toEqual({ met: true });
  });

  it("is unmet when the newest call left no record, rather than falling back to an older pass", () => {
    // The run verified `api`, changed more code, and its next call was blocked or crashed.
    expect(
      reason([
        run("ses_a", report(["apps/api/src/x.ts"], [ran("api", 0)]), undefined),
      ]),
    ).toBe(
      "run ses_a's latest verify call left no record (it was blocked or crashed), so what it verified is unknown: verify the change again",
    );
    // A recordless call older than a measured one is superseded by it, like any older call.
    expect(
      verifiedVerdict([
        run("ses_a", undefined, report(["apps/api/src/x.ts"], [ran("api", 0)])),
      ]),
    ).toEqual({ met: true });
  });

  it("names the remedy only when a surface had no verification at all", () => {
    expect(
      reason([run("ses_a", report(["apps/api/src/x.ts"], [ran("api", 3)]))]),
    ).not.toContain(VERIFIABLE_REMEDY);
  });

  it("refuses when any result of the call failed, even one the changed list does not name", () => {
    // `changed` is a prefix when a change is large, so a result's own surface is required too.
    expect(
      reason([
        run("ses_a", {
          _tag: "VerifyReport",
          changed: ["apps/api/src/x.ts"],
          changedCount: 900,
          results: [ran("api", 0), ran("web", 2)],
        }),
      ]),
    ).toBe(
      "run ses_a's latest verify call over the change: web: exit 2 (bash drive.sh in .pi/skills/verify-web)",
    );
  });
});

/** A run that recorded a PR, or none. */
const withPr = (sessionId: string, prUrl?: string): RunEvidence => ({
  sessionId,
  calls: [],
  ...(prUrl === undefined ? {} : { prUrl }),
});

const measured = (sessionId: string, files: number): BranchDiff => ({
  _tag: "measured",
  sessionId,
  base: "main",
  head: `factory/${sessionId}`,
  files,
});

describe("the non_empty_diff requirement", () => {
  const key = { key: "non_empty_diff", description: "a non-empty diff" };

  it("is met when the latest run's branch changes at least one file", () => {
    expect(
      nonEmptyDiffVerdict({
        runs: [withPr("ses_a"), withPr("ses_b")],
        diff: measured("ses_b", 1),
      }),
    ).toEqual({ met: true });
    // And through the dispatch the service calls.
    expect(
      requirementVerdict(key, {
        runs: [withPr("ses_b")],
        diff: measured("ses_b", 3),
      }),
    ).toEqual({ met: true });
  });

  it("is unmet for a branch even with its base, naming the range git measured", () => {
    expect(
      nonEmptyDiffVerdict({
        runs: [withPr("ses_b")],
        diff: measured("ses_b", 0),
      }),
    ).toEqual({
      met: false,
      reason:
        "run ses_b's branch factory/ses_b changes no file against main (git diff --numstat main...factory/ses_b is empty): commit the change on the run's branch",
    });
  });

  it("is unmet for a card with no runs, and for a branch nothing could measure", () => {
    expect(nonEmptyDiffVerdict({ runs: [] })).toEqual({
      met: false,
      reason: "the card has no runs, so no branch carries its change",
    });
    expect(
      nonEmptyDiffVerdict({
        runs: [withPr("ses_b")],
        diff: {
          _tag: "unmeasured",
          sessionId: "ses_b",
          reason: "repository o/r has no local checkout registered",
        },
      }),
    ).toEqual({
      met: false,
      reason:
        "run ses_b's branch could not be measured: repository o/r has no local checkout registered",
    });
  });

  it("reads only the latest run: an older run's change does not count, nor a missing measurement", () => {
    // The diff was measured for an older run: the card's change is the latest run's, so refused.
    expect(
      nonEmptyDiffVerdict({
        runs: [withPr("ses_a"), withPr("ses_b")],
        diff: measured("ses_a", 5),
      }),
    ).toEqual({ met: false, reason: "run ses_b's branch was not measured" });
    expect(nonEmptyDiffVerdict({ runs: [withPr("ses_b")] })).toEqual({
      met: false,
      reason: "run ses_b's branch was not measured",
    });
  });
});

describe("the pr_link requirement", () => {
  const key = { key: "pr_link", description: "a PR link" };
  const link = "https://github.com/o/r/pull/7";

  it("is met when the latest run recorded a PR", () => {
    expect(prLinkVerdict({ runs: [withPr("ses_a", link)] })).toEqual({
      met: true,
    });
    expect(
      requirementVerdict(key, {
        runs: [withPr("ses_a"), withPr("ses_b", link)],
      }),
    ).toEqual({ met: true });
  });

  it("is unmet when the latest run recorded none, even if an older run did", () => {
    expect(
      prLinkVerdict({ runs: [withPr("ses_a", link), withPr("ses_b")] }),
    ).toEqual({
      met: false,
      reason:
        "the card's latest run ses_b recorded no PR (no factory.pr document in its log): open its PR (factory pr ses_b) before moving the card on",
    });
  });

  it("is unmet for a card with no runs", () => {
    expect(prLinkVerdict({ runs: [] })).toEqual({
      met: false,
      reason: "the card has no runs, so none opened a PR",
    });
  });

  // C19: a card's later runs continue its first change run's branch, so a follow-up run that opened
  // no PR of its own still leaves the card with the PR an earlier run opened from that branch.
  const published = "a".repeat(40);
  const moved = "b".repeat(40);
  const continued = (prCommit: string | undefined) => [
    {
      sessionId: "ses_a",
      calls: [],
      branch: "factory/ses_a",
      prUrl: link,
      prHead: "factory/ses_a",
      ...(prCommit === undefined ? {} : { prCommit }),
    },
    { sessionId: "ses_b", calls: [], branch: "factory/ses_a" },
  ];

  it("is met when the latest run opened none, but an earlier run's PR is from the branch it continues, at its tip (C19)", () => {
    expect(
      prLinkVerdict({ runs: continued(published), branchTip: published }),
    ).toEqual({ met: true });
  });

  // C19 review: a follow-up run that committed and never pushed (its cap refused, its push failed,
  // it was stopped, or it is still going) moved the branch past the PR, which lacks its commits.
  it("is unmet when the branch moved past where the earlier run published the card's PR (C19)", () => {
    expect(
      prLinkVerdict({ runs: continued(published), branchTip: moved }),
    ).toEqual({
      met: false,
      reason: `the card's latest run ses_b recorded no PR, and its branch factory/ses_a is at ${moved.slice(0, 12)}, past ${published.slice(0, 12)} where run ses_a published the card's PR ${link}: push the run's commits to the PR (factory pr ses_b) before moving the card on`,
    });
  });

  it("is unmet when the earlier run's PR names no published commit, or the tip does not read (C19)", () => {
    expect(
      prLinkVerdict({ runs: continued(undefined), branchTip: published }),
    ).toMatchObject({ met: false });
    expect(prLinkVerdict({ runs: continued(published) })).toMatchObject({
      met: false,
    });
  });

  it("is unmet when the earlier run's PR is from another branch than the latest run's (C19)", () => {
    expect(
      prLinkVerdict({
        runs: [
          {
            sessionId: "ses_a",
            calls: [],
            branch: "factory/ses_a",
            prUrl: link,
            prHead: "factory/ses_a",
          },
          { sessionId: "ses_b", calls: [], branch: "factory/ses_b" },
        ],
      }),
    ).toEqual({
      met: false,
      reason:
        "the card's latest run ses_b recorded no PR (no factory.pr document in its log), and no run of the card recorded one from its branch factory/ses_b: open its PR (factory pr ses_b) before moving the card on",
    });
  });
});

describe("the review_verdict requirement (LOB-241)", () => {
  const HEAD_A = "a".repeat(40);
  const HEAD_B = "b".repeat(40);
  const target = (head: string): RecordedReview["target"] => ({
    repo: "acme/widgets",
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    base: "main",
    head,
  });
  /** A review run at `head`: still reviewing, or settled on `verdict` with `outcome`. */
  const reviewed = (
    sessionId: string,
    head: string,
    settled?: Pick<
      RecordedReview,
      "verdict" | "outcome" | "outcomeDetail" | "failing"
    >,
  ): ReviewRunEvidence => ({
    sessionId,
    review: { target: target(head), ...settled },
  });
  const pass = (outcome = "clean") => ({
    verdict: "pass" as const,
    outcome,
    outcomeDetail: "",
    failing: [],
  });
  const unmet = (reviews: ReviewRunEvidence[] | undefined): string => {
    const verdict = reviewVerdictVerdict(
      reviews === undefined ? { runs: [] } : { runs: [], reviews },
    );
    if (verdict.met) throw new Error("expected the requirement to be unmet");
    return verdict.reason;
  };

  it("is unmet when no review ran, whether the evidence names none or holds none", () => {
    for (const reviews of [undefined, []]) {
      expect(unmet(reviews)).toMatch(/^no review ran: /);
    }
    // A change run's evidence is not a review: a card whose runs verified and opened a PR has still
    // had no review.
    expect(
      reviewVerdictVerdict({
        runs: [
          {
            sessionId: "ses_build",
            calls: [],
            prUrl: "https://github.com/acme/widgets/pull/7",
          },
        ],
      }).met,
    ).toBe(false);
  });

  it("is unmet while the newest review run has recorded no verdict, naming the head it reviews", () => {
    expect(unmet([reviewed("ses_r1", HEAD_A)])).toBe(
      `run ses_r1 is still reviewing acme/widgets#7 at ${HEAD_A}: it has recorded no verdict yet (wait for it to settle, or prompt it again if it ended without one)`,
    );
  });

  it("is unmet on a fail, naming every failing dimension and where its findings are", () => {
    expect(
      unmet([
        reviewed("ses_r1", HEAD_A, {
          verdict: "fail",
          outcome: "posted",
          outcomeDetail: "https://github.com/acme/widgets/pull/7#review-1",
          failing: ["correctness", "tests"],
        }),
      ]),
    ).toBe(
      "run ses_r1's review of acme/widgets#7 at aaaaaaaaaaaa failed correctness, tests (its findings: https://github.com/acme/widgets/pull/7#review-1): fix the findings and push, and the new head's review decides the move",
    );
    // An unposted fail still fails: the verdict is the log's, not the comment's.
    expect(
      unmet([
        reviewed("ses_r1", HEAD_A, {
          verdict: "fail",
          outcome: "withheld",
          outcomeDetail: "no reviewer identity",
          failing: ["security"],
        }),
      ]),
    ).toContain("failed security: fix the findings");
  });

  it("is met by a pass on the newest review run's own head, posted or not", () => {
    for (const outcome of ["clean", "posted", "withheld", "unposted"]) {
      expect(
        reviewVerdictVerdict({
          runs: [],
          reviews: [reviewed("ses_r1", HEAD_A, pass(outcome))],
        }),
      ).toEqual({ met: true });
    }
  });

  it("never lets an older head's pass stand in for the newest head's verdict", () => {
    const approvedA = reviewed("ses_r1", HEAD_A, pass());
    // A push opened head B's run: until B has a verdict, A's pass does not count.
    expect(unmet([approvedA, reviewed("ses_r2", HEAD_B)])).toContain(
      `run ses_r2 is still reviewing acme/widgets#7 at ${HEAD_B}`,
    );
    expect(
      unmet([
        approvedA,
        reviewed("ses_r2", HEAD_B, {
          verdict: "fail",
          outcome: "clean",
          outcomeDetail: "",
          failing: ["performance"],
        }),
      ]),
    ).toContain("at bbbbbbbbbbbb failed performance");
    expect(
      reviewVerdictVerdict({
        runs: [],
        reviews: [approvedA, reviewed("ses_r2", HEAD_B, pass())],
      }),
    ).toEqual({ met: true });
    // And the newest is the last, not the best: a fail on A followed by a pass on B is met.
    expect(
      reviewVerdictVerdict({
        runs: [],
        reviews: [
          reviewed("ses_r1", HEAD_A, {
            verdict: "fail",
            outcome: "posted",
            outcomeDetail: "",
            failing: ["correctness"],
          }),
          reviewed("ses_r2", HEAD_B, pass()),
        ],
      }),
    ).toEqual({ met: true });
  });

  it("is unmet on a pass found stale as it was posted, naming the head the PR moved to", () => {
    expect(
      unmet([
        reviewed("ses_r1", HEAD_A, {
          ...pass("stale"),
          outcomeDetail: HEAD_B,
        }),
      ]),
    ).toBe(
      `run ses_r1's pass on acme/widgets#7 at aaaaaaaaaaaa is stale: the PR moved to ${HEAD_B} before it was posted, and no review run has recorded a verdict on that head`,
    );
  });

  it("judges the review of the head the PR was last reported at, not the newest review run", () => {
    const PR = "https://github.com/acme/widgets/pull/7";
    const failOn = (sessionId: string, head: string) =>
      reviewed(sessionId, head, {
        verdict: "fail",
        outcome: "clean",
        outcomeDetail: "",
        failing: ["correctness"],
      });
    // A fails, B passes, then a force-push takes the PR back to A: A's delivery replays A's old run,
    // so B's pass is the newest run, but the PR is at A, which the reviewer failed.
    const backToA = [
      failOn("ses_r1", HEAD_A),
      reviewed("ses_r2", HEAD_B, pass()),
    ];
    expect(
      reviewVerdictVerdict({
        runs: [],
        reviews: backToA,
        reviewHeads: [{ url: PR, head: HEAD_A }],
      }),
    ).toEqual({
      met: false,
      reason:
        "run ses_r1's review of acme/widgets#7 at aaaaaaaaaaaa failed correctness: fix the findings and push, and the new head's review decides the move",
    });
    // The reverse: A passes, B fails, back to A — the PR's head passed, so the card may leave.
    expect(
      reviewVerdictVerdict({
        runs: [],
        reviews: [reviewed("ses_r1", HEAD_A, pass()), failOn("ses_r2", HEAD_B)],
        reviewHeads: [{ url: PR, head: HEAD_A }],
      }),
    ).toEqual({ met: true });
    // A head reported before its run has a target (still being opened, or skipped as unfetchable):
    // the previous head's pass does not stand in for it.
    const HEAD_C = "c".repeat(40);
    expect(
      reviewVerdictVerdict({
        runs: [],
        reviews: [reviewed("ses_r1", HEAD_A, pass())],
        reviewHeads: [{ url: PR, head: HEAD_C }],
      }),
    ).toEqual({
      met: false,
      reason: `${PR} was last reported at cccccccccccc, and no review run has recorded a target for that head (its run is still being opened, or its delivery was skipped — a head the checkout could not fetch); a review of another head does not stand in for it`,
    });
    // The card's PR recorded by its API resource still finds its reported head.
    expect(
      reviewVerdictVerdict({
        runs: [
          {
            sessionId: "ses_build",
            calls: [],
            prUrl: "https://api.github.com/repos/acme/widgets/pulls/7",
          },
        ],
        reviews: backToA,
        reviewHeads: [
          {
            url: PR,
            apiUrl: "https://api.github.com/repos/acme/widgets/pulls/7",
            head: HEAD_B,
          },
        ],
      }),
    ).toEqual({ met: true });
  });

  it("judges only the card's current PR: another PR's pass says nothing about it", () => {
    const OLD_PR = "https://github.com/acme/widgets/pull/7";
    const NEW_PR = "https://github.com/acme/widgets/pull/8";
    const approvedOld = reviewed("ses_r1", HEAD_A, pass());
    const evidence = (prUrls: string[]) => ({
      runs: prUrls.map((prUrl, at) => ({
        sessionId: `ses_build${at}`,
        calls: [],
        prUrl,
      })),
      reviews: [approvedOld],
      reviewHeads: [{ url: OLD_PR, head: HEAD_A }],
    });
    // The run that opened PR 7 was reviewed and passed.
    expect(reviewVerdictVerdict(evidence([OLD_PR]))).toEqual({ met: true });
    // A fix-up run opened PR 8: PR 7's pass does not let the card leave.
    expect(reviewVerdictVerdict(evidence([OLD_PR, NEW_PR]))).toEqual({
      met: false,
      reason: `no review ran on the card's PR ${NEW_PR}: its newest review run ses_r1 reviewed ${OLD_PR}, another PR, whose verdict says nothing about this one (the review trigger opens one for each head its PR's pull_request events name, and those reach the factory only as signed deliveries to POST /webhooks/github, which needs GITHUB_WEBHOOK_SECRET set and GitHub able to reach it)`,
    });
  });

  it("says where review runs come from when none ran", () => {
    expect(unmet([])).toBe(
      "no review ran: the card has no review run (the review trigger opens one for each head its PR's pull_request events name, and those reach the factory only as signed deliveries to POST /webhooks/github, which needs GITHUB_WEBHOOK_SECRET set and GitHub able to reach it)",
    );
  });

  it("is what requirementVerdict checks for the key", () => {
    expect(
      requirementVerdict(
        { key: "review_verdict", description: "a review verdict" },
        { runs: [] },
      ).met,
    ).toBe(false);
    expect(
      requirementVerdict(
        { key: "review_verdict", description: "a review verdict" },
        { runs: [], reviews: [reviewed("ses_r1", HEAD_A, pass())] },
      ),
    ).toEqual({ met: true });
  });
});
