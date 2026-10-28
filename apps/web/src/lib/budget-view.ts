import type { TranscriptEntry } from "@repo/domain/Session";
import { hasTranscriptRow } from "./transcript-view";

/**
 * The "Raise cap" action on a budget stop (C23): where it is offered, what it opens with, and what
 * it sends. Pure, so the cases a screenshot cannot settle (a stop a later message has moved past, a
 * cap typed at or below what is spent) are unit cases.
 */

/**
 * The budget stop entry the action sits on, or `undefined` when none is offered.
 *
 * The stream carries the stop as a `budget` transcript entry and does not update the session's cap
 * document after the attach snapshot, so the action is offered where the transcript says the cap is
 * what the session is waiting on: the newest row is a stop. A stop the attach snapshot already shows
 * as raised (its budget reports no stop) arrives in `raised` as the view's `settledStop`; a raise made
 * elsewhere after the attach is the one case the pane cannot see, and the server then answers a
 * second raise harmlessly. A message sent after the stop is a run that was either let
 * through (the cap was raised, here or elsewhere) or stopped again with a stop of its own, so a stop
 * with anything after it is history. `raised` is the stop this pane already raised the cap for: a raise
 * leaves the stop in the transcript, and the action must not offer to do it twice.
 */
export const raiseCapOffer = (
  entries: readonly TranscriptEntry[],
  raised: ReadonlySet<string>,
): string | undefined => {
  const newest = entries.findLast(hasTranscriptRow);
  return newest !== undefined &&
    newest.kind === "budget" &&
    !raised.has(newest.id)
    ? newest.id
    : undefined;
};

/**
 * What the cap field opens with: twice the cap that stopped the run, so a press of the button
 * is a reasonable raise, never the same cap again. Blank when the session's cap is not known.
 */
export const suggestedCap = (cap: number | undefined): string =>
  cap === undefined ? "" : String(Number((cap * 2).toPrecision(6)));

/** The cap field's text as `setSessionBudget`'s payload carries it. */
export type RaiseCapAttempt =
  | { readonly ok: true; readonly budget: number }
  | { readonly ok: false; readonly reason: string };

/**
 * `spent` is what the session has spent so far (the live usage total, a floor of what the cap
 * measures): a cap at or below it would stop the next run before its first request, which is not
 * a raise, so it is refused here rather than committed and then stopped at once.
 */
export const raiseCapAttempt = (
  typed: string,
  spent: number,
): RaiseCapAttempt => {
  const text = typed.trim();
  const amount = Number(text);
  if (text === "" || !Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      reason: `A cap is a positive amount of US dollars, like 2.50; "${text}" is not one`,
    };
  }
  if (amount <= spent) {
    return {
      ok: false,
      reason: `A cap of $${amount} is already reached by the $${spent.toFixed(4)} spent, so the run would stop again at once`,
    };
  }
  return { ok: true, budget: amount };
};
