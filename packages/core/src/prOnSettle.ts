/**
 * The PR step a settled run takes without an operator (C18): which runs take it, and what a run that
 * opened nothing says about why.
 *
 * "Delegate a task, get back a PR" held only for a session someone ran `factory pr` on: the step had
 * one caller, the RPC member, so a Linear-, Sentry-, docs- or board-started run ended with a branch
 * and no PR. `SessionService` now runs the same step (`openPullRequest`, `./prStep`) when one of its
 * runs settles, for the sessions this module says declare it — the step's guards are unchanged, so
 * a settled run is measured, capped, pushed and recorded exactly as an operator's call would be.
 *
 * **Who declares it.** Provenance, read from what the index already holds, so a rebuild or a restart
 * changes nothing about the answer and no session row grows a flag:
 *
 * - **A card's run** opens its PR when the column it was started in *requires* one (`pr_link`, B4's
 *   `building`). The column is the declaration: its exit already demands a PR, and a run that
 *   settles with a change in it has nothing left to do but open it. A run of any other column — a
 *   specifier, a planner, the reviewer the PR itself starts — opens none, whatever started it,
 *   with one exception (C19): a run that continues the card's branch while another run of the card
 *   has an unmerged PR recorded from it — a fix run started in `review` after its feedback, a run
 *   sent back to `planning` — takes the step whatever its column, which adopts the card's PR and
 *   pushes its commits onto it. Its work is the card's change, and the PR is where it is reviewed.
 *   A reviewer run names a branch of its own (LOB-36), so it is never one of these.
 * - **A session a trigger opened** (LOB-162 — Linear, Jira, GitHub, Slack, Sentry, the generic
 *   webhook, the docs push and schedule) with no card opens its PR. Nobody is there to type
 *   `factory pr`, which is the gap this closes. "A trigger opened it" is read from the delivery the
 *   session was created for (its request id, `trigger:<delivery>`) as well as its actor
 *   (`trigger:<source>`): a replay copies its source's actor but is created for no delivery, so the
 *   actor alone would let a replay of a trigger's session open a second PR for the same work.
 * - **A person's session that asked for it** (F17): `factory run --open-pr`, the New session form's
 *   "Open a PR when done". The ask is `createSession`'s `openPrOnSettle`, committed to the session's
 *   log (`factory.settlePr`), so a restart or an index rebuild keeps it; a card's run never reads it,
 *   because its column is the declaration.
 * - **Nothing else.** A person's session (`factory run`, the dashboard's New session) that did not ask
 *   keeps its PR the person's call: the "Open pull request" control and `factory pr` open it. A fork
 *   or a replay is another lineage of work someone chose to try, so its PR is chosen too, whatever
 *   its source asked.
 *
 * Only a run that **finished** opens its PR. One that ended parked — an undecided approval, a card
 * blocked on its question — stopped to wait on a person; one an operator interrupted (C8), its budget
 * stopped (LOB-163) or whose model answer failed stopped short, and its branch holds whatever it had
 * reached. Neither opens anything until a later run settles done; a stopped run says why it opened
 * nothing (`notOpenedText`), and a person can still open the PR over it with `factory pr`.
 *
 * The PR opens at the first settle that finds a change. A later run of the same session — a steered
 * trigger session, a building run sent on — that commits more is pushed onto that PR by its settle
 * (F14): a session with its PR recorded still declares the step, and the step, finding the branch
 * past the commit the PR was published at, measures, caps and pushes the new tip and answers
 * `updated`. A settle with no new commit is answered from the log and reaches no forge; a PR that
 * merged takes nothing more, because a push to a merged PR's branch reaches nobody's review. A
 * refusal of the push says so in the same words as for an open, naming the PR it left as it was. A
 * *later run of the card* is another
 * session on the card's branch (C19, `./cardBranch`): it has no PR recorded yet, so its settle takes
 * the step, which adopts the card's PR — measured, capped and pushed, answered `already-open` — rather
 * than opening a second one.
 *
 * A session with no repo, a PR that merged, or a released workspace has nothing to publish, and a
 * working directory that is not its own checkout (a bare slug's plain directory, `diffSize`) is
 * skipped: the step there could not tell a change from none and would open a PR over nothing, which
 * an operator may ask for and a settled run must not.
 */
import { secretFindingsText } from "@repo/domain/PullRequest";
import type { RunEnding } from "@repo/harness";
import type { PullRequestStep } from "./pr";

/** What the decision reads about a session: its index row, and its card run's column if any. */
export type SettledRun = {
  readonly repo: string | null;
  /** The request id the session was created under; `trigger:<delivery>` for a trigger's session. */
  readonly requestId: string | null;
  readonly prUrl: string | null;
  /**
   * Whether the session's PR merged (`sessions.pr_merged_at`, C20): its branch is done, so a later
   * commit on it is pushed onto nothing (F14). Absent reads as no.
   */
  readonly prMerged?: boolean;
  readonly actor: string | null;
  readonly forkedFrom: string | null;
  readonly released: boolean;
  /**
   * Whether the run ended parked rather than done: an approval it asked for is undecided (D11), or
   * its card is blocked (a run's question parks it `needs_input`, B7). Such a run stopped to wait on
   * a person, so its branch is not the change it set out to make. A card blocked
   * `changes_requested` by a review of its PR (C21) is not waiting: the push is what answers it.
   */
  readonly waiting: boolean;
  /**
   * The requirement keys of the column the run was started in, under the card's pinned definition;
   * `undefined` for a session that is no card's run.
   */
  readonly columnRequires: ReadonlyArray<string> | undefined;
  /**
   * Whether the run continues a branch another run of its card already recorded an unmerged PR
   * from (C19, `./cardBranch`): the card's PR, which this run's commits are owed to whatever column
   * it was started in. Absent reads as no.
   */
  readonly continuesCardPr?: boolean;
  /**
   * Whether the person who started the session asked for its PR to open when a run settles (F17,
   * the log's `factory.settlePr`). Only a session that is no card's run reads it. Absent reads as no.
   */
  readonly openPrOnSettle?: boolean;
};

