/**
 * Cost prediction before a run (LOB-38): the classifier, the comparable tiers, the range, and the
 * walk-forward backtest, over histories whose every number is chosen so a mistake changes the answer.
 *
 * Every expected value is worked out by hand in the comment beside it — never by calling the module
 * under test — so a change to the quantile, the tier order, the window or the "strictly before" rule
 * fails a case rather than moving both sides of it.
 */
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import {
  BACKTEST_MINIMUM_SAMPLE,
  COMPARABLE_WINDOW,
  MIN_COMPARABLES,
  backtestCost,
  classifyTask,
  predictCost,
  quantile,
  rangeOf,
  titleLine,
  type CostHistoryRow,
} from "./costPrediction";

const WEB = RepoSlug.make("acme/web");
const API = RepoSlug.make("acme/api");
const SONNET = "anthropic/claude-sonnet-4-5";
const HAIKU = "anthropic/claude-haiku-4-5";

let serial = 0;
const row = (
  fields: Partial<CostHistoryRow> & { readonly costTotal: number },
): CostHistoryRow => {
  serial += 1;
  return {
    id: SessionId.make(`ses_${String(serial).padStart(26, "0")}`),
    title: "fix the parser bug",
    repo: WEB,
    model: SONNET,
    createdAt: serial * 1000,
    ...fields,
  };
};

describe("classifyTask", () => {
  it.each([
    ["Review PR #12 for the lexer", "review"],
    ["Update the README for the CLI", "docs"],
    ["fix the flaky test", "fix"],
    ["The parser crashes on empty input", "fix"],
    ["add tests for the parser", "test"],
    ["Raise coverage of the board view", "test"],
    ["rename the --api flag", "refactor"],
    ["clean up the session sidebar", "refactor"],
    ["Add a cost column to the list", "feature"],
    ["implement the presence lease", "feature"],
    ["what does the dispatcher do?", "other"],
    ["", "other"],
  ])("%j is %s", (prompt, shape) => {
    expect(classifyTask(prompt)).toBe(shape);
  });

  it("reads only the first non-blank line, as the session's title keeps it", () => {
    expect(classifyTask("\n\n  explain the dispatcher\nthen fix the bug")).toBe(
      "other",
    );
    expect(titleLine("\n  explain the dispatcher  \nthen fix")).toBe(
      "explain the dispatcher",
    );
  });

  it("ignores a word past the 80 characters a title keeps", () => {
    const long = `${"x".repeat(80)} fix`;
    expect(titleLine(long)).toHaveLength(80);
    expect(classifyTask(long)).toBe("other");
  });

  it("matches whole words only", () => {
    // "prefix" holds "fix", "address" holds "add", "attest" holds "test".
    expect(classifyTask("prefix the address and attest")).toBe("other");
  });
});

