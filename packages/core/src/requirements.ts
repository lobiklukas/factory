/**
 * A column's exit requirements, checked against what the card's runs recorded (docs/board.md B5,
 * B8; LOB-80, part 3 of LOB-16).
 *
 * `requires[]` is declared per column and checked on exit: a card may always move *into* a column,
 * and the gate is what leaves it. This module holds the checks themselves, as pure functions of the
 * evidence, so `TaskService.move` decides only *when* to check and the rules can be read (and
 * tested) without a database.
 *
 * **Which keys are checked.** Only the keys in `CHECKED_REQUIREMENTS`: `verified`, the one B8
 * promotes from a PR body artifact into a condition of the move, `building`'s `non_empty_diff`
 * and `pr_link` (LOB-240), whose evidence the PR step already records, and `review`'s
 * `review_verdict` (LOB-241), whose evidence is the reviewer run's `factory.review` (LOB-36). The
 * other keys the default pipeline declares are not checked here, and each for a stated reason:
 * `human_move` and `human_merge` label B5's human gates, which `TaskService` enforces by actor on a
 * move whose transition names a `gate` (the key itself is read by nothing);
 * `spec_doc`, `plan_doc` and `run_completed` have no recorded artifact to check yet, and refusing
 * every move on a key nothing can satisfy would turn the pipeline off rather than gate it.
 * A key gains a checker when its evidence is recorded. A reader is told which are which:
 * `./boardConfig`'s `describeDefinition` marks each declared key `checked` from this set (LOB-270).
 *
 * **What `non_empty_diff` and `pr_link` mean.** Both read the card's branch and PR: the branch of
 * the card's *latest* run — the newest `task_runs` row — for the reason `verified` reads the newest
 * call. Since C19 a card's later runs continue its first change run's branch (`./cardBranch`), so
 * the latest run's branch *is* the card's, and the card's PR is the one recorded from it: the latest
 * run's own `factory.pr`, or an earlier run's whose `head` is that branch — a follow-up run that
 * opened no PR of its own (it settled parked, or in a column that opens none) still leaves the card
 * with its PR. An earlier run's PR stands for the card only while the branch is where that PR was
 * last published: the newest such record's `commit` (the commit its step measured and pushed) has to
 * be the branch's tip in the registered checkout. A follow-up run that committed and never published
 * — its cap refused the diff, its push was refused, it was interrupted, or it is still working — has
 * moved the branch past the PR, and the move is refused until its PR step pushes (`factory pr`). A
 * record with no `commit` (written before C19) or a tip the checkout cannot resolve is unknown, and
 * refused the same way. A PR an older run opened from another branch (a card from before C19, or one
 * whose branch was released and cut afresh) is a PR of a change a later run replaced, and does not
 * count. `non_empty_diff` is met when that branch has at least one
 * changed file against its base, by the PR step's own measurement (`git diff --numstat
 * base...head`, LOB-196): committed work only, three-dot from the merge base, against the same base
 * the step picks (`measureBaseOf`, C17 — the forge's fetched tip when the run was cut from it), so a
 * branch the board measures as empty is one the step would publish as empty. The two do not agree everywhere, by
 * design. A branch that could not be measured — a run bound to no repository, a repository with no
 * local checkout, a ref git cannot resolve — is not a pass here, as "nothing could check this" is not
 * one for `verified`; the PR step, given a session directory that is no checkout of its own, skips
 * its cap and opens the PR anyway (`diffSize`). And the board measures from the repository's
 * registered `local_path`, the step from the session's worktree: they read the same refs while the
 * worktree is a linked worktree of that checkout, but a `local_path` re-registered after the run was
 * cut, or a run cut before any checkout was registered, leaves the branch unfound from `local_path`,
 * and the move is refused as unmeasured although the step could open the PR. **A known limit under
 * D3/D4:** this check reads git refs from a checkout on the control plane's own disk. When the
 * worktree moves into the sandbox, the measurement has to follow it (or read the recorded PR's own
 * diff), or `non_empty_diff` refuses every move. `pr_link` is met
 * when a `factory.pr` document with a link (LOB-177) is the card's PR as above: the record the PR
 * step commits, not the index's `pr_url` column a rebuild derives from it.
 *
 * **What `review_verdict` means (LOB-241).** It reads the card's *review runs* — the runs whose log
 * records a `factory.review` target, which the review trigger opens one per head of a PR — and
 * judges exactly one: the review of the card's PR at the head that PR was last reported at.
 *
 * - *The card's PR* is the newest PR a run of the card's change recorded (`factory.pr`), so a fix-up
 *   run that opens a new PR is not passed on the old PR's review; a card none of whose runs recorded
 *   one (a version with no `pr_link`) is judged on its newest review's PR.
 * - *The head it was last reported at* is `review_heads`' row for that PR, which every review
 *   delivery writes before its run is opened — a replay included, since a replay opens no run. It is
 *   not "the newest review run": a push back to a head the PR had before (a force-push undoing one)
 *   replays that head's old run and leaves another head's run the newest, and the row is what says
 *   the PR is at the old head again. With no row (a PR from before the table, or a review run opened
 *   outside the trigger) the newest review run of the PR is judged.
 *
 * It is met when that run recorded a verdict of `pass` on its head. It is not met, and the refusal
 * says which, when no review ran (and where review runs come from: a deployment GitHub cannot deliver
 * `pull_request` webhooks to has none, so its cards cannot leave `review` for `done`); when the
 * card's PR has no review while another PR's does; when no review run has a target for the reported
 * head yet (its run is still being opened, or its delivery was skipped because the head could not be
 * fetched); when that run has recorded no verdict yet (it is still reviewing, or it died before it
 * called the tool), naming the head under review; when the verdict is `fail`, naming the failing
 * dimensions; and when a `pass` was found `stale` as it was posted. Another head's pass never stands
 * in for the reported head's missing or failing verdict: a stale approval does not survive a push at
 * the gate. **The window it cannot see** is a push the trigger has not been told of yet — between
 * GitHub's push and its `synchronize` delivery — when the reported head is still the previous one.
 * Gating on the PR's live head would close it, at the cost of a forge read on every move.
 *
 * **What `verified` means.** The card's change is the newest `verify` call, over all of the card's
 * runs, that measured a change. "Newest" is by when the call's result was written (the tool
 * result's timestamp), not by which run started last: a person can resume an older run with a
 * `send`, and its later call is the newer verification. A call that found no changed path (a
 * reviewer's run in a fresh worktree) or could not measure one (`VerifyUnmeasured`) says nothing
 * about the change, so it neither satisfies the requirement nor wipes out the call before it. A call
 * that left no record (blocked, or crashed) is different: it may have been over a newer change, and
 * what it found is unknown, so when it is newer than every measured call the requirement is unmet
 * and the refusal says so — the same rule LOB-79's PR evidence follows, rather than quietly
 * falling back to an older pass. That call's changed paths name
 * the surfaces the change touched (`surfaceOf`; `REPO_SURFACE` for a path in no package), and the
 * requirement is met when every one of them has a `VerifyRan` that exited 0 — the surface's own, or
 * the repo's declared command, which runs once for `REPO_SURFACE` and covers every surface — and no
 * result of that call failed. A passing verification of a *different* surface does not count: a
 * card whose earlier run verified `web` and whose latest change is in `api` is refused, naming `api`.
 *
 * The newest call rather than every call: B12 gives each run its own worktree, so a later run's
 * change is what the card carries now, and a requirement that remembered every surface ever touched
 * would hold a card forever over a change a later run abandoned. What it cannot see is a change made
 * *after* the newest call (LOB-79's coverage check is the PR's view of that); the gate reads what was
 * verified, not what the branch holds at the moment of the move. Likewise a call a run records while
 * the move is in flight (`TaskService` reads the logs before it locks the card) is concurrent with
 * the move, and the move is ordered before it.
 *
 * **Every touched surface must be verifiable.** A surface with no `verify-<surface>` skill, and a
 * path outside every package (`REPO_SURFACE`), record `VerifyNoEvidence`, which never passes. So a
 * repository whose board gates on `verified` must either declare its verify command
 * (`commands.verify` in `.factory/config`, which runs once and covers every surface) or carry a
 * skill for every surface its changes touch; otherwise such a card can only leave `review` for
 * `canceled`. That is deliberate — "nothing could check this" is not a pass — and the refusal names
 * the remedy (`VERIFIABLE_REMEDY`) whenever a missing verification is the reason.
 */
