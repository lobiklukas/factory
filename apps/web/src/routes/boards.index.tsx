import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { KanbanSquareIcon } from "lucide-react";
import { boardsAtom } from "@/lib/atoms/board-atom";
import { EmptyPane } from "@/components/empty-pane";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/boards/")({
  component: BoardsRoute,
});

/**
 * The boards this control plane holds (LOB-75), newest first, each a link to its lanes.
 *
 * A server read and nothing else: the list is `listBoards`, so a board created from the CLI or a
 * trigger is here on the next load, in any browser. A board binds one repository to a definition
 * version (docs/board.md B2), so the row leads with the repository and keeps the version beside it.
 */
function BoardsRoute() {
  const result = useAtomValue(boardsAtom);

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
    <EmptyPane
      icon={<KanbanSquareIcon strokeWidth={1.75} />}
      title="No boards yet"
      detail="A board binds one repository to a definition version. None exists on this control plane yet, so there are no lanes to show."
      visible={boards.length === 0}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        <h1 className="mb-4 text-sm font-medium">Boards</h1>
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
  );
}
