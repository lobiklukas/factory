/**
 * A column's exit requirements, checked against what the card's runs recorded (docs/board.md B5,
 * B8; LOB-80, part 3 of LOB-16).
 *
 * `requires[]` is declared per column and checked on exit: a card may always move *into* a column,
 * and the gate is what leaves it. This module holds the checks themselves, as pure functions of the
 * evidence, so `TaskService.move` decides only *when* to check and the rules can be read (and
 * tested) without a database.
 *
 * **Which keys are checked.** Only the keys in `CHECKED_REQUIREMENTS`. Today that is `verified`, the
 * one B8 promotes from a PR body artifact into a condition of the move. The other keys the default
 * pipeline declares are not checked here, and each for a stated reason: `human_move` and
 * `human_merge` are B5's human gates, which `TaskService` already enforces by actor; `spec_doc`,
 * `plan_doc`, `run_completed`, `non_empty_diff`, `pr_link` and `review_verdict` have no recorded
 * artifact to check yet, and refusing every move on a key nothing can satisfy would turn the
 * pipeline off rather than gate it. A key gains a checker when its evidence is recorded.
 *
 * **What `verified` means.** The card's change is the newest `verify` call, over all of the card's
 * runs, that measured a change: a call that found no changed path (a reviewer's run in a fresh
 * worktree) or could not measure one (`VerifyUnmeasured`) says nothing about the change, so it
 * neither satisfies the requirement nor wipes out the call before it. That call's changed paths name
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
 * verified, not what the branch holds at the moment of the move.
 */
import type { BoardColumn, ColumnRequirement } from "@repo/domain/Task";
import { VERIFIED_REQUIREMENT } from "@repo/domain/Task";
import {
  REPO_SURFACE,
  surfaceOf,
  surfacesOf,
  type VerifyRecord,
  type VerifyReport,
  type VerifyResult,
} from "@repo/harness";

/** The requirement keys this module can check. Every other key is not checked yet (module doc). */
export const CHECKED_REQUIREMENTS: ReadonlySet<string> = new Set([
  VERIFIED_REQUIREMENT,
]);

/** One run of the card and the `verify` records its log holds, oldest first. */
export type RunEvidence = {
  readonly sessionId: string;
  readonly records: readonly VerifyRecord[];
};

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

/** The card's change: the newest call, over every run, that measured at least one changed path. */
const latestChange = (
  runs: readonly RunEvidence[],
):
  | { readonly sessionId: string; readonly report: VerifyReport }
  | undefined => {
  for (const run of [...runs].reverse()) {
    for (const record of [...run.records].reverse()) {
      if (record._tag === "VerifyReport" && record.changedCount > 0)
        return { sessionId: run.sessionId, report: record };
    }
  }
  return undefined;
};

/** The `verified` requirement over a card's runs, oldest run first (module doc). */
export const verifiedVerdict = (
  runs: readonly RunEvidence[],
): RequirementVerdict => {
  const change = latestChange(runs);
  if (change === undefined) {
    const calls = runs.reduce((count, run) => count + run.records.length, 0);
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
  return {
    met: false,
    reason: `run ${sessionId}'s latest verify call over the change: ${problems.join("; ")}`,
  };
};

/** One checked requirement's verdict over the card's runs. */
export const requirementVerdict = (
  requirement: ColumnRequirement,
  runs: readonly RunEvidence[],
): RequirementVerdict =>
  requirement.key === VERIFIED_REQUIREMENT
    ? verifiedVerdict(runs)
    : { met: false, reason: `"${requirement.key}" has no checker` };
