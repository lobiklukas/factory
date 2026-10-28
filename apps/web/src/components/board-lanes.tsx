import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { ChevronRightIcon } from "lucide-react";
import type { BoardColumn, BoardInstanceId, Task } from "@repo/domain/Task";
import { cn } from "cn";
import { boardConfigAtom } from "@/lib/atoms/board-atom";
import { blockedLabel, type BoardLanes } from "@/lib/board-view";
import { ColumnSettings } from "@/components/column-settings";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * One card (LOB-75): what the server says about a task, and nothing this browser adds.
 *
 * Title first, because it is what a person scans a lane for; then the flags that change what they
 * do next — `urgent` (B9) and a block with its reason (B4: a blocked card stays in its own lane, so
 * the lane cannot say it). The id and revision sit last in mono: they are what `factory board move`
 * takes, and a reader copying them out should not have to open anything.
 *
 * The card is a link that opens it in the card pane (LOB-76), and nothing more: moves, gates and
 * the run start are the pane's, so no control in a lane can change a card, and there is no drag —
 * a drag would offer every lane as a target, and most of them are moves the column does not
 * declare (B5, B9).
 */
export const TaskCard = ({
  boardId,
  task,
  selected,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly selected: boolean;
}) => {
  const blocked = blockedLabel(task);
  return (
    <li
      data-card={task.id}
      data-card-column={task.column}
      data-card-revision={task.revision}
      className="flex"
    >
      <Link
        to="/boards/$boardId"
        params={{ boardId }}
        search={{ card: task.id }}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open card ${task.title}`}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1.5 border border-border bg-card px-3 py-2.5 hover:border-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          blocked !== null && "border-l-2 border-l-destructive",
          selected && "border-ring",
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
      </Link>
    </li>
  );
};

/**
 * What a lane's disclosure shows (D3): its column as `getBoardConfig` describes the board's pinned
 * version — the settings page's own read and words (`ColumnSettings`), so the two cannot disagree.
 * Mounted only while the disclosure is open, so a board nobody inspects never reads its config, and
 * read once rather than with the board's poll: a pinned version does not change (B2).
 */
const LaneSettings = ({
  boardId,
  column,
}: {
  readonly boardId: BoardInstanceId;
  readonly column: string;
}) => {
  const result = useAtomValue(boardConfigAtom(boardId));
  if (AsyncResult.isInitial(result)) {
    return (
      <p role="status" className="text-[11px] text-muted-foreground">
        Reading the column&apos;s settings
      </p>
    );
  }
  if (AsyncResult.isFailure(result)) {
    return (
      <p
        data-lane-settings-failed
        title={Cause.pretty(result.cause)}
        className="text-[11px] text-destructive"
      >
        The column&apos;s settings did not load.
      </p>
    );
  }
  const { definition } = result.value;
  const described = definition.columns.find((entry) => entry.name === column);
  return described === undefined ? (
    <p className="text-[11px] text-destructive">
      {column} is not a column of {definition.id} v{definition.version}.
    </p>
  ) : (
    <div className="flex flex-col gap-2">
      <ColumnSettings column={described} />
      <Link
        to="/boards/$boardId/settings"
        params={{ boardId }}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Every column&apos;s settings
      </Link>
    </div>
  );
};

/**
 * One lane: a column of the definition, with the cards the server has in it.
 *
 * The header carries what the definition says about the column — its kind, and its role where it
 * has one (B4) — so a lane is readable without the definition open beside it, and a disclosure
 * (D3) with the rest: the role's model, the skills, the exit requirements and the moves out. An
 * empty lane is rendered like any other: an empty column and a column that does not exist must not
 * look the same.
 */
export const BoardLane = ({
  boardId,
  column,
  cards,
  selected,
}: {
  readonly boardId: BoardInstanceId;
  readonly column: BoardColumn;
  readonly cards: ReadonlyArray<Task>;
  readonly selected: string | undefined;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <section
      data-lane={column.name}
      aria-label={`Lane ${column.name}`}
      className="flex w-64 shrink-0 flex-col border-r border-border last:border-r-0"
    >
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="border-b border-border"
      >
        <header className="flex items-baseline justify-between gap-2 px-3 py-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-xs font-medium">{column.name}</span>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {column.kind}
              {column.role === undefined ? null : ` · ${column.role}`}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span
              className="font-mono text-[10px] text-muted-foreground"
              data-lane-count={cards.length}
            >
              {cards.length}
            </span>
            <CollapsibleTrigger
              data-lane-settings-toggle={column.name}
              aria-label={`Settings of ${column.name}`}
              title={`What ${column.name} does`}
              className="flex size-5 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform motion-safe:duration-200",
                  open && "rotate-90",
                )}
                strokeWidth={1.75}
              />
            </CollapsibleTrigger>
          </span>
        </header>
        <CollapsibleContent
          data-lane-settings={column.name}
          className="max-h-80 overflow-y-auto border-t border-border bg-muted/30 px-3 py-2"
        >
          <LaneSettings boardId={boardId} column={column.name} />
        </CollapsibleContent>
      </Collapsible>
      {cards.length === 0 ? (
        <p className="px-3 py-3 text-[11px] text-muted-foreground">No cards</p>
      ) : (
        <ul
          aria-label={`Cards in ${column.name}`}
          className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2"
        >
          {cards.map((task) => (
            <TaskCard
              key={task.id}
              boardId={boardId}
              task={task}
              selected={task.id === selected}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/**
 * Every lane, left to right in definition order, plus any card whose column the definition does
 * not declare (`boardLanes` keeps them rather than dropping them).
 *
 * The strip scrolls sideways inside itself: seven fixed-width lanes are wider than most windows,
 * and a lane that shrank to fit would truncate every title in it.
 */
export const BoardLanesView = ({
  boardId,
  board,
  selected,
}: {
  readonly boardId: BoardInstanceId;
  readonly board: BoardLanes;
  readonly selected: string | undefined;
}) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div
      role="group"
      aria-label="Lanes"
      className="flex min-h-0 flex-1 overflow-x-auto"
    >
      {board.lanes.map((lane) => (
        <BoardLane
          key={lane.column.name}
          boardId={boardId}
          column={lane.column}
          cards={lane.cards}
          selected={selected}
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
            <TaskCard
              key={task.id}
              boardId={boardId}
              task={task}
              selected={task.id === selected}
            />
          ))}
        </ul>
      </section>
    )}
  </div>
);
