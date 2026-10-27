import type { BoardColumn, Task } from "@repo/domain/Task";
import { cn } from "cn";
import { blockedLabel, type BoardLanes } from "@/lib/board-view";
import { Badge } from "@/components/ui/badge";

/**
 * One card (LOB-75): what the server says about a task, and nothing this browser adds.
 *
 * Title first, because it is what a person scans a lane for; then the flags that change what they
 * do next — `urgent` (B9) and a block with its reason (B4: a blocked card stays in its own lane, so
 * the lane cannot say it). The id and revision sit last in mono: they are what `factory board move`
 * takes, and a reader copying them out should not have to open anything.
 *
 * Read-only on purpose. Moves, gates and the run start belong to the card pane (LOB-76), so no
 * control here can change a card.
 */
export const TaskCard = ({ task }: { readonly task: Task }) => {
  const blocked = blockedLabel(task);
  return (
    <li
      data-card={task.id}
      data-card-column={task.column}
      className={cn(
        "flex flex-col gap-1.5 border border-border bg-card px-3 py-2.5",
        blocked !== null && "border-l-2 border-l-destructive",
      )}
    >
      <span className="text-xs leading-snug font-medium break-words">
        {task.title}
      </span>
      {task.priority === "urgent" || blocked !== null ? (
        <span className="flex flex-wrap items-center gap-1">
          {task.priority === "urgent" ? (
            <Badge
              variant="outline"
              className="font-mono text-[10px] tracking-wide uppercase"
            >
              urgent
            </Badge>
          ) : null}
          {blocked === null ? null : (
            <Badge
              variant="destructive"
              className="font-mono text-[10px]"
              title={task.blocked?.note}
            >
              {blocked}
            </Badge>
          )}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <span className="truncate" title={task.id}>
          {task.id}
        </span>
        <span className="shrink-0">r{task.revision}</span>
      </span>
    </li>
  );
};

/**
 * One lane: a column of the definition, with the cards the server has in it.
 *
 * The header carries what the definition says about the column — its kind, and its role where it
 * has one (B4) — so a lane is readable without the definition open beside it. An empty lane is
 * rendered like any other: an empty column and a column that does not exist must not look the same.
 */
export const BoardLane = ({
  column,
  cards,
}: {
  readonly column: BoardColumn;
  readonly cards: ReadonlyArray<Task>;
}) => (
  <section
    data-lane={column.name}
    aria-label={`Lane ${column.name}`}
    className="flex w-64 shrink-0 flex-col border-r border-border last:border-r-0"
  >
    <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-xs font-medium">{column.name}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {column.kind}
          {column.role === undefined ? null : ` · ${column.role}`}
        </span>
      </span>
      <span
        className="font-mono text-[10px] text-muted-foreground"
        data-lane-count={cards.length}
      >
        {cards.length}
      </span>
    </header>
    {cards.length === 0 ? (
      <p className="px-3 py-3 text-[11px] text-muted-foreground">No cards</p>
    ) : (
      <ul
        aria-label={`Cards in ${column.name}`}
        className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2"
      >
        {cards.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </ul>
    )}
  </section>
);

/**
 * Every lane, left to right in definition order, plus any card whose column the definition does
 * not declare (`boardLanes` keeps them rather than dropping them).
 *
 * The strip scrolls sideways inside itself: seven fixed-width lanes are wider than most windows,
 * and a lane that shrank to fit would truncate every title in it.
 */
export const BoardLanesView = ({ board }: { readonly board: BoardLanes }) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div
      role="group"
      aria-label="Lanes"
      className="flex min-h-0 flex-1 overflow-x-auto"
    >
      {board.lanes.map((lane) => (
        <BoardLane
          key={lane.column.name}
          column={lane.column}
          cards={lane.cards}
        />
      ))}
    </div>
    {board.strays.length === 0 ? null : (
      <section
        aria-label="Cards outside this definition"
        className="border-t border-border px-3 py-2"
      >
        <p className="mb-2 text-xs text-destructive">
          {board.strays.length} card(s) sit in a column this definition does not
          declare.
        </p>
        <ul className="flex flex-wrap gap-2">
          {board.strays.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </ul>
      </section>
    )}
  </div>
);
