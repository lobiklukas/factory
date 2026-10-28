/**
 * Cost prediction before a run (LOB-38): a range for what a session will cost, from the completed
 * sessions most like it, and the backtest that says how wrong that has been.
 *
 * Pure: the history is handed in (`SessionService` reads it from the index in one query, R6), so
 * every rule here is a unit case rather than a database fixture.
 *
 * **Comparable.** A prompt is classified by `classifyTask` into a `TaskShape`. The comparables are
 * the first tier of `TIERS` — repo+model+shape, repo+model, model+shape, model, shape, all — that
 * holds at least `MIN_COMPARABLES` completed sessions, newest first, at most `COMPARABLE_WINDOW` of
 * them (prices and habits drift, so an old run counts only until newer ones replace it). The model
 * dominates the price, which is why every tier that names a repo also names the model, and why a
 * session whose model the index never learned matches only the tiers that do not ask.
 *
 * **Range.** The comparables' 10th percentile, median and 90th percentile (linear interpolation).
 * The median is the point estimate the backtest scores; the high is what `--cap-at-prediction` caps
 * at, so roughly one comparable run in ten would have been stopped by it.
 *
 * **Backtest.** Walk-forward: every completed session, oldest first, is predicted from only the
 * sessions created strictly before it — exactly what `predictCost` would have answered on the day it
 * was created — and scored on `|median − actual| / actual`. The report is the median of those, the
 * median absolute error, and how often the actual fell inside the range. Fewer than
 * `BACKTEST_MINIMUM_SAMPLE` scored sessions is reported, and marked as not meaningful.
 */
import type {
  CostBacktest,
  CostBacktestRow,
  CostBasis,
  CostPrediction,
  CostRange,
  TaskShape,
} from "@repo/domain/Cost";
import type { RepoSlug, SessionId } from "@repo/domain/Session";

/** Fewest comparable sessions a tier needs before it answers a range. */
export const MIN_COMPARABLES = 3;
/** Most comparable sessions a range is drawn from: the newest ones. */
export const COMPARABLE_WINDOW = 50;
/** Fewest scored sessions a backtest needs before its number means anything. */
export const BACKTEST_MINIMUM_SAMPLE = 20;
/** The percentiles the range is drawn at. */
const LOW_QUANTILE = 0.1;
const HIGH_QUANTILE = 0.9;
/** How much of a prompt a title keeps (`SessionService`'s `TITLE_MAX`): all a history row carries. */
const TITLE_CHARS = 80;

/** One completed session, as the index remembers it. */
export type CostHistoryRow = {
  readonly id: SessionId;
  /** The session's title: its first prompt's first line, or the title it was created with. */
  readonly title: string;
  /** Absent: a scratch session. */
  readonly repo: RepoSlug | undefined;
  /** `provider/modelId`. Absent: a row nothing recorded a model on (before LOB-269). */
  readonly model: string | undefined;
  /** What it spent, in US dollars. */
  readonly costTotal: number;
  /** When it was created, in epoch milliseconds. */
  readonly createdAt: number;
};

/** What is being predicted: the prompt, and the repo and model it would run on. */
export type CostQuery = {
  readonly prompt: string;
  readonly repo: RepoSlug | undefined;
  readonly model: string | undefined;
};

/**
 * The words that name each shape, tried in this order — the first that matches wins, so "fix the
 * flaky test" is a fix and "add tests for the parser" is a test.
 */
const SHAPE_WORDS: ReadonlyArray<readonly [TaskShape, RegExp]> = [
  ["review", /\b(review|reviews|reviewing)\b/],
  [
    "docs",
    /\b(doc|docs|documentation|document|documented|readme|changelog|adr|jsdoc)\b/,
  ],
  [
    "fix",
    /\b(fix|fixes|fixed|fixing|bug|bugs|broken|crash|crashes|crashing|regression|fail|fails|failing|failure|error|errors)\b/,
  ],
  ["test", /\b(test|tests|testing|flaky|coverage|e2e)\b/],
  [
    "refactor",
    /\b(refactor|refactors|refactoring|rename|renames|cleanup|clean up|simplify|extract|tidy|dedupe|move)\b/,
  ],
  [
    "feature",
    /\b(add|adds|adding|implement|implements|implementing|support|create|build|introduce|new|allow|enable)\b/,
  ],
];

/**
 * The line a session's title keeps of a prompt: the first non-blank line, trimmed, at most 80
 * characters — the rule `SessionService` titles a session by, so a prompt and the title it will
 * become classify alike.
 */
export const titleLine = (prompt: string): string =>
  (prompt.split("\n").find((line) => line.trim().length > 0) ?? "")
    .trim()
    .slice(0, TITLE_CHARS);

/** The shape of a task, from its title line. */
export const classifyTask = (prompt: string): TaskShape => {
  const line = titleLine(prompt).toLowerCase();
  for (const [shape, words] of SHAPE_WORDS) {
    if (words.test(line)) return shape;
  }
  return "other";
};

/**
 * The `q`th quantile of values sorted ascending, interpolated linearly between the two nearest
 * ranks (the "type 7" estimator spreadsheets use). `sorted` is never empty here.
 */
export const quantile = (sorted: readonly number[], q: number): number => {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const lower = sorted[below] ?? 0;
  const upper = sorted[above] ?? lower;
  return lower + (upper - lower) * (position - below);
};

