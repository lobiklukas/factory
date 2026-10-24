import { useEffect, useRef, useState } from "react";
import type { SessionTask } from "@repo/domain/Session";
import { cn } from "cn";
import {
  formatAge,
  stampTasks,
  taskDepth,
  waitingLabel,
} from "@/lib/task-view";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The live task tree (LOB-184).
 *
 * Pi Durable's task graph is what a run is doing *right now*: the model turn, each tool call, each
 * compaction, plus any task a session defines. Part 1 projected it onto the session surface, and
 * this strip is where an operator reads it, between the header and the transcript, because the
 * question "is it doing anything, and on what" comes before "what did it say".
 *
 * The panel keeps its own clock: the age of a task is the time this browser has watched it, since
 * the graph carries no start time (see `@/lib/task-view`). The interval runs only while something
 * is on screen — an idle session has no reason to wake up once a second.
 */
const TICK_MS = 1000;

// oxlint-disable-next-line effecttsgo/global-date -- a browser component renders outside any Effect fiber, so wall-clock time comes from the page, not from `Clock`.
const nowMs = (): number => Date.now();

/**
 * Re-renders the strip once a second while something is on screen, which is what makes the ages
 * advance.
 *
 * Nothing here reads a clock out of state, on purpose: a component that renders the *current* time
 * cannot inherit a stale one. Holding "now" in state would leave it at the last tick's value, and a
 * task that appears after a minute of idle would then be born already a minute old.
 */
const useTick = (ticking: boolean): void => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    // oxlint-disable-next-line effecttsgo/global-timers -- the tick is UI state, not a modeled Effect timer.
    const timer = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
};

/**
 * The status word, styled like the header's run chip and coloured only while it is moving: shape
 * and word carry the state, so nothing here is legible by colour alone.
 */
const TaskStatus = ({ status }: { readonly status: SessionTask["status"] }) => (
  <Badge
    variant="outline"
    className={cn(
      "font-mono text-[10px] tracking-wide uppercase",
      status === "running" && "border-ring/40 text-ring",
      (status === "waiting" || status === "pending") && "text-muted-foreground",
    )}
  >
    {status}
  </Badge>
);

/**
 * One task.
 *
 * Every cell in the middle column may shrink (`min-w-0 truncate`) so a narrow pane ellipsizes the
 * text instead of letting it run into the age. `depth` is filled by the panel's owner walk: a task
 * owned by another live task is drawn under it.
 */
const TaskRow = ({
  task,
  ageMs,
  depth,
}: {
  readonly task: SessionTask;
  readonly ageMs: number;
  readonly depth: number;
}) => (
  <li
    className={cn(
      // `overflow-hidden` keeps a squeezed pane from drawing a row over its neighbours instead of
      // ellipsizing it: the shell's own narrow-width behaviour is LOB-210's, but a panel should not
      // make it worse.
      "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden font-mono text-[11px]",
      depth === 1 && "pl-3",
      depth >= 2 && "pl-6",
    )}
    title="Age counts from when this browser first saw the task"
  >
    <TaskStatus status={task.status} />
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate" title={`${task.kind} ${task.id}`}>
        {task.kind} {task.id}
      </span>
      {task.phase === undefined ? null : (
        <span className="min-w-0 truncate text-muted-foreground">
          {task.phase}
        </span>
      )}
      {task.status === "waiting" && task.waitingOn.length > 0 ? (
        <span
          className="min-w-0 truncate text-muted-foreground"
          title={`waits for ${task.waitingOn.join(", ")}`}
        >
          {waitingLabel(task.waitingOn)}
        </span>
      ) : null}
      {task.owner === undefined ? null : (
        <span className="min-w-0 truncate text-muted-foreground">
          owner {task.owner}
        </span>
      )}
    </span>
    <span
      className="shrink-0 text-muted-foreground tabular-nums"
      data-task-age={Math.floor(Math.max(0, ageMs) / 1000)}
    >
      {formatAge(ageMs)}
    </span>
  </li>
);

export const TaskPanel = ({
  tasks,
  attaching,
}: {
  readonly tasks: readonly SessionTask[];
  readonly attaching: boolean;
}) => {
  const now = nowMs();
  useTick(!attaching && tasks.length > 0);

  // First-seen stamps live in a ref and are written from an effect, not during render: `stampTasks`
  // is idempotent, but a concurrent render may be replayed and a stamp is not a pure read of props.
  // A task with no stamp yet — the render that first sees it — reads zero, which is exactly how long
  // this browser has watched it.
  const seen = useRef<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    seen.current = stampTasks(seen.current, tasks, nowMs());
  }, [tasks]);

  const byId = new Map(tasks.map((task) => [task.id, task]));

  return (
    <section
      aria-label="Live tasks"
      className="shrink-0 border-b border-border px-4 py-2"
    >
      <div className="flex items-baseline gap-2">
        <h2 className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
          Tasks
        </h2>
        {attaching ? (
          <Skeleton className="h-2.5 w-4" />
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
            {tasks.length}
          </span>
        )}
      </div>

      {attaching ? (
        <div role="status" className="mt-1.5">
          <span className="sr-only">Loading tasks</span>
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : tasks.length === 0 ? (
        // The empty state is the normal state of a session between runs, so it is one line rather
        // than the app's full-height `Empty` block, which would push the transcript down every time
        // a run settles. It still says which list is empty instead of leaving a blank strip.
        <p className="mt-1 text-xs text-muted-foreground">
          No tasks. This session has no live tasks; work in flight appears here.
        </p>
      ) : (
        <ul
          tabIndex={0}
          aria-label="Live task rows"
          className="mt-1.5 flex max-h-[40vh] flex-col gap-1 overflow-y-auto focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {tasks.map((task) => {
            // Reading the stamp ref here is display-only: a task with no stamp yet is one this
            // render is the first to see, so it reads 0 and the effect above stamps it for the next
            // tick. Nothing in this render depends on the write having happened.
            const firstSeen = seen.current.get(task.id);
            return (
              <TaskRow
                key={task.id}
                task={task}
                ageMs={firstSeen === undefined ? 0 : now - firstSeen}
                depth={taskDepth(task, byId)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
};