import type { BoardColumn, ColumnRequirement } from "@repo/domain/Task";
import {
  NON_EMPTY_DIFF_REQUIREMENT,
  PR_LINK_REQUIREMENT,
  REVIEW_VERDICT_REQUIREMENT,
  VERIFIED_REQUIREMENT,
} from "@repo/domain/Task";
import {
  type RecordedReview,
  REPO_SURFACE,
  surfaceOf,
  surfacesOf,
  type TimedVerifyCall,
  type VerifyReport,
  type VerifyResult,
} from "@repo/harness";

/** The requirement keys this module can check. Every other key is not checked yet (module doc). */
export const CHECKED_REQUIREMENTS: ReadonlySet<string> = new Set([
  VERIFIED_REQUIREMENT,
  NON_EMPTY_DIFF_REQUIREMENT,
  PR_LINK_REQUIREMENT,
  REVIEW_VERDICT_REQUIREMENT,
]);

/**
 * The default pipeline's human-gate keys (B5). Nothing reads them: what makes a move a person's is
 * the transition's `gate` (`TaskService.move` refuses a run actor crossing one), and these keys only
 * label the column that has one. An authored version may declare one only on a column whose moves
 * out name a gate (`./boardDefine`), so the label never promises a gate nothing enforces.
 */
export const HUMAN_GATE_REQUIREMENTS: ReadonlySet<string> = new Set([
  "human_move",
  "human_merge",
]);

