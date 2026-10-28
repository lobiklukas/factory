import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { KanbanSquareIcon, PlusIcon } from "lucide-react";
import { LIST_BOARDS_LIMIT } from "@repo/domain/Task";
import { boardsAtom } from "@/lib/atoms/board-atom";
import { NEW_BOARD } from "@/lib/board-create-view";
import { EmptyPane } from "@/components/empty-pane";
import { GettingStarted } from "@/components/getting-started";
import { GuideLink } from "@/components/guide-link";
import { NewBoardDialog } from "@/components/new-board";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `new=board` opens the "New board" form (C5) over the list: the stable action the header, the empty
 * state and any page that means "make a board" link to. Any other value reads as closed.
 */
type BoardsSearch = { readonly new?: typeof NEW_BOARD | undefined };

export const Route = createFileRoute("/boards/")({
  validateSearch: (search: Record<string, unknown>): BoardsSearch =>
    search["new"] === NEW_BOARD ? { new: NEW_BOARD } : {},
  component: BoardsRoute,
});

/** A link, not a button: the form is a URL (`?new=board`), so it opens in a new tab too. */
const NewBoardLink = ({ where }: { readonly where: "empty" | "header" }) => (
  <Link
    to="/boards"
    search={{ new: NEW_BOARD }}
    data-new-board={where}
    className={buttonVariants({ size: "sm" })}
  >
    <PlusIcon strokeWidth={1.75} />
    New board
  </Link>
);

/**
 * The boards this control plane holds (LOB-75), newest first, each a link to its lanes, and the
 * "New board" form (C5) that makes one.
 *
 * A server read and nothing else: the list is `listBoards`, so a board created from the CLI or a
 * trigger is here on the next load, in any browser. A board binds one repository to a definition
 * version (docs/board.md B2), so the row leads with the repository and keeps the version beside it.
 */
function BoardsRoute() {
  const result = useAtomValue(boardsAtom);
  const { new: creating } = Route.useSearch();
  const navigate = useNavigate();

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading boards</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-10 w-full max-w-xl" aria-hidden />
        ))}
      </div>
    );
  }

  if (AsyncResult.isFailure(result)) {
    return (
      <EmptyPane
        icon={<KanbanSquareIcon strokeWidth={1.75} />}
        title="The boards did not load"
        detail={Cause.pretty(result.cause)}
        visible
      />
    );
  }

  const boards = result.value;
  return (
    <>
      <EmptyPane
        icon={<KanbanSquareIcon strokeWidth={1.75} />}
        title="No boards yet"
        detail="A board binds one repository to a definition version. None exists on this control plane yet: register a repository, make a board for it, put a card on it and start a run. The steps tick off as the control plane holds each."
        visible={boards.length === 0}
        action={
          <div className="flex w-full flex-col items-center gap-4">
            <NewBoardLink where="empty" />
            <GuideLink step="board" />
            <GettingStarted className="w-full" />
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          <div className="mb-4 flex max-w-xl items-center justify-between gap-3">
            <h1 className="text-sm font-medium">Boards</h1>
            <NewBoardLink where="header" />
          </div>
          {/* Until a run has started from a card, the checklist stays above the list (C9). */}
          <GettingStarted className="mb-4 max-w-xl" />
          {boards.length >= LIST_BOARDS_LIMIT && (
            <p className="mb-3 max-w-xl text-xs text-muted-foreground">
              The {LIST_BOARDS_LIMIT} newest boards; older ones are on the
              server but not listed here.
            </p>
          )}
          <ul aria-label="Boards" className="flex max-w-xl flex-col gap-1">
            {boards.map((board) => (
              <li key={board.id}>
                <Link
                  to="/boards/$boardId"
                  params={{ boardId: board.id }}
                  className="flex flex-col gap-1 border border-border px-3 py-2 transition-colors hover:bg-muted"
                >
                  <span className="truncate text-xs font-medium">
                    {board.repo}
                  </span>
                  <span className="flex min-w-0 gap-2 font-mono text-[10px] text-muted-foreground">
                    <span className="shrink-0">
                      {board.definitionId} v{board.definitionVersion}
                    </span>
                    <span className="truncate">{board.id}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </EmptyPane>
      <NewBoardDialog
        open={creating === NEW_BOARD}
        onOpenChange={(open) => {
          if (!open) void navigate({ to: "/boards", search: {} });
        }}
        onCreated={(board) =>
          void navigate({
            to: "/boards/$boardId",
            params: { boardId: board.id },
            search: {},
          })
        }
      />
    </>
  );
}
