import type { CostBacktest, CostPrediction } from "@repo/domain/Cost";

/**
 * Cost prediction's wording on the dashboard (LOB-38): the range the New session form shows before
 * a session exists, the cap it offers, and the backtest headline `/spend` publishes.
 *
 * Every number is the server's (`predictCost`, `backtestCost`); this module only words them, in the
 * terms `factory cost` prints, so the terminal and the page say the same thing. Pure, so the words
 * are unit cases rather than screenshots.
 */

/** A predicted amount: four decimals, as `factory run` prints a budget, so a cent is never lost. */
export const formatPredictedDollars = (amount: number): string =>
  `$${amount.toFixed(4)}`;

export const formatPercent = (fraction: number): string =>
  `${(fraction * 100).toFixed(1)}%`;

const sessions = (n: number): string =>
  `${n} ${n === 1 ? "session" : "sessions"}`;

/**
 * The form's line: the range and where it came from, or that there is none yet and why. A
 * prediction from three sessions says three, so it never reads like one from fifty.
 */
export const predictionText = (prediction: CostPrediction): string => {
  const range = prediction.range;
  if (range === undefined) {
    return `No estimate yet: ${sessions(prediction.history)} completed, ${prediction.minimumComparables} comparable needed`;
  }
  return `Predicted ${formatPredictedDollars(range.low)} to ${formatPredictedDollars(range.high)} (median ${formatPredictedDollars(range.median)}, ${sessions(prediction.comparables)}, ${prediction.basis})`;
};

/**
 * What a create adds when the operator asked for the predicted cap: the range's high as the
 * session's `budget` (LOB-163). Nothing when they did not ask, or when there is no range to cap at
 * — the form refuses to start while a cap is asked for and there is none (`capBlocked`), so this
 * only guards a stale render.
 */
export const predictedBudget = (
  prediction: CostPrediction | undefined,
  capped: boolean,
): { readonly budget?: number } =>
  capped && prediction?.range !== undefined
    ? { budget: prediction.range.high }
    : {};

/**
 * Whether the form must hold Start: the operator asked for the predicted cap and there is no range
 * to cap at yet — still loading, failed, or too little history. Starting then would create an
 * uncapped session the operator asked to cap, so the form waits or says why instead.
 */
export const capBlocked = (
  prediction: CostPrediction | undefined,
  capped: boolean,
): boolean => capped && prediction?.range === undefined;

/**
 * The backtest headline `/spend` publishes: the median error over the sessions scored, how often the
 * range held the actual, and — below the minimum sample — that it is too few to mean much. A
 * backtest that scored nothing says so rather than printing an error of zero.
 */
export const backtestHeadline = (
  report: CostBacktest,
): { readonly headline: string; readonly detail: string } => {
  if (
    report.scored === 0 ||
    report.medianRelativeError === undefined ||
    report.medianAbsoluteError === undefined ||
    report.coverage === undefined
  ) {
    return {
      headline: "No session could be scored yet",
      detail: `${sessions(report.sessions)} completed; each needs ${report.minimumComparables} comparable before it.`,
    };
  }
  const caveat = report.meaningful
    ? ""
    : ` Too few to mean much: ${report.minimumSample} scored sessions are needed.`;
  return {
    headline: `Median error ${formatPercent(report.medianRelativeError)} over ${sessions(report.scored)}`,
    detail: `Median absolute error ${formatPredictedDollars(report.medianAbsoluteError)}; the range held the actual in ${formatPercent(report.coverage)}; ${report.skipped} skipped, ${report.sessions} completed.${caveat}`,
  };
};

/** The family key of one prediction: the prompt and the model choice, as one string. */
export const predictionKey = (prompt: string, model: string): string =>
  JSON.stringify([prompt, model]);

/** The prompt and model choice a `predictionKey` was built from. */
export const fromPredictionKey = (
  key: string,
): { readonly prompt: string; readonly model: string } => {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed) &&
    typeof parsed[0] === "string" &&
    typeof parsed[1] === "string"
    ? { prompt: parsed[0], model: parsed[1] }
    : { prompt: "", model: "" };
};