/**
 * The keys a definition may declare that nothing checks yet (module doc): the default pipeline's
 * `spec_doc`, `plan_doc` and `run_completed`, whose artifacts are not recorded, and the human-gate
 * labels (`HUMAN_GATE_REQUIREMENTS`), whose gate is the transition's `gate`, not the key. A reader is
 * told they are unchecked (`describeDefinition`).
 */
export const UNCHECKED_REQUIREMENTS: ReadonlySet<string> = new Set([
  "spec_doc",
  "plan_doc",
  "run_completed",
  ...HUMAN_GATE_REQUIREMENTS,
]);

/**
 * Every key the factory knows (D4): the checked ones and the declared-but-unchecked ones. An authored
 * definition version (`defineBoard`) may declare only these — any other key is a typo, or a gate
 * nothing will ever hold a card to that a reader of the board would take for one that is.
 */
export const KNOWN_REQUIREMENTS: ReadonlySet<string> = new Set([
  ...CHECKED_REQUIREMENTS,
  ...UNCHECKED_REQUIREMENTS,
]);

/**
 * One run of the card and the `verify` calls its log holds, oldest first — a call that left no
 * record included, as `undefined` (`readVerifyCalls`) — and the PR link its `factory.pr` document
 * records, when it opened one.
 */
export type RunEvidence = {
  readonly sessionId: string;
  readonly calls: readonly TimedVerifyCall[];
  /** The branch the run is on, when it is bound to a repository. */
  readonly branch?: string;
  readonly prUrl?: string;
  /** The branch its recorded PR was opened from (`factory.pr`'s `head`). */
  readonly prHead?: string;
  /** The commit its recorded PR was published at (`factory.pr`'s `commit`, C19). */
  readonly prCommit?: string;
};

/**
 * The latest run's branch against its base, as the PR step measures it (module doc): how many files
 * it changes, or why nothing could be measured.
 */
export type BranchDiff =
  | {
      readonly _tag: "measured";
      readonly sessionId: string;
      readonly base: string;
      readonly head: string;
      readonly files: number;
    }
  | {
      readonly _tag: "unmeasured";
      readonly sessionId: string;
      readonly reason: string;
    };

/** One review run of the card (LOB-36) and the review its `factory.review` document records. */
export type ReviewRunEvidence = {
  readonly sessionId: string;
  readonly review: RecordedReview;
};

/**
 * The head one of the card's PRs was last reported at by a `pull_request` delivery (`review_heads`,
 * LOB-241): its page, its API resource when the delivery named one, and the head.
 */
export type ReportedHead = {
  readonly url: string;
  readonly apiUrl?: string;
  readonly head: string;
};

/**
 * Everything a move's checked requirements read: the card's runs, oldest first, and the latest
 * one's branch diff — measured only when the move checks `non_empty_diff` and the card has a run —
 * its review runs, oldest first by when each started (absent: it has none), and the head each of
 * its PRs was last reported at (absent: none was).
 */
export type CardEvidence = {
  readonly runs: readonly RunEvidence[];
  readonly diff?: BranchDiff;
  readonly reviews?: readonly ReviewRunEvidence[];
  readonly reviewHeads?: readonly ReportedHead[];
  /**
   * The commit the latest run's branch is at in the registered checkout (C19), read when `pr_link`
   * would stand on an earlier run's PR; absent when it was not read or does not resolve.
   */
  readonly branchTip?: string;
};

