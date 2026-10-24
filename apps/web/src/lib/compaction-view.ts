import type {
  SessionId,
  SessionTask,
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
 * The index of the first summary a press could have written, or `undefined` when there is none yet.
 *
 * Only the *first* compaction row at or after the press belongs to it. A later row is a later
 * compaction — automatic, or another press — and it is not this one's answer.
 *
 * A turn of the operator's own ends the search: it means the press is in the past and whatever
 * compacts from there on was caused by something else. Without that, a press that wrote no summary
 * at all (a transcript with no cut) would stay open and claim the next compaction — the harness's
 * own threshold policy, say — as its answer.
 *
 * Both the spend attribution (`compactionRow`) and the settle verdict (`settleCompaction`) scan
 * through here, so the pane can never show "nothing to compact" above a row it has just charged
 * this press for.
 */
const summaryFrom = (
  entries: readonly TranscriptEntry[],
  from: number,
): number | undefined => {
  for (let index = Math.max(0, from); index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === "user") return undefined;
    if (entry?.kind === "compaction") return index;
  }
  return undefined;
};

/**
 * The index of the summary row this press produced, or `undefined` while there is none.
 *
 * `undefined` means "no row of this press's", not "the press failed": a transcript with no cut
 * writes no summary at all, which is `settleCompaction`'s question to answer.
 */
export const compactionRow = (
  window: CompactionWindow | null,
  sessionId: SessionId,
  entries: readonly TranscriptEntry[],
): number | undefined =>
  window === null || window.sessionId !== sessionId
    ? undefined
    : summaryFrom(entries, window.entriesBefore);

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

/**
 * What a press of Compact has come to, as the pane shows it (LOB-224).
 *
 * The RPC answers with a task id and nothing else — pi-durable keeps the newest `keepRecentTokens`
 * verbatim, so a transcript with no cut settles the task and writes **no** `compaction` entry, and
 * a pane that waited for an entry would spin forever. So the outcome is read from two things the
 * stream does deliver: the session's live-task list (`SessionTask`, where a settled task is absent
 * rather than carried with a terminal status — `packages/domain/src/Session.ts:152`) and the
 * transcript.
 *
 * `tasks` in `requested` is the task projection the pane last decided against, and its **identity**
 * is the load-bearing part: the answer to `compactSession` and the stream are two paths, so the
 * first list the pane holds after the press can still predate the task's admission. A list that
 * has not moved proves nothing; a *newer* list without the task does.
 */
export type CompactionSettle =
  | { readonly state: "idle" }
  | {
      readonly state: "requested";
      readonly sessionId: SessionId;
      readonly taskId: string;
      /** Where the transcript ended at the press: the summary, if any, is at or after it. */
      readonly entriesBefore: number;
      readonly tasks: readonly SessionTask[];
    }
  | {
      readonly state: "settled-compacted";
      readonly sessionId: SessionId;
      readonly entriesBefore: number;
    }
  | {
      readonly state: "settled-nothing";
      readonly sessionId: SessionId;
      readonly entriesBefore: number;
    };

/**
 * A press whose task id the control plane has answered, and the list the pane held when it did.
 *
 * `entriesBefore` is read at the press, not here: the summary the task writes arrives later, and an
 * entry that was already on screen is an older compaction's.
 */
export const requestedCompaction = (input: {
  readonly sessionId: SessionId;
  readonly taskId: string;
  readonly entriesBefore: number;
  readonly tasks: readonly SessionTask[];
}): CompactionSettle => ({ state: "requested", ...input });

/** The settle state as it applies to one session: a press belongs to the session it was made in. */
export const settleFor = (
  settle: CompactionSettle,
  sessionId: SessionId,
): CompactionSettle =>
  settle.state === "idle" || settle.sessionId === sessionId
    ? settle
    : { state: "idle" };

/**
 * Advances what a press has come to, given the session's current task list and transcript.
 *
 * Returns the same object when nothing changed, so the pane can hold this in state and reduce from
 * every stream event without re-rendering for its own sake.
 *
 * - `requested` stays `requested` while the task is live. A projection that does not carry it is
 *   only evidence once it is a **new** projection: the first list after the press may simply be the
 *   one from before the task was admitted.
 * - Once the task has left the list, the transcript decides: a summary this press could have written
 *   means `settled-compacted`, otherwise `settled-nothing`.
 * - `settled-nothing` is not final. A summary that lands after the task left the graph still belongs
 *   to the press (a busy session's summary is placed at its next boundary, so the entry can trail the
 *   task by a turn), and the pane must not keep saying nothing above a row it is charging to the
 *   press. An operator's own turn closes that window — the same rule the spend attribution uses.
 * - `settled-compacted` is final: a later compaction is a later press. Every settled state drops
 *   back to `idle` when asked about another session, because one pane component serves every route.
 */
export const settleCompaction = (
  settle: CompactionSettle,
  input: {
    readonly sessionId: SessionId;
    readonly tasks: readonly SessionTask[];
    readonly entries: readonly TranscriptEntry[];
  },
): CompactionSettle => {
  const current = settleFor(settle, input.sessionId);
  if (current.state === "idle" || current.state === "settled-compacted")
    return current;
  const summary = summaryFrom(input.entries, current.entriesBefore);
  if (current.state === "settled-nothing")
    return summary === undefined
      ? current
      : {
          state: "settled-compacted",
          sessionId: current.sessionId,
          entriesBefore: current.entriesBefore,
        };
  if (input.tasks.some((task) => task.id === current.taskId))
    return input.tasks === current.tasks
      ? current
      : { ...current, tasks: input.tasks };
  if (input.tasks === current.tasks) return current;
  return summary === undefined
    ? {
        state: "settled-nothing",
        sessionId: current.sessionId,
        entriesBefore: current.entriesBefore,
      }
    : {
        state: "settled-compacted",
        sessionId: current.sessionId,
        entriesBefore: current.entriesBefore,
      };
};
