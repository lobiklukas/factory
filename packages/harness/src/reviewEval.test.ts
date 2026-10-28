/**
 * The reviewer measurement's pure half (LOB-242): the corpus, the reading of a posted comment, the
 * columns and the threshold. The live half (`bun run review-eval`) needs a model and a forge; this runs
 * in the gate, with no database and no model, and is what keeps the table honest — the faux reviewer's
 * answers go through the real rubric, the real comment rendering and the same reading the live run uses.
 */
import { describe, expect, it } from "vitest";
import { renderReview } from "./review";
import {
  fauxPostedComment,
  fauxReviewFor,
  parseReviewComment,
  renderReviewEvalTable,
  REVIEW_EVAL_FAUX_BEHAVIOR,
  REVIEW_EVAL_THRESHOLD,
  scoreReviewEval,
  summarizeReviewEval,
  type ReviewEvalFauxBehavior,
  type ReviewEvalRecord,
  type ReviewEvalRow,
} from "./reviewEval";
import { REVIEW_EVAL_CORPUS, type ReviewEvalEntry } from "./reviewEvalCorpus";

const seeded = REVIEW_EVAL_CORPUS.filter((entry) => entry.seed !== undefined);
const clean = REVIEW_EVAL_CORPUS.filter((entry) => entry.seed === undefined);

/** Paths a PR changes, for the faux reviewer: the seeded file when there is one, and a sibling. */
const changedFor = (entry: ReviewEvalEntry): string[] => [
  entry.seed?.file ?? "packages/core/src/example.ts",
  "packages/core/src/example.test.ts",
];

const TARGET = {
  repo: "acme/eval",
  number: 1,
  url: "https://github.com/acme/eval/pull/1",
  base: "a".repeat(40),
  head: "b".repeat(40),
};

/** What the forge would hold for a faux reviewer's answer, or `null` when it posts nothing. */
const postedFor = (
  entry: ReviewEvalEntry,
  behavior: ReviewEvalFauxBehavior,
): string | null =>
  fauxPostedComment(entry, behavior, changedFor(entry), TARGET);

const recordFor = (
  entry: ReviewEvalEntry,
  comment: string | null,
  cost = 0.01,
): ReviewEvalRecord => ({
  id: entry.id,
  sessionId: "s",
  model: "faux/faux-review",
  reviewed: true,
  comment,
  cost,
  note: "",
});

const scored = (
  behaviors: Readonly<Record<string, ReviewEvalFauxBehavior>>,
): ReviewEvalRow[] =>
  REVIEW_EVAL_CORPUS.map((entry) => {
    const behavior = behaviors[entry.id] ?? "quiet";
    return scoreReviewEval(entry, recordFor(entry, postedFor(entry, behavior)));
  });