/**
 * What a refusal adds when the reason is a surface nothing could verify (module doc): the two ways
 * a repository makes every surface verifiable.
 */
export const VERIFIABLE_REMEDY =
  'a board that gates on "verified" needs every surface a change touches to be verifiable: declare the repo\'s verify command (commands.verify in .factory/config) or add a .pi/skills/verify-<surface>/ driver';

/** A requirement's verdict: met, or not met and why, in words a refusal can carry verbatim. */
export type RequirementVerdict =
  | { readonly met: true }
  | { readonly met: false; readonly reason: string };

/**
 * The requirements leaving `column` for `to` has to check: the column's checked keys, in the order
 * it declares them. A move into `canceled` checks none — abandoning a card is always allowed, and a
 * card nobody will finish cannot be asked to prove the work it is abandoning.
 */
export const exitRequirements = (
  column: BoardColumn | undefined,
  to: string,
): ReadonlyArray<ColumnRequirement> =>
  column === undefined || to === "canceled"
    ? []
    : column.requires.filter((requirement) =>
        CHECKED_REQUIREMENTS.has(requirement.key),
      );

/** Whether a result is a verification that ran to exit 0. */
const passed = (result: VerifyResult): boolean =>
  result._tag === "VerifyRan" && result.exitCode === 0;

/** A failed result in one phrase: which surface, and what the record says went wrong. */
const failure = (result: VerifyResult): string => {
  switch (result._tag) {
    case "VerifyRan":
      return `${result.surface}: exit ${result.exitCode} (${result.command} in ${result.directory})`;
    case "VerifyUnrunnable":
      return `${result.surface}: could not run (${result.code}): ${result.message}`;
    case "VerifyNoEvidence":
      return `${result.surface}: no verification (${result.message})`;
  }
};

/**
 * Whether `result` speaks for `surface`: its own, or the repo's declared command, which runs once
 * for `REPO_SURFACE` and is told every surface the change named.
 */
const speaksFor = (result: VerifyResult, surface: string): boolean =>
  result.surface === surface ||
  (result._tag !== "VerifyNoEvidence" &&
    result.source === "workspace" &&
    result.surface === REPO_SURFACE);

/** The surfaces a report's changed paths touch, `REPO_SURFACE` last when a path is in no package. */
const touched = (report: VerifyReport): readonly string[] => [
  ...surfacesOf(report.changed),
  ...(report.changed.some((path) => surfaceOf(path) === undefined)
    ? [REPO_SURFACE]
    : []),
];

/**
 * The card's change: the newest call, over every run and by when it was written, that measured at
 * least one changed path — or the newest call that left no record, when that is newer (module doc).
 */
const latestChange = (
  runs: readonly RunEvidence[],
):
  | {
      readonly _tag: "change";
      readonly sessionId: string;
      readonly report: VerifyReport;
    }
  | { readonly _tag: "unrecorded"; readonly sessionId: string }
  | undefined => {
  // A stable sort: calls written in the same millisecond keep run order, then call order.
  const calls = runs
    .flatMap((run) =>
      run.calls.map((call) => ({ sessionId: run.sessionId, call })),
    )
    .sort((a, b) => a.call.at - b.call.at);
  for (const { sessionId, call } of calls.reverse()) {
    const record = call.record;
    if (record === undefined) return { _tag: "unrecorded", sessionId };
    if (record._tag === "VerifyReport" && record.changedCount > 0)
      return { _tag: "change", sessionId, report: record };
  }
  return undefined;
};

