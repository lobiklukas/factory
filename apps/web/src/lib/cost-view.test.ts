/**
 * Cost prediction's wording on the dashboard (LOB-38). Which sessions a range came from is the
 * server's answer (`packages/core`'s `costPrediction` cases); the browser drive
 * (`.pi/skills/verify-web/cost.sh`) proves the rendered form and `/spend`. These are the cases a
 * drive does not reach cheaply: no range, a cap with nothing to cap at, a backtest that scored
 * nothing, and the minimum-sample caveat on and off.
 */
import { CostBacktest, CostPrediction } from "@repo/domain/Cost";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  backtestHeadline,
  fromPredictionKey,
  predictedBudget,
  predictionKey,
  predictionText,
} from "./cost-view";

const ranged = Schema.decodeSync(CostPrediction)({
  shape: "other",
  model: "faux/faux-1",
  basis: "model+shape",
  comparables: 4,
  history: 6,
  range: { low: 0.02, median: 0.025, high: 0.037 },
});
const unranged = Schema.decodeSync(CostPrediction)({
  shape: "other",
  model: "faux/faux-1",
  basis: "none",
  comparables: 0,
  history: 1,
});

const report = (extra: Partial<typeof CostBacktest.Encoded> = {}) =>
  Schema.decodeSync(CostBacktest)({
    sessions: 6,
    scored: 3,
    skipped: 3,
    minimumSample: 20,
    meaningful: false,
    medianRelativeError: 0.25,
    medianAbsoluteError: 0.01,
    coverage: 2 / 3,
    rows: [],
    ...extra,
  });

describe("predictionText", () => {
  it("names the range, its median, its sample and its basis", () => {
    expect(predictionText(ranged)).toBe(
      "Predicted $0.0200 to $0.0370 (median $0.0250, 4 sessions, model+shape)",
    );
  });

  it("says there is no estimate yet, and how much history there is", () => {
    expect(predictionText(unranged)).toBe(
      "No estimate yet: 1 session completed, 3 comparable needed",
    );
  });
});

describe("predictedBudget", () => {
  it("is the range's high when the cap was asked for", () => {
    expect(predictedBudget(ranged, true)).toEqual({ budget: 0.037 });
  });

  it("adds nothing when the cap was not asked for, or there is nothing to cap at", () => {
    expect(predictedBudget(ranged, false)).toEqual({});
    expect(predictedBudget(unranged, true)).toEqual({});
    expect(predictedBudget(undefined, true)).toEqual({});
  });
});

describe("backtestHeadline", () => {
  it("leads with the median error and carries the caveat below the minimum sample", () => {
    expect(backtestHeadline(report())).toEqual({
      headline: "Median error 25.0% over 3 sessions",
      detail:
        "Median absolute error $0.0100; the range held the actual in 66.7%; 3 skipped, 6 completed. Too few to mean much: 20 scored sessions are needed.",
    });
  });

  it("drops the caveat once the sample is meaningful", () => {
    const { detail } = backtestHeadline(
      report({ scored: 20, sessions: 23, meaningful: true }),
    );
    expect(detail).not.toContain("Too few");
  });

  it("says nothing was scored rather than an error of zero", () => {
    const {
      medianRelativeError: _r,
      medianAbsoluteError: _a,
      coverage: _c,
      ...rest
    } = report();
    expect(
      backtestHeadline({ ...rest, scored: 0, skipped: 2, sessions: 2 }),
    ).toEqual({
      headline: "No session could be scored yet",
      detail: "2 sessions completed; each needs 3 comparable before it.",
    });
  });
});

describe("predictionKey", () => {
  it("round-trips a prompt and a model choice, including the server's default", () => {
    expect(fromPredictionKey(predictionKey("fix it\nnow", ""))).toEqual({
      prompt: "fix it\nnow",
      model: "",
    });
  });
});
