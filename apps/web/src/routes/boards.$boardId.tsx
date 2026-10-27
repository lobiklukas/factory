import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option, Schema } from "effect";
import { KanbanSquareIcon } from "lucide-react";
import { SessionId } from "@repo/domain/Session";
import { BoardInstanceId, TaskId } from "@repo/domain/Task";
import { boardAtom } from "@/lib/atoms/board-atom";
import { boardLanes } from "@/lib/board-view";
import { BoardLanesView } from "@/components/board-lanes";
import { CardPane } from "@/components/card-pane";
import { EmptyPane } from "@/components/empty-pane";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Which card the pane shows, and which of its runs (LOB-76). In the URL rather than in this
 * browser, so a link to a card opens the same pane anywhere and a reload keeps it open. Each is
 * kept only when it decodes as the id it names; anything else reads as no selection.
 */
type BoardSearch = {
  readonly card?: TaskId | undefined;
  readonly run?: SessionId | undefined;
};

const decodeTaskId = Schema.decodeUnknownOption(TaskId);
const decodeSessionId = Schema.decodeUnknownOption(SessionId);

export const Route = createFileRoute("/boards/$boardId")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => {
    const card = Option.getOrUndefined(decodeTaskId(search["card"]));
    const run = Option.getOrUndefined(decodeSessionId(search["run"]));
    return card === undefined
      ? {}
      : run === undefined
        ? { card }
        : { card, run };
  },
  component: BoardRoute,
});

function BoardRoute() {
  const { boardId } = Route.useParams();
  // Decoded, not cast, for the reason the session route gives: a link carrying anything but a
  // `brd_…` id is refused here rather than reaching the API as a not-found.
  const parsed = Schema.decodeUnknownOption(BoardInstanceId)(boardId);

  return (
    <EmptyPane
      icon={<KanbanSquareIcon strokeWidth={1.75} />}
      title="Not a board id this control plane mints"
      detail="A board id is brd_ followed by Crockford base32. A link carrying anything else cannot resolve, so it is refused here instead of reaching the API."
      visible={Option.isNone(parsed)}
    >
      {Option.isSome(parsed) ? <Board boardId={parsed.value} /> : null}
    </EmptyPane>
  );
}

/**
 * One board's lanes (LOB-75): columns from the definition version the board binds, cards from the
 * server's list, and no client state between them — a reload is a fresh read of both. The card
 * pane (LOB-76) opens beside the lanes for the card the URL names, from the same answer.
 */
const Board = ({ boardId }: { readonly boardId: BoardInstanceId }) => {
  const result = useAtomValue(boardAtom(boardId));
  const { card, run } = Route.useSearch();

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 gap-3 p-6">
        <span className="sr-only">Loading the board</span>
        {[0, 1, 2, 3].map((lane) => (
          <Skeleton key={lane} className="h-48 w-64" aria-hidden />
        ))}
      </div>
    );
  }

  if (AsyncResult.isFailure(result)) {
    const error = Cause.findErrorOption(result.cause);
    const missing =
      Option.isSome(error) && error.value._tag === "BoardNotFound";
    return (
      <EmptyPane
        icon={<KanbanSquareIcon strokeWidth={1.75} />}
        title={missing ? "No such board" : "The board did not load"}
        detail={
          missing
            ? `This control plane holds no board ${boardId}. It may have been made against another database.`
            : Cause.pretty(result.cause)
        }
        visible
      />
    );
  }

  const { instance, definition, tasks } = result.value;
  const selected =
    card === undefined ? undefined : tasks.find((task) => task.id === card);
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
          <Link
            to="/boards"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Boards
          </Link>
          <h1 className="text-sm font-medium">{instance.repo}</h1>
          <span className="font-mono text-[10px] text-muted-foreground">
            {definition.name} v{definition.version} · {instance.id}
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {tasks.length} {tasks.length === 1 ? "card" : "cards"} · open a card
            to move it or start a run
          </span>
        </header>
        <BoardLanesView
          boardId={boardId}
          board={boardLanes(definition, tasks)}
          selected={card}
        />
      </div>
      {card === undefined ? null : selected === undefined ? (
        <aside
          aria-label="Card"
          data-card-pane-missing={card}
          className="flex w-80 shrink-0 flex-col gap-1 border-l border-border p-4 text-xs"
        >
          <span className="font-medium">No such card on this board</span>
          <span className="text-muted-foreground">
            {card} is not one of this board&apos;s cards.
          </span>
        </aside>
      ) : (
        <CardPane
          key={selected.id}
          boardId={boardId}
          task={selected}
          definition={definition}
          run={run}
        />
      )}
    </div>
  );
};
