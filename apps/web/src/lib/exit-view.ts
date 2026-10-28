import type { ExitRequirementView, Task, TaskExit } from "@repo/domain/Task";
import { unmetFor } from "@repo/domain/Task";

/**
 * A column's exit checklist as the card pane words it (D9). The server judges each requirement
 * (`getTaskExit`, the verdicts `moveTask` refuses on); this only says what each answer means to a
 * person and which of a card's moves it holds, so the pane and the refusal cannot disagree.
 */

/** The short word beside each requirement. `unchecked` says the factory does not hold a move to it. */
export const exitStatusLabel = (
  status: ExitRequirementView["status"],
): string =>
  status === "met" ? "met" : status === "unmet" ? "unmet" : "not checked";

/**
 * The exit view to show for `task`, or `null` while the read is of another column: a card that was
 * just moved has the old column's checklist until the next read, and a list of what the card needed
 * to leave where it no longer is would be wrong. Revisions are not compared — evidence changes
 * without one (a run's log) — so the next poll's answer replaces this one in place.
 */
export const currentExit = (
  exit: TaskExit | undefined,
  task: Task,
): TaskExit | null =>
  exit !== undefined && exit.taskId === task.id && exit.column === task.column
    ? exit
    : null;

/**
 * What a move to `to` says before it is clicked: the keys the server would refuse it on, with the
 * reason each carries, or `null` when nothing stands in its way (no checklist yet, every checked
 * key met, or a move into `canceled`, which checks none). A move is still offered and still sent —
 * the server decides — so this is a warning, not a lock.
 */
export const moveWarning = (
  exit: TaskExit | null,
  to: string,
): ReadonlyArray<{ readonly key: string; readonly reason: string }> | null => {
  if (exit === null) return null;
  const unmet = unmetFor(exit, to);
  return unmet.length === 0
    ? null
    : unmet.map((requirement) => ({
        key: requirement.key,
        reason: requirement.reason ?? "not met",
      }));
};
