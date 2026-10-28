/**
 * A card's branch (C19): which branch a later run of a card continues, so a card's runs share one
 * branch and one PR instead of each cutting a fresh `factory/<session-id>` from the base.
 *
 * D10 gives every session its own branch, and B12 gave every run of a card its own worktree — so a
 * second building run, or a run started in `review` to address its findings, started from `main` and
 * could not see the change the first run made, and had no PR either, so the card could never leave
 * `building` again. The card's work is one change, so it lives on one branch:
 *
 * - **The card's branch is its first change run's.** A *change run* is one started in a column whose
 *   exit asks for the change itself — `pr_link` or `non_empty_diff` (B4's `building`): that is the
 *   run that cuts the branch the card's PR is opened from. A run of a column before it (a specifier,
 *   a planner) keeps a branch of its own, as before: nothing it does is the card's change.
 * - **It stays the card's while a run still holds it.** A branch is torn down with the last workspace
 *   bound to it (`SessionService.releaseWorkspace` keeps a branch another unreleased session is bound
 *   to), so a card whose every run was released — finished, merged, discarded — has no branch left to
 *   continue, and its next change run cuts a fresh one, which becomes the card's.
 * - **Every later run of the card binds it** (the caller-named branch path, LOB-197), whatever column
 *   it was started in: a second building run, a run in `review`, a run sent back to `planning`. A run
 *   that names its own branch (a review trigger's `factory/review-<n>-<sha>`) keeps it, and one that
 *   names a base other than the one the card's branch was cut from starts afresh from that base.
 *
 * Derived from what the index already holds — the card's `task_runs`, their sessions' bindings and
 * releases, and the pinned definition's columns — rather than stored on the card: a rebuild re-derives
 * every input from the logs, and no card row grows a column that could disagree with them.
 *
 * The worktree is the agent's, and git checks a branch out in one worktree at a time: the newest
 * run's worktree takes it over, and the earlier run's worktree is left where it was on a detached
 * HEAD (`./workspace`), its files untouched. Its commits from then on would land on that detached
 * HEAD and never reach the card's branch or PR, so neither way of making one is let through:
 *
 * - **A start while a run on the branch is still going is refused** (`busy`, naming that run): the
 *   hand-over would detach it mid-turn. A board pinned to a version with no caps (default versions
 *   1–4) can otherwise start a second run on a card whose first is busy. A run owned by another API
 *   process is seen through its presence lease and the activity index that process writes (F13).
 * - **A message to a run whose worktree was handed over is refused** (`invalid_input`, naming the
 *   later run that took the branch): steering it would reopen a turn on the detached HEAD. The card's
 *   newest run is the one to send to, or a new run started on the card, which continues the branch.
 */
import type { BoardColumn } from "@repo/domain/Task";
import {
  NON_EMPTY_DIFF_REQUIREMENT,
  PR_LINK_REQUIREMENT,
} from "@repo/domain/Task";

/** One run of the card, as the index holds it, in start order. */
export type CardRun = {
  readonly sessionId: string;
  /** The column the run was started in (`task_runs.column`). */
  readonly column: string;
  readonly repo: string | null;
  readonly baseRef: string | null;
  /** The caller-named branch (LOB-197); `null` means `factory/<session-id>`. */
  readonly branch: string | null;
  /** Whether its workspace was released (LOB-268). */
  readonly released: boolean;
};

/** The branch a later run of the card continues, and the run it was cut for. */
export type CardBranch = {
  readonly sessionId: string;
  readonly branch: string;
  readonly baseRef: string | null;
  /** The card's unreleased runs bound to the branch, oldest first: the last one holds it now. */
  readonly holders: ReadonlyArray<string>;
};

/** The branch a run is on: the one it named, or D10's `factory/<session-id>`. */
export const branchOfRun = (
  run: Pick<CardRun, "sessionId" | "branch">,
): string => run.branch ?? `factory/${run.sessionId}`;

/** The columns whose runs make the card's change: those whose exit asks for it (module doc). */
export const changeColumnsOf = (
  columns: ReadonlyArray<BoardColumn>,
): ReadonlySet<string> =>
  new Set(
    columns
      .filter((column) =>
        column.requires.some(
          (requirement) =>
            requirement.key === PR_LINK_REQUIREMENT ||
            requirement.key === NON_EMPTY_DIFF_REQUIREMENT,
        ),
      )
      .map((column) => column.name),
  );

/**
 * The branch a new run of the card in `repo` continues, or `undefined` when it cuts its own: the
 * first change run's branch in that repository that an unreleased run of the card is still bound to
 * (module doc). `runs` are oldest first.
 */
export const cardBranchOf = (
  runs: ReadonlyArray<CardRun>,
  changeColumns: ReadonlySet<string>,
  repo: string,
): CardBranch | undefined => {
  const inRepo = runs.filter((run) => run.repo === repo);
  const held = new Set(
    inRepo.filter((run) => !run.released).map((run) => branchOfRun(run)),
  );
  const first = inRepo.find(
    (run) => changeColumns.has(run.column) && held.has(branchOfRun(run)),
  );
  if (first === undefined) return undefined;
  const branch = branchOfRun(first);
  return {
    sessionId: first.sessionId,
    branch,
    baseRef: first.baseRef,
    holders: inRepo
      .filter((run) => !run.released && branchOfRun(run) === branch)
      .map((run) => run.sessionId),
  };
};