/** The `verified` requirement over a card's runs, oldest run first (module doc). */
export const verifiedVerdict = (
  runs: readonly RunEvidence[],
): RequirementVerdict => {
  const change = latestChange(runs);
  if (change?._tag === "unrecorded")
    return {
      met: false,
      reason: `run ${change.sessionId}'s latest verify call left no record (it was blocked or crashed), so what it verified is unknown: verify the change again`,
    };
  if (change === undefined) {
    const calls = runs.reduce((count, run) => count + run.calls.length, 0);
    return {
      met: false,
      reason:
        runs.length === 0
          ? "the card has no runs, so nothing verified its change"
          : `none of the card's ${runs.length} run(s) recorded a verify call over a change (${calls} call(s) recorded)`,
    };
  }
  const { report, sessionId } = change;
  const failed = report.results.filter((result) => !passed(result));
  // A surface is covered by a passing result that speaks for it; one a failed result already
  // speaks for is named by that failure rather than a second time as uncovered.
  const uncovered = touched(report).filter(
    (surface) =>
      !report.results.some(
        (result) => passed(result) && speaksFor(result, surface),
      ) && !failed.some((result) => speaksFor(result, surface)),
  );
  if (failed.length === 0 && uncovered.length === 0) return { met: true };
  const verified = report.results
    .filter(passed)
    .map((result) => result.surface);
  const problems = [
    ...failed.map(failure),
    ...uncovered.map(
      (surface) =>
        `${surface}: no passing verification of it${verified.length === 0 ? "" : ` (the passing ones cover ${verified.join(", ")})`}`,
    ),
  ];
  const unverifiable = failed.some(
    (result) => result._tag === "VerifyNoEvidence",
  );
  return {
    met: false,
    reason: `run ${sessionId}'s latest verify call over the change: ${problems.join("; ")}${unverifiable ? ` (${VERIFIABLE_REMEDY})` : ""}`,
  };
};

/** The `non_empty_diff` requirement over the latest run's measured branch (module doc). */
export const nonEmptyDiffVerdict = (
  evidence: CardEvidence,
): RequirementVerdict => {
  const latest = evidence.runs.at(-1);
  if (latest === undefined)
    return {
      met: false,
      reason: "the card has no runs, so no branch carries its change",
    };
  const diff = evidence.diff;
  // The evidence was gathered for this card, so a diff of another run (or none) is a caller that
  // did not measure the latest run: refused, rather than judged on a branch the card no longer carries.
  if (diff === undefined || diff.sessionId !== latest.sessionId)
    return {
      met: false,
      reason: `run ${latest.sessionId}'s branch was not measured`,
    };
  if (diff._tag === "unmeasured")
    return {
      met: false,
      reason: `run ${diff.sessionId}'s branch could not be measured: ${diff.reason}`,
    };
  return diff.files > 0
    ? { met: true }
    : {
        met: false,
        reason: `run ${diff.sessionId}'s branch ${diff.head} changes no file against ${diff.base} (git diff --numstat ${diff.base}...${diff.head} is empty): commit the change on the run's branch`,
      };
};

/**
 * The `pr_link` requirement over the card's PR (module doc): the latest run's recorded PR, or one an
 * earlier run recorded from the branch the latest run is on (C19).
 */
export const prLinkVerdict = (evidence: CardEvidence): RequirementVerdict => {
  const latest = evidence.runs.at(-1);
  if (latest === undefined)
    return { met: false, reason: "the card has no runs, so none opened a PR" };
  if (latest.prUrl !== undefined) return { met: true };
  const onBranch =
    latest.branch === undefined
      ? undefined
      : evidence.runs.findLast(
          (run) => run.prUrl !== undefined && run.prHead === latest.branch,
        );
  if (onBranch === undefined)
    return {
      met: false,
      reason: `the card's latest run ${latest.sessionId} recorded no PR (no factory.pr document in its log)${latest.branch === undefined ? "" : `, and no run of the card recorded one from its branch ${latest.branch}`}: open its PR (factory pr ${latest.sessionId}) before moving the card on`,
    };
  // The earlier run's PR is the card's only while the branch is where it was last published: a
  // follow-up run that committed and never pushed has moved it past the PR (module doc).
  if (
    onBranch.prCommit !== undefined &&
    evidence.branchTip !== undefined &&
    onBranch.prCommit === evidence.branchTip
  )
    return { met: true };
  return {
    met: false,
    reason: `the card's latest run ${latest.sessionId} recorded no PR, and its branch ${latest.branch ?? ""} ${
      onBranch.prCommit === undefined
        ? `has no published commit on record for the card's PR ${onBranch.prUrl ?? ""}`
        : evidence.branchTip === undefined
          ? "could not be read in the repository's registered checkout"
          : `is at ${evidence.branchTip.slice(0, 12)}, past ${onBranch.prCommit.slice(0, 12)} where run ${onBranch.sessionId} published the card's PR ${onBranch.prUrl ?? ""}`
    }: push the run's commits to the PR (factory pr ${latest.sessionId}) before moving the card on`,
  };
};

