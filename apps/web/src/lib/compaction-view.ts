import type {
  SessionId,
  SessionUsage,
  TranscriptEntry,
} from "@repo/domain/Session";

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
 * One line for a reading of a session's own spend: `46,120 tokens`, or with cost when it was
 * measured.
 *
 * A cumulative reading follows the same rule as a delta: `costTotal === 0` is a provider that
 * reported no cost, not a free run, so it prints no dollar figure. This is what the pane header
 * shows, and the delta beside a compaction sits next to it.
 */
export const formatSpend = (spend: UsageSpend): string => {
  const tokens = `${tokenFormat.format(spend.tokens)} tokens`;
  return spend.costTotal === 0
    ? tokens
    : `${tokens} · ${formatCost(spend.costTotal)}`;
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

/**
 * The readings a compaction is measured against, and which session they belong to (LOB-223).
 *
 * `before` and `entriesBefore` are taken when the operator presses the button. `entriesBefore` is
 * the transcript's length at that moment, because the summary arrives later as a *new* entry over
 * the same stream — a compaction entry already on screen is an older one, and hanging this press's
 * spend on it would attribute the wrong action.
 *
 * `after` is the reading taken once the summarizer's own spend has landed, and it is captured to be
 * frozen: the pane re-renders on every stream event, so a live reading would keep growing with every
 * later turn and turn "what this compaction cost" into "what the session has spent since".
 *
 * `sessionId` is here because one pane component serves every session route: moving from one
 * session to another keeps this state, and a reading from session A must never be subtracted from
 * session B's usage.
 */
export type CompactionWindow = {
  readonly sessionId: SessionId;
  readonly before: SessionUsage;
  readonly entriesBefore: number;
  readonly after: SessionUsage | null;
};

/**
 * The index of the summary row this press produced, or `undefined` while there is none.
 *
 * Only the *first* compaction row at or after the press belongs to it. A later row is a later
 * compaction — automatic, or another press — and its spend is not this one's.
 *
 * A turn of the operator's own ends the search: it means the press is in the past and whatever
 * compacts from there on was caused by something else. Without that, a press that wrote no summary
 * at all (a transcript with no cut) would stay open and charge the next compaction — the harness's
 * own threshold policy, say — with a spend that also includes the turn sent in between.
 */
export const compactionRow = (
  window: CompactionWindow | null,
  sessionId: SessionId,
  entries: readonly TranscriptEntry[],
): number | undefined => {
  if (window === null || window.sessionId !== sessionId) return undefined;
  for (let index = window.entriesBefore; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === "user") return undefined;
    if (entry?.kind === "compaction") return index;
  }
  return undefined;
};

/**
 * What the compaction in this window cost.
 *
 * Until `after` is captured the delta is read live, so the row fills in as the stream delivers the
 * summarizer's spend; after that it is a fixed number, which is the point of capturing it.
 */
export const compactionDelta = (
  window: CompactionWindow,
  usage: SessionUsage,
): SpendDelta => spendDelta(window.before, window.after ?? usage);

/**
 * The spend line under a summary: a measured delta, or the reason there is no number yet.
 *
 * A delta of zero tokens with no cost means nothing has been measured *yet* rather than that the
 * compaction was free, and the pane says so instead of printing `0 tokens` beside a summary that
 * plainly used the model.
 */
export const spendHeading = (delta: SpendDelta): string =>
  delta.tokens === 0 && delta.cost === undefined
    ? "Measuring spend…"
    : formatSpendDelta(delta);