const median = (values: readonly number[]): number =>
  quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );

/** The range a set of comparable costs gives. */
export const rangeOf = (costs: readonly number[]): CostRange => {
  const sorted = [...costs].sort((a, b) => a - b);
  return {
    low: quantile(sorted, LOW_QUANTILE),
    median: quantile(sorted, 0.5),
    high: quantile(sorted, HIGH_QUANTILE),
  };
};

type Tier = {
  readonly basis: Exclude<CostBasis, "none">;
  readonly matches: (
    row: CostHistoryRow,
    query: CostQuery,
    shape: TaskShape,
  ) => boolean;
};

// A scratch session's repo is "no repo", which another scratch session shares; a model nobody
// recorded is unknown, which nothing shares.
const sameRepo = (row: CostHistoryRow, query: CostQuery) =>
  row.repo === query.repo;
const sameModel = (row: CostHistoryRow, query: CostQuery) =>
  query.model !== undefined && row.model === query.model;
const sameShape = (row: CostHistoryRow, shape: TaskShape) =>
  classifyTask(row.title) === shape;

/** The comparable tiers, most specific first. */
export const TIERS: readonly Tier[] = [
  {
    basis: "repo+model+shape",
    matches: (row, query, shape) =>
      sameRepo(row, query) && sameModel(row, query) && sameShape(row, shape),
  },
  {
    basis: "repo+model",
    matches: (row, query) => sameRepo(row, query) && sameModel(row, query),
  },
  {
    basis: "model+shape",
    matches: (row, query, shape) =>
      sameModel(row, query) && sameShape(row, shape),
  },
  { basis: "model", matches: (row, query) => sameModel(row, query) },
  { basis: "shape", matches: (row, _query, shape) => sameShape(row, shape) },
  { basis: "all", matches: () => true },
];

const priced = (row: CostHistoryRow): boolean =>
  Number.isFinite(row.costTotal) && row.costTotal > 0;

/** Newest first; the id breaks a tie, so two reads of one history answer one range. */
const newestFirst = (a: CostHistoryRow, b: CostHistoryRow): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The prediction from a history already filtered to priced rows and sorted newest first. */
const predictSorted = (
  history: readonly CostHistoryRow[],
  query: CostQuery,
): Omit<CostPrediction, "model" | "repo"> => {
  const shape = classifyTask(query.prompt);
  for (const tier of TIERS) {
    const costs: number[] = [];
    for (const row of history) {
      if (!tier.matches(row, query, shape)) continue;
      costs.push(row.costTotal);
      if (costs.length === COMPARABLE_WINDOW) break;
    }
    if (costs.length >= MIN_COMPARABLES) {
      return {
        shape,
        basis: tier.basis,
        comparables: costs.length,
        history: history.length,
        range: rangeOf(costs),
      };
    }
  }
  return { shape, basis: "none", comparables: 0, history: history.length };
};

/**
 * Predict a run's cost from the completed sessions in `history`. `query.model` is the model it will
 * run on, already resolved (the deployment's when the caller named none); the answer echoes it.
 */
export const predictCost = (
  history: readonly CostHistoryRow[],
  query: CostQuery & { readonly model: string },
): CostPrediction => ({
  ...predictSorted(history.filter(priced).sort(newestFirst), query),
  ...(query.repo === undefined ? {} : { repo: query.repo }),
  model: query.model,
});

/**
 * The walk-forward backtest over `history`: each priced session predicted from the sessions created
 * strictly before it, scored against what it actually cost.
 */
export const backtestCost = (
  history: readonly CostHistoryRow[],
): CostBacktest => {
  const ascending = history.filter(priced).sort((a, b) => newestFirst(b, a));
  const rows: CostBacktestRow[] = [];
  let skipped = 0;
  let within = 0;
  // `earlier` is every session created strictly before the one being scored, newest first. Sessions
  // created at the same instant never predict each other: neither existed before the other.
  const earlier: CostHistoryRow[] = [];
  let next = 0;
  for (const row of ascending) {
    while (
      next < ascending.length &&
      (ascending[next]?.createdAt ?? Infinity) < row.createdAt
    ) {
      const admitted = ascending[next];
      if (admitted !== undefined) earlier.unshift(admitted);
      next += 1;
    }
    const predicted = predictSorted(earlier, {
      prompt: row.title,
      repo: row.repo,
      model: row.model,
    });
    if (predicted.range === undefined) {
      skipped += 1;
      continue;
    }
    const { range } = predicted;
    if (row.costTotal >= range.low && row.costTotal <= range.high) within += 1;
    rows.push({
      id: row.id,
      title: row.title,
      shape: predicted.shape,
      basis: predicted.basis,
      actual: row.costTotal,
      range,
      relativeError: Math.abs(range.median - row.costTotal) / row.costTotal,
    });
  }
  const scored = rows.length;
  return {
    sessions: ascending.length,
    scored,
    skipped,
    minimumSample: BACKTEST_MINIMUM_SAMPLE,
    meaningful: scored >= BACKTEST_MINIMUM_SAMPLE,
    ...(scored === 0
      ? {}
      : {
          medianRelativeError: median(rows.map((r) => r.relativeError)),
          medianAbsoluteError: median(
            rows.map((r) => Math.abs(r.range.median - r.actual)),
          ),
          coverage: within / scored,
        }),
    rows,
  };
};
