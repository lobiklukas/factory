import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option, Schema } from "effect";
import { KanbanSquareIcon, PlusIcon } from "lucide-react";
import { SessionId } from "@repo/domain/Session";
import { BoardInstanceId, initialColumnOf, TaskId } from "@repo/domain/Task";
import { boardAtom } from "@/lib/atoms/board-atom";
import { boardLanes, definitionFor } from "@/lib/board-view";
import { NEW_CARD } from "@/lib/card-create-view";
import { BoardLanesView } from "@/components/board-lanes";
import { CardPane } from "@/components/card-pane";
import { CheckoutWarning } from "@/components/checkout-warning";
import { EmptyPane } from "@/components/empty-pane";
import { NewCardDialog } from "@/components/new-card";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Which card the pane shows, and which of its runs (LOB-76). In the URL rather than in this
 * browser, so a link to a card opens the same pane anywhere and a reload keeps it open. Each is
 * kept only when it decodes as the id it names; anything else reads as no selection.
 *
 * `new=card` opens the "New card" form (LOB-275) over whatever the rest selects: the stable action a
 * page links to when it means "put work on this board". Any other value reads as closed.
 */
type BoardSearch = {
  readonly card?: TaskId | undefined;
  readonly run?: SessionId | undefined;
  readonly new?: typeof NEW_CARD | undefined;
};

const decodeTaskId = Schema.decodeUnknownOption(TaskId);
const decodeSessionId = Schema.decodeUnknownOption(SessionId);

export const Route = createFileRoute("/boards/$boardId")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => {
    const card = Option.getOrUndefined(decodeTaskId(search["card"]));
    const run = Option.getOrUndefined(decodeSessionId(search["run"]));
    const selection: BoardSearch =
      card === undefined ? {} : run === undefined ? { card } : { card, run };
    return search["new"] === NEW_CARD
      ? { ...selection, new: NEW_CARD }
      : selection;
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
  const { card, run, new: creating } = Route.useSearch();
  const navigate = useNavigate();
  // The card this page just created (LOB-275), whose pane is opened before the board read that
  // lists it lands: until then the pane says it is opening it, not that the board has no such card.
  const [created, setCreated] = useState<TaskId | null>(null);

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

  // A failed poll keeps the last good board on screen, with a marker, rather than tearing down the
  // lanes and the open card pane (its transcript stream, composer draft, refusal). Only a first read
  // that fails, or a board the server says is gone, replaces the page with the error.
  const error = AsyncResult.isFailure(result)
    ? Cause.findErrorOption(result.cause)
    : Option.none();
  const missing = Option.isSome(error) && error.value._tag === "BoardNotFound";
  const last = Option.getOrUndefined(AsyncResult.value(result));
  if (AsyncResult.isFailure(result) && (missing || last === undefined)) {
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

  if (last === undefined) return null;
  const stale = AsyncResult.isFailure(result) ? result.cause : undefined;
  const { instance, definition, tasks, cards, pinned } = last;
  const faces = new Map(cards.map((entry) => [entry.task.id, entry]));
  const selected =
    card === undefined ? undefined : tasks.find((task) => task.id === card);
  // The card's own pinned version (B2, LOB-267): the board's for every card made on it.
  const selectedDefinition =
    selected === undefined
      ? undefined
      : definitionFor(selected, definition, pinned);
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
          {stale === undefined ? null : (
            <span
              role="status"
              data-board-stale
              title={Cause.pretty(stale)}
              className="text-[11px] text-destructive"
            >
              Reconnecting: showing the last answer the server gave
            </span>
          )}
          <Link
            to="/attention"
            search={{ board: boardId }}
            data-board-attention
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Needs a person
          </Link>
          {/* What each column does (LOB-245): the pinned version described, read-only. */}
          <Link
            to="/boards/$boardId/settings"
            params={{ boardId }}
            data-board-settings
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Settings
          </Link>
          <span className="text-[11px] text-muted-foreground">
            {tasks.length} {tasks.length === 1 ? "card" : "cards"} · open a card
            to move it or start a run
          </span>
          {/* A link, not a button: the form is a URL (`?new=card`), so it opens in a new tab too. */}
          <Link
            to="/boards/$boardId"
            params={{ boardId }}
            search={{
              ...(card === undefined ? {} : { card }),
              ...(run === undefined ? {} : { run }),
              new: NEW_CARD,
            }}
            data-new-card
            className={buttonVariants({ size: "sm", className: "self-center" })}
          >
            <PlusIcon strokeWidth={1.75} />
            New card
          </Link>
        </header>
        <NewCardDialog
          boardId={boardId}
          repo={instance.repo}
          column={initialColumnOf(definition)}
          open={creating === NEW_CARD}
          onOpenChange={(open) => {
            if (open) return;
            void navigate({
              to: "/boards/$boardId",
              params: { boardId },
              search: {
                ...(card === undefined ? {} : { card }),
                ...(run === undefined ? {} : { run }),
              },
            });
          }}
          onCreated={(task) => {
            // The new card's pane opens at once, and the lanes show it once the board read the
            // create invalidated (`BOARD_KEY`) answers: the server's list, never this answer.
            setCreated(task.id);
            void navigate({
              to: "/boards/$boardId",
              params: { boardId },
              search: { card: task.id },
            });
          }}
        />
        <CheckoutWarning warning={last.warning} />
        <BoardLanesView
          boardId={boardId}
          board={boardLanes(definition, tasks)}
          faces={faces}
          selected={card}
        />
      </div>
      {card === undefined ? null : selected === undefined &&
        card === created ? (
        <aside
          aria-label="Card"
          data-card-pane-opening={card}
          className="flex w-80 shrink-0 flex-col gap-1 border-l border-border p-4 text-xs"
        >
          <span className="font-medium">Opening the new card</span>
          <span className="text-muted-foreground">
            {card} was created; the board is reading it back.
          </span>
        </aside>
      ) : selected === undefined ? (
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
      ) : selectedDefinition === undefined ? (
        <aside
          aria-label="Card"
          data-card-pane-unpinned={selected.id}
          className="flex w-80 shrink-0 flex-col gap-1 border-l border-border p-4 text-xs"
        >
          <span className="font-medium">
            This card&apos;s definition was not read
          </span>
          <span className="text-muted-foreground">
            {selected.id} pins {instance.definitionId} v
            {selected.definitionVersion}, which the board read did not return.
          </span>
        </aside>
      ) : (
        <CardPane
          key={selected.id}
          boardId={boardId}
          task={selected}
          definition={selectedDefinition}
          run={run}
        />
      )}
    </div>
  );
};