/**
 * The prefix a trigger's session carries on its request id and its actor. The request id is
 * `TriggerService`'s `sessionRequestIdOf` (spelled here because `TriggerService` depends on the
 * session service, which depends on this module; `prOnSettle.test.ts` holds the two together) and
 * the actor its `triggerActorOf`.
 */
export const TRIGGER_PREFIX = "trigger:";

/** The requirement a column declares when its exit needs a PR (docs/board.md B4, LOB-240). */
export const PR_LINK_REQUIREMENT = "pr_link";

/**
 * What a settled run's provenance says about its PR (see the module comment for the rules):
 * `declared` when it opens one now, `parked` when it declares one but ended waiting on a person (so
 * a later run that settles done opens it), and `undeclared` when it has none to open — a person's
 * session, a fork, a column that requires no PR, or nothing left to publish (no repo, a PR that
 * merged, a released workspace). A PR already recorded and unmerged is still declared (F14): the
 * step is what pushes a later commit onto it.
 */
export type SettleDeclaration = "declared" | "parked" | "undeclared";

export const settleDeclarationOf = (run: SettledRun): SettleDeclaration => {
  if (run.repo === null || run.released) return "undeclared";
  if (run.prUrl !== null && run.prMerged === true) return "undeclared";
  if (run.forkedFrom !== null) return "undeclared";
  const declares =
    run.columnRequires !== undefined
      ? run.columnRequires.includes(PR_LINK_REQUIREMENT) ||
        run.continuesCardPr === true
      : run.openPrOnSettle === true ||
        (run.actor !== null &&
          run.actor.startsWith(TRIGGER_PREFIX) &&
          run.requestId !== null &&
          run.requestId.startsWith(TRIGGER_PREFIX));
  if (!declares) return "undeclared";
  return run.waiting ? "parked" : "declared";
};

/** Whether a settled run opens its PR without an operator now (`settleDeclarationOf`). */
export const opensPullRequestOnSettle = (run: SettledRun): boolean =>
  settleDeclarationOf(run) === "declared";

/** Why the step opened nothing: an outcome that carries no link, or a failure it raised. */
export type NotOpened =
  | Exclude<PullRequestStep, { readonly url: string }>
  | {
      /** The run did not finish (`runEndingOf`), so the step was not run over its branch. */
      readonly outcome: "stopped";
      readonly ending: Exclude<RunEnding, "finished">;
    }
  | {
      readonly outcome: "failed";
      /** The failure's tag (`PrError`, `CredentialError`, `SessionError`). */
      readonly tag: string;
      readonly message: string;
    };

const STOPPED: Record<Exclude<RunEnding, "finished">, string> = {
  interrupted: "it was interrupted",
  budget: "its budget stopped it",
  failed: "its model answer failed",
};

/**
 * What one settle's PR step came to: a session that does not declare it (`undeclared`), one that
 * does but ended waiting on a person (`parked`), one this process no longer owns or whose directory
 * is not its own checkout, a branch still at the commit its last settle found even (`unchanged`), a
 * PR opened (or a card's PR adopted), a recorded PR the branch's new commits were pushed onto
 * (`updated`, F14) or whose branch is still where it was published (`up-to-date`), a reason it
 * opened none (`NotOpened`'s outcome), or a step that died or whose bookkeeping failed — the last
 * two logged as such.
 */
export type SettleDecision =
  | "undeclared"
  | "parked"
  | "not-owned"
  | "not-checkout"
  | "unchanged"
  | "opened"
  | "updated"
  | "up-to-date"
  | NotOpened["outcome"]
  | "died"
  | "bookkeeping-failed";

/**
 * The sentence a settled run's transcript and its card carry when the step opened no PR. Written by
 * the control plane, never by the model, so it names the step's own numbers and nothing a token or a
 * URL could leak through: a failure's message is the typed error's, which already omits both.
 */
export const notOpenedText = (reason: NotOpened, pr?: string): string => {
  // A session whose PR is already open (F14) was refused a push onto it, not an open.
  const head =
    pr === undefined
      ? "the run settled and the PR step opened no PR"
      : `the run settled and the PR step pushed nothing to ${pr}`;
  const then = pr === undefined ? "open the PR" : "push it (`factory pr`)";
  switch (reason.outcome) {
    case "no-change":
      return `${head}: the branch has no change against its base`;
    case "over-cap":
      return `${head}: the branch's diff is over the cap (${reason.measured} ${reason.limit}, at most ${reason.cap})`;
    case "non-fast-forward":
      return `${head}: the remote's ${reason.head} has commits this branch does not, and the push is never forced; integrate them, then ${then}`;
    case "secret-found":
      return `${head}: secret_found: the branch's commits add a secret — ${secretFindingsText(reason)} — so nothing was pushed; take it out of the branch's history (rewrite the commits that add it), then ${then}`;
    case "stopped":
      return pr === undefined
        ? `the run settled without finishing, so no PR was opened over its branch: ${STOPPED[reason.ending]}; a run that finishes opens it, or \`factory pr\` does`
        : `the run settled without finishing, so nothing was pushed to ${pr}: ${STOPPED[reason.ending]}; a run that finishes pushes it, or \`factory pr\` does`;
    case "failed":
      return `${head}: ${reason.tag}: ${reason.message}`;
  }
};