const rowOf = (rows: readonly ReviewEvalRow[], id: string): ReviewEvalRow => {
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

describe("the corpus", () => {
  it("is six seeded and six clean pull requests, each once", () => {
    expect(seeded).toHaveLength(6);
    expect(clean).toHaveLength(6);
    expect(new Set(REVIEW_EVAL_CORPUS.map((entry) => entry.id)).size).toBe(12);
    expect(new Set(REVIEW_EVAL_CORPUS.map((entry) => entry.pr)).size).toBe(12);
    expect(new Set(REVIEW_EVAL_CORPUS.map((entry) => entry.commit)).size).toBe(
      12,
    );
    for (const entry of REVIEW_EVAL_CORPUS) {
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("seeds the four kinds of bug the issue names", () => {
    const kinds = new Set(seeded.map((entry) => entry.seed?.kind));
    for (const kind of [
      "dropped element",
      "off-by-one",
      "missing await",
      "unchecked input",
    ]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  it("gives every seed an edit that changes the file and words a review would use", () => {
    for (const entry of seeded) {
      const seed = entry.seed;
      expect(seed?.find).not.toBe(seed?.replace);
      expect(seed?.find.length).toBeGreaterThan(0);
      expect(seed?.mechanism.length).toBeGreaterThan(0);
      // The faux reviewer that "finds" the bug says `bug`, so `bug` has to be in the corpus's words
      // or the faux proof could never score a mechanism.
      const said = seed?.bug.toLowerCase() ?? "";
      expect(
        seed?.mechanism.some((phrase) => said.includes(phrase.toLowerCase())),
      ).toBe(true);
    }
  });

  it("scripts a faux answer for every entry, of the kind its entry can give", () => {
    expect(Object.keys(REVIEW_EVAL_FAUX_BEHAVIOR).sort()).toEqual(
      REVIEW_EVAL_CORPUS.map((entry) => entry.id).sort(),
    );
    for (const entry of seeded) {
      expect(["right", "miss", "wrong-mechanism", "wrong-file"]).toContain(
        REVIEW_EVAL_FAUX_BEHAVIOR[entry.id],
      );
    }
    for (const entry of clean) {
      expect(["quiet", "nit", "false-positive"]).toContain(
        REVIEW_EVAL_FAUX_BEHAVIOR[entry.id],
      );
    }
  });

  it("does not let the faux's wrong-mechanism answer match any seed's words", () => {
    for (const entry of seeded) {
      const wrong = fauxReviewFor(entry, "wrong-mechanism", changedFor(entry));
      // The finding's words: the summary names the PR's title, which may say anything.
      const text = JSON.stringify(
        (wrong["dimensions"] as Record<string, unknown>)["correctness"],
      ).toLowerCase();
      for (const other of seeded) {
        for (const phrase of other.seed?.mechanism ?? []) {
          expect(text.includes(phrase.toLowerCase())).toBe(false);
        }
      }
    }
  });
});

describe("parseReviewComment", () => {
  const review = {
    summary: "A change.",
    dimensions: {
      correctness: {
        verdict: "fail" as const,
        findings: [
          {
            severity: "P0" as const,
            file: "src/a.ts",
            line: 12,
            mechanism: "drops the first element\nand so sum([5]) is 0",
          },
        ],
      },
      security: {
        verdict: "pass" as const,
        findings: [
          { severity: "P2" as const, file: "src/b.ts", mechanism: "a nit" },
        ],
      },
      tests: { verdict: "pass" as const, findings: [] },
      performance: { verdict: "pass" as const, findings: [] },
    },
  };

  it("reads back what renderReview wrote: verdict, severity, file, line and a mechanism over lines", () => {
    const body = renderReview({
      review,
      target: TARGET,
      marker: "<!-- marker -->",
    });
    expect(parseReviewComment(body)).toEqual({
      verdict: "fail",
      findings: [
        {
          severity: "P0",
          dimension: "correctness",
          file: "src/a.ts",
          line: 12,
          mechanism: "drops the first element\nand so sum([5]) is 0",
        },
        {
          severity: "P2",
          dimension: "security",
          file: "src/b.ts",
          line: undefined,
          mechanism: "a nit",
        },
      ],
    });
  });

  it("reads a passing review as a pass, and a body that is not a review as nothing", () => {
    const passing = {
      ...review,
      dimensions: {
        ...review.dimensions,
        correctness: { verdict: "pass" as const, findings: [] },
      },
    };
    const body = renderReview({
      review: passing,
      target: TARGET,
      marker: "<!-- marker -->",
    });
    expect(parseReviewComment(body)?.verdict).toBe("pass");
    expect(parseReviewComment("looks good to me")).toBeUndefined();
  });
});

describe("scoring the faux plan", () => {
  const rows = scored(REVIEW_EVAL_FAUX_BEHAVIOR);

  it("scores a right answer on every column, and each kind of miss on its own", () => {
    expect(rowOf(rows, "seed-usage-total")).toMatchObject({
      posted: true,
      detected: true,
      namedFile: true,
      namedMechanism: true,
      otherBlocking: 0,
    });
    // Reviewed, found nothing: not posted, a miss.
    expect(rowOf(rows, "seed-no-change-count")).toMatchObject({
      reviewed: true,
      posted: false,
      detected: false,
      namedFile: false,
      namedMechanism: false,
    });
    // The right file for the wrong reason.
    expect(rowOf(rows, "seed-reclaim-compare")).toMatchObject({
      detected: true,
      namedFile: true,
      namedMechanism: false,
      otherBlocking: 0,
    });
    // A failing review of some other file: caught something, not the bug.
    expect(rowOf(rows, "seed-board-repo")).toMatchObject({
      detected: true,
      namedFile: false,
      namedMechanism: false,
      otherBlocking: 1,
    });
  });

  it("counts a clean change's blocking finding as a false positive and its nit as none", () => {
    expect(rowOf(rows, "clean-title-entry")).toMatchObject({
      falsePositive: true,
      posted: true,
      otherBlocking: 1,
    });
    expect(rowOf(rows, "clean-lifecycle-action")).toMatchObject({
      falsePositive: false,
      posted: true,
      otherBlocking: 0,
    });
    expect(rowOf(rows, "clean-dev-env")).toMatchObject({
      falsePositive: false,
      posted: false,
    });
  });

  it("sums to five detected, four named a file, three a mechanism, one false alarm", () => {
    const summary = summarizeReviewEval(rows);
    expect(summary).toMatchObject({
      seeded: 6,
      clean: 6,
      reviewed: 12,
      posted: 7,
      detected: 5,
      namedFile: 4,
      namedMechanism: 3,
      falsePositives: 1,
    });
    expect(summary.cost).toBeCloseTo(0.12, 10);
    // The file rate (4/6) is under the 0.8 line: this reviewer is not trusted.
    expect(summary.trusted).toBe(false);
    expect(summary.checks.map((check) => [check.name, check.met])).toEqual([
      ["reviewed", true],
      ["detected", true],
      ["named the file", false],
      ["named the mechanism", false],
      ["false positives", true],
    ]);
  });

  it("does not detect a seeded file that only gets a P2", () => {
    const entry = seeded[0] as ReviewEvalEntry;
    const body = renderReview({
      review: {
        summary: "A change.",
        dimensions: {
          correctness: {
            verdict: "pass",
            findings: [
              {
                severity: "P2",
                file: entry.seed?.file ?? "",
                mechanism: entry.seed?.bug ?? "",
              },
            ],
          },
          security: { verdict: "pass", findings: [] },
          tests: { verdict: "pass", findings: [] },
          performance: { verdict: "pass", findings: [] },
        },
      },
      target: TARGET,
      marker: "<!-- marker -->",
    });
    expect(scoreReviewEval(entry, recordFor(entry, body))).toMatchObject({
      posted: true,
      detected: false,
      namedFile: false,
      namedMechanism: false,
    });
  });

  it("scores a run that gave no verdict as not reviewed, and a clean PR it left alone as no false positive", () => {
    const entry = clean[0] as ReviewEvalEntry;
    const row = scoreReviewEval(entry, {
      ...recordFor(entry, null),
      reviewed: false,
    });
    expect(row).toMatchObject({
      reviewed: false,
      posted: false,
      falsePositive: false,
    });
    const summary = summarizeReviewEval([
      ...rows.slice(0, 11),
      { ...rows[11], reviewed: false } as ReviewEvalRow,
    ]);
    expect(summary.checks[0]).toMatchObject({ name: "reviewed", met: false });
    expect(summary.trusted).toBe(false);
  });
});

describe("the threshold", () => {
  const everyone = Object.fromEntries(
    seeded.map((entry) => [entry.id, "right" as const]),
  );

  it("trusts a reviewer that finds every seeded bug and stays quiet on every clean change", () => {
    const summary = summarizeReviewEval(scored(everyone));
    expect(summary.detected).toBe(6);
    expect(summary.falsePositives).toBe(0);
    expect(summary.trusted).toBe(true);
  });

  it("holds the line at 80% detected, 60% mechanism and 20% false alarms, no more and no less", () => {
    const withMisses = (misses: number, wrongMechanisms = 0) =>
      scored({
        ...everyone,
        ...Object.fromEntries(
          seeded.slice(0, misses).map((entry) => [entry.id, "miss" as const]),
        ),
        ...Object.fromEntries(
          seeded
            .slice(misses, misses + wrongMechanisms)
            .map((entry) => [entry.id, "wrong-mechanism" as const]),
        ),
      });
    // One miss in six is 83%: met. Two is 67%: not.
    expect(summarizeReviewEval(withMisses(1)).trusted).toBe(true);
    expect(summarizeReviewEval(withMisses(2)).trusted).toBe(false);
    // Mechanism: two wrong in six is 67% (met); three is 50% (not) even though every file is named.
    expect(summarizeReviewEval(withMisses(0, 2)).trusted).toBe(true);
    const three = summarizeReviewEval(withMisses(0, 3));
    expect(three.namedFile).toBe(6);
    expect(three.trusted).toBe(false);
    const falseAlarms = (count: number) =>
      scored({
        ...everyone,
        ...Object.fromEntries(
          clean
            .slice(0, count)
            .map((entry) => [entry.id, "false-positive" as const]),
        ),
      });
    // One false alarm in six is 17%: met. Two is 33%: not.
    expect(summarizeReviewEval(falseAlarms(1)).trusted).toBe(true);
    expect(summarizeReviewEval(falseAlarms(2)).trusted).toBe(false);
    expect(REVIEW_EVAL_THRESHOLD.falsePositiveMax).toBe(0.2);
  });

  it("does not trust a result over fewer than five of either kind", () => {
    const rows = scored(everyone);
    const fourSeeded = rows.filter(
      (row) => row.kind === "clean" || row.id !== "seed-usage-total",
    );
    const four = fourSeeded.filter((row) => row.kind === "seeded");
    expect(four).toHaveLength(5);
    expect(summarizeReviewEval(fourSeeded).trusted).toBe(true);
    const tooFew = rows.filter(
      (row) => row.id !== "seed-usage-total" && row.id !== "seed-send-yield",
    );
    expect(summarizeReviewEval(tooFew).trusted).toBe(false);
    expect(summarizeReviewEval([]).trusted).toBe(false);
  });
});

describe("renderReviewEvalTable", () => {
  it("has the columns the issue names, one row per pull request, the totals and the verdict", () => {
    const rows = scored(REVIEW_EVAL_FAUX_BEHAVIOR);
    const table = renderReviewEvalTable(rows, summarizeReviewEval(rows), {
      mode: "faux",
      models: ["faux/faux-review"],
    });
    const header = table
      .split("\n")
      .find((line) => line.startsWith("| PR |")) as string;
    for (const column of [
      "Detected",
      "Named the file",
      "Named the mechanism",
      "False positive",
      "Cost",
    ]) {
      expect(header).toContain(column);
    }
    expect(
      table.split("\n").filter((line) => line.startsWith("| #")),
    ).toHaveLength(12);
    expect(table).toContain(
      "| #113 seed-usage-total | seeded | dropped element | yes | yes | yes | yes | yes | - | 0 | $0.0100 |",
    );
    expect(table).toContain(
      "| #186 clean-title-entry | clean | - | yes | yes | - | - | - | yes | 1 | $0.0100 |",
    );
    expect(table).toContain("Total cost $0.1200");
    expect(table).toContain("does not meet the threshold");
    expect(table).toContain("Model: faux/faux-review");
  });
});
