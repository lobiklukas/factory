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
 *   specifier, a planner, the reviewer the PR itself starts — opens none, whatever started it.
 * - **A session a trigger opened** (`trigger:<source>`, LOB-162 — Linear, Jira, GitHub, Slack,
 *   Sentry, the generic webhook, the docs push and schedule) with no card opens its PR. Nobody is
 *   there to type `factory pr`, which is the gap this closes.
 * - **Nothing else.** A person's session (`factory run`, the dashboard's New session) keeps its PR the
 *   person's call: the "Open pull request" control and `factory pr` open it. A fork or a replay is
 *   another lineage of work someone chose to try, so its PR is chosen too.
 *
 * A run that ended parked — an undecided approval, a card blocked on its question — stopped to wait on
 * a person rather than finishing, so it opens nothing until a later run settles done.
 *
 * A session with no repo, a PR already recorded, or a released workspace has nothing to open, and a
 * working directory that is not its own checkout (a bare slug's plain directory, `diffSize`) is
 * skipped: the step there could not tell a change from none and would open a PR over nothing, which
 * an operator may ask for and a settled run must not.
 */
import type { PullRequestStep } from "./pr";

/** What the decision reads about a session: its index row, and its card run's column if any. */
export type SettledRun = {
  readonly repo: string | null;
  readonly prUrl: string | null;
  readonly actor: string | null;
  readonly forkedFrom: string | null;
  readonly released: boolean;
  /**
   * Whether the run ended parked rather than done: an approval it asked for is undecided (D11), or
   * its card is blocked (a run's question parks it `needs_input`, B7). Such a run stopped to wait on
   * a person, so its branch is not the change it set out to make.
   */
  readonly waiting: boolean;
  /**
   * The requirement keys of the column the run was started in, under the card's pinned definition;
   * `undefined` for a session that is no card's run.
   */
  readonly columnRequires: ReadonlyArray<string> | undefined;
};

/** The requirement a column declares when its exit needs a PR (docs/board.md B4, LOB-240). */
export const PR_LINK_REQUIREMENT = "pr_link";

/** Whether a settled run opens its PR without an operator. See the module comment for the rules. */
export const opensPullRequestOnSettle = (run: SettledRun): boolean => {
  if (run.repo === null || run.prUrl !== null || run.released) return false;
  if (run.waiting) return false;

  if (run.forkedFrom !== null) return false;
  if (run.columnRequires !== undefined)
    return run.columnRequires.includes(PR_LINK_REQUIREMENT);
  return run.actor !== null && run.actor.startsWith("trigger:");
};

/** Why the step opened nothing: an outcome that carries no link, or a failure it raised. */
export type NotOpened =
  | Exclude<PullRequestStep, { readonly url: string }>
  | {
      readonly outcome: "failed";
      /** The failure's tag (`PrError`, `CredentialError`, `SessionError`). */
      readonly tag: string;
      readonly message: string;
    };

/**
 * The sentence a settled run's transcript and its card carry when the step opened no PR. Written by
 * the control plane, never by the model, so it names the step's own numbers and nothing a token or a
 * URL could leak through: a failure's message is the typed error's, which already omits both.
 */
export const notOpenedText = (reason: NotOpened): string => {
  const head = "the run settled and the PR step opened no PR";
  switch (reason.outcome) {
    case "no-change":
      return `${head}: the branch has no change against its base`;
    case "over-cap":
      return `${head}: the branch's diff is over the cap (${reason.measured} ${reason.limit}, at most ${reason.cap})`;
    case "non-fast-forward":
      return `${head}: the remote's ${reason.head} has commits this branch does not, and the push is never forced; integrate them, then open the PR`;
    case "failed":
      return `${head}: ${reason.tag}: ${reason.message}`;
  }
};
