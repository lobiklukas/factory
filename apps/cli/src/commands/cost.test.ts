/**
 * `factory cost`'s wording (LOB-38): what a prediction, a cap and a backtest print.
 *
 * The commands themselves run against a real control plane in `.pi/skills/verify-api/cost.sh`;
 * these cases pin the lines a script greps — the range and its median, a missing range said as
 * such, the cap `--cap-at-prediction` takes, and a backtest that says when its number is too few to
 * mean much.
 */
import { Schema } from "effect";
import { CostBacktest, CostPrediction } from "@repo/domain/Cost";
import { describe, expect, it } from "vitest";
import {
  BACKTEST_ROWS_HEADER,
  backtestLines,
  backtestRow,
  predictedCap,
  predictionLine,
} from "./cost";

const prediction = (
  extra: Partial<typeof CostPrediction.Encoded> = {},
): CostPrediction =>
  Schema.decodeSync(CostPrediction)({
    shape: "fix",
    model: "faux/faux-1",
    basis: "repo+model+shape",
    comparables: 4,
    history: 9,
    minimumComparables: 3,
    range: { low: 0.02, median: 0.025, high: 0.037 },
    ...extra,
  });

const ROW = {
  id: `ses_${"0".repeat(26)}`,
  title: "fix the broken import",
  shape: "fix",
  basis: "repo+model+shape",
  actual: 0.04,
  range: { low: 0.02, median: 0.02, high: 0.028 },
  relativeError: 0.5,
} as const;

const backtest = (
  extra: Partial<typeof CostBacktest.Encoded> = {},
): CostBacktest =>
  Schema.decodeSync(CostBacktest)({
    sessions: 4,
    scored: 1,
    skipped: 3,
    minimumComparables: 3,
    minimumSample: 20,
    meaningful: false,
    medianRelativeError: 0.5,
    medianAbsoluteError: 0.02,
    coverage: 0,
    rows: [ROW],
    ...extra,
  });

describe("predictionLine", () => {
  it("prints the range, its median, its sample and how it was chosen", () => {
    expect(predictionLine(prediction())).toBe(
      "predicted $0.0200 to $0.0370, median $0.0250, from 4 sessions (repo+model+shape; fix on faux/faux-1)",
    );
  });

  it("says there is no estimate, and why, when the history is too small", () => {
    const { range: _range, ...rest } = prediction();
    expect(
      predictionLine({ ...rest, basis: "none", comparables: 0, history: 1 }),
    ).toBe(
      "predicted: no estimate (1 session completed, 3 comparable needed; fix on faux/faux-1)",
    );
  });
});

describe("predictedCap", () => {
  it("is the range's high", () => {
    expect(predictedCap(prediction())).toEqual({ cap: 0.037 });
  });

  it("is refused with no range, naming the alternative", () => {
    const { range: _range, ...rest } = prediction();
    const cap = predictedCap({
      ...rest,
      basis: "none",
      comparables: 0,
      history: 2,
    });
    expect(cap).toEqual({
      refused:
        "no prediction to cap at: 2 sessions completed, 3 comparable needed; pass --budget instead",
    });
  });
});

describe("backtestLines", () => {
  it("leads with the median error, and says when it is too few to mean much", () => {
    expect(backtestLines(backtest())).toEqual([
      "backtest: median error 50.0% over 1 session (3 skipped, 4 completed)",
      "median absolute error $0.0200",
      "range held the actual in 0.0% (0 of 1)",
      "too few to mean much: 1 of the 20 scored sessions a meaningful number needs",
    ]);
  });

  it("drops the warning once the sample is meaningful", () => {
    const lines = backtestLines(
      backtest({
        sessions: 25,
        scored: 22,
        skipped: 3,
        meaningful: true,
        medianRelativeError: 0.4166,
        coverage: 0.5,
      }),
    );
    expect(lines[0]).toBe(
      "backtest: median error 41.7% over 22 sessions (3 skipped, 25 completed)",
    );
    expect(lines[2]).toBe("range held the actual in 50.0% (11 of 22)");
    expect(lines).toHaveLength(3);
  });

  it("says nothing could be scored rather than printing an error of zero", () => {
    const {
      medianRelativeError: _r,
      medianAbsoluteError: _a,
      coverage: _c,
      rows: _rows,
      ...rest
    } = backtest();
    expect(
      backtestLines({ ...rest, sessions: 2, scored: 0, skipped: 2 }),
    ).toEqual([
      "backtest: no session could be scored (2 sessions completed; each needs 3 comparable before it)",
    ]);
  });
});

describe("backtestRow", () => {
  it("is one tab-separated line per scored session, in the header's order", () => {
    const [row] = backtest().rows ?? [];
    if (row === undefined) throw new Error("one row");
    const cells = backtestRow(row).split("\t");
    expect(BACKTEST_ROWS_HEADER.split("\t")).toHaveLength(cells.length);
    expect(cells).toEqual([
      ROW.id,
      "fix",
      "repo+model+shape",
      "$0.0400",
      "$0.0200",
      "$0.0200",
      "$0.0280",
      "50.0%",
      "fix the broken import",
    ]);
  });
});