/** A commit as a reader takes it in a sentence: its first twelve characters. */
const shortSha = (sha: string): string => sha.slice(0, 12);

/**
 * Where a review run comes from, for a refusal that finds none: a deployment that GitHub cannot
 * reach has no way to open one (module doc).
 */
const REVIEW_RUNS_COME_FROM =
  "the review trigger opens one for each head its PR's pull_request events name, and those reach the factory only as signed deliveries to POST /webhooks/github, which needs GITHUB_WEBHOOK_SECRET set and GitHub able to reach it";

/** The `review_verdict` requirement over the review of the card's PR at its reported head (module doc). */
export const reviewVerdictVerdict = (
  evidence: CardEvidence,
): RequirementVerdict => {
  const reviews = evidence.reviews ?? [];
  const newestReview = reviews.at(-1);
  // The card's PR: the newest one a run of its change opened; the newest review's when none did.
  const cardPr =
    evidence.runs.findLast((run) => run.prUrl !== undefined)?.prUrl ??
    newestReview?.review.target.url;
  if (cardPr === undefined || newestReview === undefined)
    return {
      met: false,
      reason: `no review ran: the card has no review run${cardPr === undefined ? "" : ` of ${cardPr}`} (${REVIEW_RUNS_COME_FROM})`,
    };
  const reported = evidence.reviewHeads?.find(
    (head) => head.url === cardPr || head.apiUrl === cardPr,
  );
  const ofPr = reviews.filter(
    (run) =>
      run.review.target.url === cardPr ||
      (reported !== undefined && run.review.target.url === reported.url),
  );
  if (ofPr.length === 0)
    return {
      met: false,
      reason: `no review ran on the card's PR ${cardPr}: its newest review run ${newestReview.sessionId} reviewed ${newestReview.review.target.url}, another PR, whose verdict says nothing about this one (${REVIEW_RUNS_COME_FROM})`,
    };
  // The review of the head the PR was last reported at; with no report (a PR from before
  // `review_heads`, or a run opened outside the trigger), the newest review of the PR.
  const newest =
    reported === undefined
      ? ofPr.at(-1)
      : ofPr.findLast((run) => run.review.target.head === reported.head);
  if (newest === undefined)
    return {
      met: false,
      reason: `${cardPr} was last reported at ${shortSha(reported?.head ?? "")}, and no review run has recorded a target for that head (its run is still being opened, or its delivery was skipped — a head the checkout could not fetch); a review of another head does not stand in for it`,
    };
  const { sessionId, review } = newest;
  const pr = `${review.target.repo}#${review.target.number}`;
  const head = review.target.head;
  if (review.verdict === undefined)
    return {
      met: false,
      reason: `run ${sessionId} is still reviewing ${pr} at ${head}: it has recorded no verdict yet (wait for it to settle, or prompt it again if it ended without one)`,
    };
  if (review.verdict === "fail") {
    const failing = review.failing ?? [];
    return {
      met: false,
      reason: `run ${sessionId}'s review of ${pr} at ${shortSha(head)} failed ${failing.length === 0 ? "a dimension" : failing.join(", ")}${review.outcome === "posted" && review.outcomeDetail !== undefined && review.outcomeDetail !== "" ? ` (its findings: ${review.outcomeDetail})` : ""}: fix the findings and push, and the new head's review decides the move`,
    };
  }
  if (review.outcome === "stale")
    return {
      met: false,
      reason: `run ${sessionId}'s pass on ${pr} at ${shortSha(head)} is stale: the PR moved to ${review.outcomeDetail === undefined || review.outcomeDetail === "" ? "another head" : review.outcomeDetail} before it was posted, and no review run has recorded a verdict on that head`,
    };
  return { met: true };
};

/** One checked requirement's verdict over the card's evidence. */
export const requirementVerdict = (
  requirement: ColumnRequirement,
  evidence: CardEvidence,
): RequirementVerdict => {
  switch (requirement.key) {
    case VERIFIED_REQUIREMENT:
      return verifiedVerdict(evidence.runs);
    case NON_EMPTY_DIFF_REQUIREMENT:
      return nonEmptyDiffVerdict(evidence);
    case PR_LINK_REQUIREMENT:
      return prLinkVerdict(evidence);
    case REVIEW_VERDICT_REQUIREMENT:
      return reviewVerdictVerdict(evidence);
    default:
      return { met: false, reason: `"${requirement.key}" has no checker` };
  }
};
