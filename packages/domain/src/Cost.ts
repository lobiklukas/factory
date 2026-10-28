import { Schema } from "effect";
import { RepoSlug, SessionId } from "@repo/domain/Session";

/**
 * Cost prediction before a run (LOB-38): what a session is likely to cost, as a range, from the
 * sessions like it that already finished — and how wrong that has been.
 *
 * The history is the session index (R6: never a fold): a session's title (its prompt's first line),
 * repo, model and `cost_total`. A **completed** session is one that is idle, has no run or mission in
 * flight, and spent something: a session that cost nothing says nothing about price. The predictor
 * and the backtest are `@repo/core`'s `costPrediction.ts`; the decision record is on LOB-38 and
 * `docs/cost-prediction.md`.
 */

/**
 * What kind of task a prompt is, from the words in its first line: the one feature a prompt and a
 * finished session's title both carry. A keyword class rather than a model's opinion, so a backtest
 * classifies its history exactly as a prediction classifies the next prompt.
 */
export const TaskShape = Schema.Literals([
  "review",
  "docs",
  "fix",
  "test",
  "refactor",
  "feature",
  "other",
]);
export type TaskShape = typeof TaskShape.Type;

/**
 * Which comparable sessions a range came from, most specific first: the first tier with enough
 * sessions answers (`MIN_COMPARABLES`). `none` is a history too small to answer at all.
 */
export const CostBasis = Schema.Literals([
  "repo+model+shape",
  "repo+model",
  "model+shape",
  "model",
  "shape",
  "all",
  "none",
]);
export type CostBasis = typeof CostBasis.Type;

/** A predicted spend in US dollars: the comparables' 10th percentile, median and 90th percentile. */
export const CostRange = Schema.Struct({
  low: Schema.Finite,
  median: Schema.Finite,
  high: Schema.Finite,
});
export type CostRange = typeof CostRange.Type;

/**
 * What a run would be asked to do. `prompt` is the task as it will be sent; only its first line is
 * read, because that is all a finished session's title keeps. `repo` absent is a scratch session;
 * `model` absent is the model the deployment would give it.
 */
export const PredictCostInput = Schema.Struct({
  prompt: Schema.String,
  repo: Schema.optional(RepoSlug),
  model: Schema.optional(Schema.String),
});
export type PredictCostInput = typeof PredictCostInput.Type;

/**
 * A prediction. `range` is absent when the history is too small (`basis: "none"`); `comparables`
 * is how many sessions the range is from and `history` how many completed sessions there were to
 * choose from, so a three-session guess never reads like a fifty-session one. `model` is the one
 * predicted for — the deployment's when the input named none. `minimumComparables` is the fewest
 * comparable sessions a range needs, so a no-range answer can say how many it lacked.
 */
export const CostPrediction = Schema.Struct({
  shape: TaskShape,
  repo: Schema.optional(RepoSlug),
  model: Schema.String,
  basis: CostBasis,
  comparables: Schema.Int,
  history: Schema.Int,
  minimumComparables: Schema.Int,
  range: Schema.optional(CostRange),
});
export type CostPrediction = typeof CostPrediction.Type;

/**
 * What `backtestCost` scores: every completed session the index holds, or `repo`'s only. The history
 * each one is predicted from is always the whole index, as `predictCost`'s is, so a repo's number is
 * the error of the predictor its runs actually get. `rows` asks for every scored session as well as
 * the summary; absent, only the summary comes back.
 */
export const BacktestCostInput = Schema.Struct({
  repo: Schema.optional(RepoSlug),
  rows: Schema.optional(Schema.Boolean),
});
export type BacktestCostInput = typeof BacktestCostInput.Type;

/** One backtested session: what it cost, and what the predictor would have said before it ran. */
export const CostBacktestRow = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  shape: TaskShape,
  basis: CostBasis,
  actual: Schema.Finite,
  range: CostRange,
  /** `|median − actual| / actual`. */
  relativeError: Schema.Finite,
});
export type CostBacktestRow = typeof CostBacktestRow.Type;

/**
 * The backtest (LOB-38's acceptance): each completed session, in creation order, predicted from only
 * the sessions that had finished before it was created. `scored` sessions had a range to score;
 * `skipped` ones came too early to have one (fewer than `minimumComparables` before them). The
 * errors and the coverage are absent when nothing was scored. `meaningful` is
 * `scored >= minimumSample`: below it the number is still reported, and every surface says it is too
 * few to mean much.
 */
export const CostBacktest = Schema.Struct({
  sessions: Schema.Int,
  scored: Schema.Int,
  skipped: Schema.Int,
  minimumComparables: Schema.Int,
  minimumSample: Schema.Int,
  meaningful: Schema.Boolean,
  /** The headline: the median of `|median − actual| / actual` across scored sessions. */
  medianRelativeError: Schema.optional(Schema.Finite),
  /** The median of `|median − actual|`, in US dollars. */
  medianAbsoluteError: Schema.optional(Schema.Finite),
  /** The share of scored sessions whose actual cost fell inside their predicted range. */
  coverage: Schema.optional(Schema.Finite),
  /** Every scored session, oldest first: present only when the input asked for `rows`. */
  rows: Schema.optional(Schema.Array(CostBacktestRow)),
});
export type CostBacktest = typeof CostBacktest.Type;
