import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { homeBoardsAtom } from "@/lib/atoms/first-run-atom";
import { soleBoard } from "@/lib/first-run-view";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

/**
 * The dashboard opens on boards (C9), because the board is the primary surface (docs/board.md) and
 * a person who opens the dashboard should land where there is something to do. Exactly one board
 * opens its lanes; none or several open the list, where a board is made or chosen. The logo links
 * here, so it means the same.
 *
 * The decision needs the server's list, so it is a component rather than a `beforeLoad` redirect.
 * A list that fails to load also lands on `/boards`, which shows the failure in its own words
 * rather than this page holding an error of its own.
 */
function HomeRoute() {
  const result = useAtomValue(homeBoardsAtom);

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Opening the dashboard</span>
        <Skeleton className="h-10 w-full max-w-xl" aria-hidden />
      </div>
    );
  }

  const boardId = AsyncResult.isSuccess(result)
    ? soleBoard(result.value)
    : undefined;
  return boardId === undefined ? (
    <Navigate to="/boards" replace />
  ) : (
    <Navigate to="/boards/$boardId" params={{ boardId }} replace />
  );
}
