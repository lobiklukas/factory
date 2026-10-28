import { Schema } from "effect";
import { Timestamp } from "./Ids";
import { RepoSlug } from "./Session";

/**
 * Outcome metrics (LOB-44): is the factory accelerating delivery, measured from what it records —
 * the board's card history, the session index and the merges the GitHub webhook reports — never
 * from a count of PRs it opened. The definitions and their derivations are `@repo/core`'s
 * `outcomes.ts`; `docs/metrics.md` is the operator's copy.
 *
 * **Every value states its window and its denominator.** A share or a median means nothing without
 * both: the same data reads as two different claims over two different windows or denominators
 * (Mastra Factory's 25–35% of PRs in prose against 277 of 1,627, 17.0%, on its own chart). So the
 * wire shape has no bare number: a value travels with the window it was taken over, the population
 * it was taken of, and the source it was derived from.
 */

/**
 * What `getOutcomes` reads. `since` and `until` are ISO-8601 instants, `[since, until)`; absent,
 * `until` is now and `since` thirty days before it. `repo` narrows every metric to one repo's cards
 * and sessions; absent, the whole deployment.
 */
export const OutcomesInput = Schema.Struct({
  since: Schema.optional(Timestamp),
  until: Schema.optional(Timestamp),
  repo: Schema.optional(RepoSlug),
});
export type OutcomesInput = typeof OutcomesInput.Type;

/** The named metric set a value belongs to. */
export const OutcomeMetric = Schema.Literals([
  "lead_time",
  "cycle_time",
  "defect_pressure",
  "recovery",
  "adoption",
  "cost",
]);
export type OutcomeMetric = typeof OutcomeMetric.Type;

/** What a value counts in: seconds of wall time, a ratio in `[0, 1]`, a count, or dollars. */
export const OutcomeUnit = Schema.Literals([
  "seconds",
  "ratio",
  "count",
  "usd",
]);
export type OutcomeUnit = typeof OutcomeUnit.Type;

/** The half-open interval `[since, until)` a value was taken over, as ISO-8601 UTC instants. */
export const OutcomeWindow = Schema.Struct({
  since: Timestamp,
  until: Timestamp,
});
export type OutcomeWindow = typeof OutcomeWindow.Type;

/** The population a value was taken of: how many, and of what, in words a person reads. */
export const OutcomeDenominator = Schema.Struct({
  count: Schema.Int,
  of: Schema.String,
});
export type OutcomeDenominator = typeof OutcomeDenominator.Type;

/**
 * One reported number. `value` is `null` when the denominator is empty — a median of nothing or a
 * share of nothing is not zero, and reporting it as zero is the lie this shape exists to prevent.
 * `source` names the tables (and the log document behind them) the value is derived from.
 */
export const OutcomeValue = Schema.Struct({
  metric: OutcomeMetric,
  name: Schema.String,
  value: Schema.NullOr(Schema.Finite),
  unit: OutcomeUnit,
  window: OutcomeWindow,
  denominator: OutcomeDenominator,
  source: Schema.String,
});
export type OutcomeValue = typeof OutcomeValue.Type;

/** The whole read: every value of every metric, in a fixed order, over one window. */
export const OutcomeReport = Schema.Struct({
  window: OutcomeWindow,
  repo: Schema.optional(RepoSlug),
  values: Schema.Array(OutcomeValue),
});
export type OutcomeReport = typeof OutcomeReport.Type;