describe("the range", () => {
  it("is the 10th percentile, the median and the 90th percentile, interpolated", () => {
    // 1..10: position (n-1)q = 0.9 → 1.9; 4.5 → 5.5; 8.1 → 9.1.
    const range = rangeOf([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(range.low).toBeCloseTo(1.9, 10);
    expect(range.median).toBeCloseTo(5.5, 10);
    expect(range.high).toBeCloseTo(9.1, 10);
  });

  it("interpolates between the two nearest ranks", () => {
    expect(quantile([1, 3], 0.5)).toBe(2);
    expect(quantile([1, 3], 0.25)).toBe(1.5);
    expect(quantile([4], 0.9)).toBe(4);
  });
});

describe("predictCost", () => {
  it("answers no range below the minimum, and counts only priced sessions as history", () => {
    const history = [
      row({ costTotal: 1 }),
      row({ costTotal: 2 }),
      // Free: a session that never made a request says nothing about price.
      row({ costTotal: 0 }),
      row({ costTotal: Number.NaN }),
    ];
    const prediction = predictCost(history, {
      prompt: "fix the lexer bug",
      repo: WEB,
      model: SONNET,
    });
    expect(MIN_COMPARABLES).toBe(3);
    expect(prediction).toEqual({
      shape: "fix",
      repo: WEB,
      model: SONNET,
      basis: "none",
      comparables: 0,
      history: 2,
    });
  });

  it("takes the most specific tier that holds three sessions", () => {
    // Each tier's sessions carry their own cost, so the range names the tier it came from.
    const history = [
      // repo+model+shape: web, sonnet, fix.
      row({ costTotal: 1 }),
      row({ costTotal: 1 }),
      row({ costTotal: 1 }),
      // repo+model: web, sonnet, a feature.
      row({ costTotal: 2, title: "add a column" }),
      row({ costTotal: 2, title: "add a row" }),
      row({ costTotal: 2, title: "add a cell" }),
      // model+shape: api, sonnet, fix.
      row({ costTotal: 3, repo: API }),
      row({ costTotal: 3, repo: API }),
      row({ costTotal: 3, repo: API }),
      // model: api, sonnet, docs.
      row({ costTotal: 4, repo: API, title: "update the readme" }),
      row({ costTotal: 4, repo: API, title: "update the docs" }),
      row({ costTotal: 4, repo: API, title: "update the changelog" }),
      // shape: api, haiku, fix.
      row({ costTotal: 5, repo: API, model: HAIKU }),
      row({ costTotal: 5, repo: API, model: HAIKU }),
      row({ costTotal: 5, repo: API, model: HAIKU }),
    ];
    const ask = (prompt: string, repo: RepoSlug | undefined, model: string) =>
      predictCost(history, { prompt, repo, model });

    const exact = ask("fix the lexer bug", WEB, SONNET);
    expect(exact.basis).toBe("repo+model+shape");
    expect(exact.comparables).toBe(3);
    expect(exact.history).toBe(15);
    expect(exact.range).toEqual({ low: 1, median: 1, high: 1 });

    // A test on web/sonnet: no web/sonnet test sessions, so every web/sonnet session (1s and 2s).
    // Six costs [1,1,1,2,2,2]: positions 0.5 → 1, 2.5 → 1.5, 4.5 → 2.
    const repoModel = ask("add tests for the lexer", WEB, SONNET);
    expect(repoModel.basis).toBe("repo+model");
    expect(repoModel.comparables).toBe(6);
    expect(repoModel.range).toEqual({ low: 1, median: 1.5, high: 2 });

    // A fix on a scratch session with sonnet: no scratch sessions, so sonnet's fixes (1s and 3s).
    // [1,1,1,3,3,3] → 1, 2, 3.
    const modelShape = ask("fix the lexer bug", undefined, SONNET);
    expect(modelShape.basis).toBe("model+shape");
    expect(modelShape.range).toEqual({ low: 1, median: 2, high: 3 });

    // A review on a scratch session with sonnet: no sonnet review, so every sonnet session.
    const model = ask("review the lexer", undefined, SONNET);
    expect(model.basis).toBe("model");
    expect(model.comparables).toBe(12);

    // A fix on an unknown model: the fixes of any model (1s, 3s and 5s).
    const shape = ask("fix the lexer bug", WEB, "anthropic/claude-opus-4-1");
    expect(shape.basis).toBe("shape");
    expect(shape.comparables).toBe(9);
    expect(shape.range?.median).toBe(3);

    // Nothing in common at all: every session.
    const all = ask("review the lexer", WEB, "anthropic/claude-opus-4-1");
    expect(all.basis).toBe("all");
    expect(all.comparables).toBe(15);
    expect(all.range?.median).toBe(3);
  });

  it("never matches a session whose model nobody recorded on a model tier", () => {
    const history = [
      row({ costTotal: 7, model: undefined }),
      row({ costTotal: 7, model: undefined }),
      row({ costTotal: 7, model: undefined }),
    ];
    // Same repo and shape, but the model is unknown: only the shape tier may use them.
    const prediction = predictCost(history, {
      prompt: "fix it",
      repo: WEB,
      model: SONNET,
    });
    expect(prediction.basis).toBe("shape");
  });

  it("matches a scratch session to scratch sessions only on a repo tier", () => {
    const history = [
      row({ costTotal: 1, repo: undefined }),
      row({ costTotal: 1, repo: undefined }),
      row({ costTotal: 1, repo: undefined }),
      row({ costTotal: 9 }),
      row({ costTotal: 9 }),
      row({ costTotal: 9 }),
    ];
    const scratch = predictCost(history, {
      prompt: "fix it",
      repo: undefined,
      model: SONNET,
    });
    expect(scratch.basis).toBe("repo+model+shape");
    expect(scratch.range?.median).toBe(1);
    expect(scratch.repo).toBeUndefined();
  });

  it("draws from the newest fifty comparable sessions only", () => {
    // Ten old, expensive runs, then fifty cheap ones: the window holds only the cheap ones.
    const old = Array.from({ length: 10 }, () => row({ costTotal: 100 }));
    const recent = Array.from({ length: COMPARABLE_WINDOW }, () =>
      row({ costTotal: 1 }),
    );
    const prediction = predictCost([...recent, ...old], {
      prompt: "fix it",
      repo: WEB,
      model: SONNET,
    });
    expect(prediction.comparables).toBe(COMPARABLE_WINDOW);
    expect(prediction.history).toBe(60);
    expect(prediction.range).toEqual({ low: 1, median: 1, high: 1 });
  });
});

describe("backtestCost", () => {
  it("predicts each session from the sessions before it and reports the median error", () => {
    // Five like sessions, costs 1, 2, 3, 4, 10 in creation order (handed in out of order).
    const [a, b, c, d, e] = [1, 2, 3, 4, 10].map((cost) =>
      row({ costTotal: cost }),
    );
    if (!a || !b || !c || !d || !e) throw new Error("five rows");
    const report = backtestCost([e, c, a, d, b]);
    // a, b, c have fewer than three sessions before them.
    // d: before it [1,2,3] → low 1.2, median 2, high 2.8; actual 4: off by 2, 0.5 of it, outside.
    // e: before it [1,2,3,4] → low 1.3, median 2.5, high 3.7; actual 10: off by 7.5, 0.75, outside.
    expect(report.sessions).toBe(5);
    expect(report.skipped).toBe(3);
    expect(report.scored).toBe(2);
    expect(report.rows.map((r) => r.id)).toEqual([d.id, e.id]);
    expect(report.rows[0]?.range.low).toBeCloseTo(1.2, 10);
    expect(report.rows[0]?.range.median).toBeCloseTo(2, 10);
    expect(report.rows[0]?.range.high).toBeCloseTo(2.8, 10);
    expect(report.rows[0]?.relativeError).toBeCloseTo(0.5, 10);
    expect(report.rows[1]?.relativeError).toBeCloseTo(0.75, 10);
    // The medians of two values are their means: (0.5 + 0.75) / 2 and (2 + 7.5) / 2.
    expect(report.medianRelativeError).toBeCloseTo(0.625, 10);
    expect(report.medianAbsoluteError).toBeCloseTo(4.75, 10);
    expect(report.coverage).toBe(0);
    expect(report.meaningful).toBe(false);
    expect(report.minimumSample).toBe(BACKTEST_MINIMUM_SAMPLE);
  });

  it("counts an actual inside its range as covered", () => {
    // 2, 2, 2, then 2 and 5: the fourth lands on its range [2, 2], the fifth (range [2, 2]) does not.
    const rows = [2, 2, 2, 2, 5].map((cost) => row({ costTotal: cost }));
    const report = backtestCost(rows);
    expect(report.scored).toBe(2);
    expect(report.coverage).toBe(0.5);
    // Errors 0 and 3/5: the median is their mean, 0.3.
    expect(report.medianRelativeError).toBeCloseTo(0.3, 10);
  });

  it("never predicts a session from one created at the same instant or after it", () => {
    // Three sessions at one instant, then one later: the first three have nothing strictly before
    // them, so only the fourth is scored — from all three.
    const at = 5_000_000;
    const same = [1, 2, 3].map((cost) =>
      row({ costTotal: cost, createdAt: at }),
    );
    const later = row({ costTotal: 2, createdAt: at + 1 });
    const report = backtestCost([later, ...same]);
    expect(report.skipped).toBe(3);
    expect(report.rows.map((r) => r.id)).toEqual([later.id]);
    expect(report.rows[0]?.relativeError).toBe(0);
  });

  it("is meaningful from twenty scored sessions, and reports no error when nothing scored", () => {
    // n like sessions score n − 3: the first three have too little before them.
    const run = (n: number) =>
      backtestCost(
        Array.from({ length: n }, (_, i) => row({ costTotal: 1 + (i % 4) })),
      );
    expect(run(BACKTEST_MINIMUM_SAMPLE + 2).meaningful).toBe(false);
    expect(run(BACKTEST_MINIMUM_SAMPLE + 3).scored).toBe(
      BACKTEST_MINIMUM_SAMPLE,
    );
    expect(run(BACKTEST_MINIMUM_SAMPLE + 3).meaningful).toBe(true);
    const empty = run(3);
    expect(empty.scored).toBe(0);
    expect(empty.medianRelativeError).toBeUndefined();
    expect(empty.medianAbsoluteError).toBeUndefined();
    expect(empty.coverage).toBeUndefined();
  });

  it("leaves out sessions that cost nothing", () => {
    const report = backtestCost([row({ costTotal: 0 }), row({ costTotal: 1 })]);
    expect(report.sessions).toBe(1);
  });
});
