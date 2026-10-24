import type { SessionTask } from "@repo/domain/Session";

/**
 * What the live-tasks panel can say about a task, computed here rather than in the component so it
 * can be tested without a browser (LOB-184).
 *
 * Pi Durable's task graph carries no timestamp: `SessionTask` is ids, kind, status, phase, owner and
 * what a task waits on. So the panel cannot report a task's true age, and pretending otherwise would
 * be a number nobody measured. What it reports instead is how long the task has been on screen in
 * *this* browser, and the row's title says exactly that.
 */

/**
 * Stamps each task id the first time it is seen and forgets an id that left the list.
 *
 * A settled task is absent from the next projection rather than carried as history, so dropping it
 * here keeps a task that appears later from inheriting a dead one's age. Returns the same map when
 * nothing changed, so a caller can hold it in a ref and re-render without churn.
 */
export const stampTasks = (
  seen: ReadonlyMap<string, number>,
  tasks: readonly SessionTask[],
  nowMs: number,
): ReadonlyMap<string, number> => {
  const live = new Set(tasks.map((task) => task.id));
  let changed = false;
  const next = new Map<string, number>();
  for (const [id, at] of seen) {
    if (!live.has(id)) {
      changed = true;
      continue;
    }
    next.set(id, at);
  }
  for (const id of live) {
    if (next.has(id)) continue;
    next.set(id, nowMs);
    changed = true;
  }
  return changed ? next : seen;
};

/**
 * A duration as the panel prints it: `0s`, `12s`, `1m 04s`, `1h 02m`.
 *
 * Never a fraction — a tenth of a second is noise at this size. `0s` is deliberate for a task whose
 * row has just appeared: the panel counts what it has watched, and it has watched nothing yet.
 */
export const formatAge = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * What a `waiting` task is joined on.
 *
 * Two ids fit on a row; more would push the task's own name off it, so past two the row says how
 * many and the full list goes in the row's title.
 */
export const waitingLabel = (waitingOn: readonly string[]): string =>
  waitingOn.length <= 2
    ? `waiting on ${waitingOn.join(", ")}`
    : `waiting on ${waitingOn.length} tasks`;

/**
 * How deep a task sits under the task that owns it, as the strip indents it.
 *
 * The graph is a tree by `owner`, and an owner may itself be owned (a tool call inside a generation
 * inside a task a session defines), so the walk follows the chain. It stops at two levels on
 * purpose — a third indent inside a pane this narrow would cost more than it explains — and it
 * stops on a cycle, which a projection of a `waiting` graph could in principle describe.
 */
export const taskDepth = (
  task: SessionTask,
  byId: ReadonlyMap<string, SessionTask>,
): number => {
  const walked = new Set([task.id]);
  let owner = task.owner;
  let depth = 0;
  while (owner !== undefined && !walked.has(owner)) {
    const parent = byId.get(owner);
    if (parent === undefined) break;
    walked.add(owner);
    depth += 1;
    owner = parent.owner;
  }
  return Math.min(depth, 2);
};
