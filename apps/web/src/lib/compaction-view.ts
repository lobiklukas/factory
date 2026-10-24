import type { SessionUsage } from "@repo/domain/Session";

/**
 * What a compaction cost, computed here rather than in the pane so it can be tested without a
 * browser (LOB-222).
 *
 * The dashboard has no per-action spend number of its own: `SessionUsage` is a running total for
 * the whole session, keyed by `provider/modelId` and by tool name, so the spend of one action is
 * the difference between two readings of it. That is the whole arithmetic here.
 *
 * **A zero-cost reading has no dollar figure, and this module does not invent one.** pi-ai's faux
 * provider reports tokens but no cost (`packages/harness/src/models.ts:5`, and the LOB-153 notes
 * record that its message usage hardcodes `cost.total = 0`), so every session the gate drives
 * spends $0 by construction. Printing `$0.00` beside a compaction that really used 40 000 tokens
 * would read as "free", which is a claim nobody measured; the delta therefore carries no cost at
 * all when both readings are costless, and the formatter prints only the token count.
 */

/** Spend over both buckets, the way `usageCostTotal` (`packages/harness/src/projection.ts:412`) adds them. */
export type UsageSpend = {
  readonly tokens: number;
  readonly costTotal: number;
};

/**
 * A session's spend, summed over models *and* tools.
 *
 * Both buckets count, not `models` alone: a tool result may report spend of its own (an execution
 * that calls a model), and a total that skipped it would be the original LOB-32 mistake again.
 */
export const spendOf = (usage: SessionUsage): UsageSpend => {
  let tokens = 0;
  let costTotal = 0;
  for (const bucket of [...usage.models, ...usage.tools]) {
    tokens += bucket.usage.totalTokens;
    costTotal += bucket.usage.costTotal;
  }
  return { tokens, costTotal };
};

/**
 * What happened between two readings of one session's usage.
 *
 * `cost` is `undefined` when neither reading reports any cost — nothing was measured, so there is
 * nothing to print. Never negative: usage is cumulative for a session, so a decrease means the
 * reading came from another log (a pane re-attached to a different session, say), and the honest
 * answer to "what did this action cost" is then `0`, not a negative number.
 */
export type SpendDelta = {
  readonly tokens: number;
  readonly cost: number | undefined;
};

export const spendDelta = (
  before: SessionUsage,
  after: SessionUsage,
): SpendDelta => {
  const start = spendOf(before);
  const end = spendOf(after);
  return {
    tokens: Math.max(0, end.tokens - start.tokens),
    cost:
      start.costTotal === 0 && end.costTotal === 0
        ? undefined
        : Math.max(0, end.costTotal - start.costTotal),
  };
};

// `Intl.NumberFormat` rather than a regex: the separator belongs to the locale, and pinning the
// locale here means two browsers render the same string for the same number.
const tokenFormat = new Intl.NumberFormat("en-US");

/**
 * A dollar amount as the pane prints it: `$0`, `$0.0042`, `$1.25`.
 *
 * Four decimals below a cent, because a single compaction on a small model costs a fraction of one
 * and `$0.00` would be the same lie as the zero-cost case this module refuses. Two decimals from a
 * cent up, where the extra digits are noise.
 */
const formatCost = (cost: number): string => {
  if (cost === 0) return "$0";
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
};

/**
 * One line for the pane: `40,120 tokens · $0.0384`, or `40,120 tokens` when no cost was reported.
 *
 * The token count always appears, even at zero: "0 tokens" says the action was taken and measured
 * nothing new, which is different from the pane having no number at all.
 */
export const formatSpendDelta = (delta: SpendDelta): string => {
  const tokens = `${tokenFormat.format(delta.tokens)} tokens`;
  return delta.cost === undefined
    ? tokens
    : `${tokens} · ${formatCost(delta.cost)}`;
};
