/**
 * The exit-requirement rules as pure functions of the evidence (LOB-80; docs/board.md B5, B8).
 *
 * The records here are the shapes the `verify` tool writes (`@repo/harness`'s `VerifyRecord`), built
 * by hand so each rule is pinned by one case; `TaskService.test.ts` drives the same rules through a
 * real run's log in Postgres.
 */
import { describe, expect, it } from "vitest";
import type { BoardColumn } from "@repo/domain/Task";
import type { VerifyRecord, VerifyResult } from "@repo/harness";
import {
  CHECKED_REQUIREMENTS,
  exitRequirements,
  requirementVerdict,
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
    expect([...CHECKED_REQUIREMENTS]).toEqual(["verified"]);
    expect(exitRequirements(review, "done").map((r) => r.key)).toEqual([
      "verified",
    ]);
  });

  it("checks nothing on the way into canceled, or for a column the definition does not name", () => {
    expect(exitRequirements(review, "canceled")).toEqual([]);
    expect(exitRequirements(undefined, "done")).toEqual([]);
  });

  it("names a key without a checker as unchecked rather than met", () => {
    expect(
      requirementVerdict(
        { key: "review_verdict", description: "a review verdict" },
        [],
      ),
    ).toEqual({ met: false, reason: '"review_verdict" has no checker' });
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
