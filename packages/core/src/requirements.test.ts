/**
 * The exit-requirement rules as pure functions of the evidence (LOB-80; docs/board.md B5, B8).
 *
 * The records here are the shapes the `verify` tool writes (`@repo/harness`'s `VerifyRecord`), built
 * by hand so each rule is pinned by one case; `TaskService.test.ts` drives the same rules through a
 * real run's log in Postgres.
 */
import { describe, expect, it } from "vitest";
import type { BoardColumn } from "@repo/domain/Task";
import type { RecordedReview, VerifyRecord, VerifyResult } from "@repo/harness";
import {
  type BranchDiff,
  CHECKED_REQUIREMENTS,
  exitRequirements,
  nonEmptyDiffVerdict,
  prLinkVerdict,
  requirementVerdict,
  type ReviewRunEvidence,
  reviewVerdictVerdict,
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
    ]);
    // `human_merge` is the merge gate, enforced by actor, not by a check of evidence.
    expect(exitRequirements(review, "done").map((r) => r.key)).toEqual([
      "verified",
      "review_verdict",
    ]);
    // `run_completed` has no recorded artifact yet, so it is skipped; the two that do are kept in
    // the order building declares them, which is the order a refusal names the first unmet one.
    expect(exitRequirements(building, "review").map((r) => r.key)).toEqual([
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
