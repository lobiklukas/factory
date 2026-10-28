import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option, Schema } from "effect";
import { SlidersHorizontalIcon } from "lucide-react";
import { BoardInstanceId, type DefinitionConfig } from "@repo/domain/Task";
import { boardConfigAtom, definitionsAtom } from "@/lib/atoms/board-atom";
import {
  capsLabel,
  NONE,
  newerVersions,
  newerVersionsNotice,
} from "@/lib/board-settings-view";
import { ColumnSettings } from "@/components/column-settings";
import { EmptyPane } from "@/components/empty-pane";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/boards/$boardId/settings` (D3): what a board will do, in the browser. Its own page beside the
 * lanes rather than nested under them (the `_` in the file name), so opening it leaves the board's
 * poll and card pane behind instead of rendering under them.
 */
export const Route = createFileRoute("/boards/$boardId_/settings")({
  component: BoardSettingsRoute,
});

function BoardSettingsRoute() {
  const { boardId } = Route.useParams();
  // Decoded, not cast, as the board route does: a link carrying anything but a `brd_…` id is refused
  // here rather than reaching the API as a not-found.
  const parsed = Schema.decodeUnknownOption(BoardInstanceId)(boardId);
  return (
    <EmptyPane
      icon={<SlidersHorizontalIcon strokeWidth={1.75} />}
      title="Not a board id this control plane mints"
      detail="A board id is brd_ followed by Crockford base32. A link carrying anything else cannot resolve, so it is refused here instead of reaching the API."
      visible={Option.isNone(parsed)}
    >
      {Option.isSome(parsed) ? <BoardSettings boardId={parsed.value} /> : null}
    </EmptyPane>
  );
}

/**
 * Whether a version newer than the board's pin exists (B2), from `listDefinitions`. A failed list
 * says it could not tell rather than claiming the board is on the newest version.
 */
const NewerVersions = ({
  definition,
}: {
  readonly definition: DefinitionConfig;
}) => {
  const result = useAtomValue(definitionsAtom);
  if (AsyncResult.isInitial(result)) return null;
  if (AsyncResult.isFailure(result)) {
    return (
      <p
        data-newer-versions-unknown
        title={Cause.pretty(result.cause)}
        className="text-[11px] text-destructive"
      >
        Whether a newer version of {definition.id} exists could not be read.
      </p>
    );
  }
  const newer = newerVersions(result.value, definition.id, definition.version);
  const notice = newerVersionsNotice(definition.id, definition.version, newer);
  return notice === null ? (
    <p data-newest-version className="text-[11px] text-muted-foreground">
      v{definition.version} is the newest version of {definition.id}.
    </p>
  ) : (
    <p
      role="status"
      data-newer-versions={newer.join(",")}
      className="border border-border bg-muted/40 px-3 py-2 text-xs"
    >
      {notice}
    </p>
  );
};

/**
 * One board's settings: the definition version it pins, as `getBoardConfig` describes it (the same
 * description `getDefinition` answers for that version), every column in order with what it does.
 *
 * Read-only. A version is never edited in place (docs/board.md B2): a change to a board's pipeline is
 * a new version, and the page says when one exists. Nothing here is this browser's: a reload is a
 * fresh read of both calls.
 */
const BoardSettings = ({ boardId }: { readonly boardId: BoardInstanceId }) => {
  const result = useAtomValue(boardConfigAtom(boardId));

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading the board&apos;s settings</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-24 w-full max-w-3xl" aria-hidden />
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
        icon={<SlidersHorizontalIcon strokeWidth={1.75} />}
        title={missing ? "No such board" : "The board's settings did not load"}
        detail={
          missing
            ? `This control plane holds no board ${boardId}. It may have been made against another database.`
            : Cause.pretty(result.cause)
        }
        visible
      />
    );
  }

  const { instance, definition } = result.value;
  const caps = capsLabel(definition.caps);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/boards"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Boards
          </Link>
          <Link
            to="/boards/$boardId"
            params={{ boardId }}
            data-settings-board-link
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {instance.repo}
          </Link>
          <h1 className="text-sm font-medium">Settings</h1>
          <span className="font-mono text-[10px] text-muted-foreground">
            {instance.id}
          </span>
        </div>
        <dl className="grid max-w-3xl grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Definition</dt>
          <dd
            data-settings-definition={definition.id}
            data-settings-version={definition.version}
          >
            <span className="font-medium">{definition.name}</span>{" "}
            <span className="font-mono text-muted-foreground">
              {definition.id} v{definition.version}
            </span>
          </dd>
          <dt className="text-muted-foreground">New cards start in</dt>
          <dd data-settings-initial className="font-mono">
            {definition.initialColumn ?? NONE}
          </dd>
          <dt className="text-muted-foreground">Run caps</dt>
          <dd data-settings-caps>{caps ?? NONE}</dd>
        </dl>
        <NewerVersions definition={definition} />
        <p className="max-w-3xl text-[11px] text-muted-foreground">
          Read-only: a definition version is never edited in place, so a
          board&apos;s pipeline changes only by moving to a new version. The
          model is this deployment&apos;s for the column&apos;s role; a
          requirement marked checked is one a move out of the column is refused
          over today.
        </p>
      </header>
      <ol
        aria-label="Columns"
        className="grid max-w-6xl gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {definition.columns.map((column, index) => (
          <li
            key={column.name}
            data-settings-column={column.name}
            className="flex flex-col gap-2 border border-border bg-card px-3 py-2.5"
          >
            <h2 className="flex items-baseline gap-2 text-xs font-medium">
              <span className="font-mono text-[10px] text-muted-foreground">
                {index + 1}
              </span>
              {column.name}
              {column.name === definition.initialColumn ? (
                <Badge variant="outline" className="text-[10px]">
                  initial
                </Badge>
              ) : null}
            </h2>
            <ColumnSettings column={column} />
          </li>
        ))}
      </ol>
    </div>
  );
};
