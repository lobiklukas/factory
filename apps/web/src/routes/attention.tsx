import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option, Schema } from "effect";
import { BellIcon } from "lucide-react";
import type { AttentionItem } from "@repo/domain/Task";
import { BoardInstanceId } from "@repo/domain/Task";
import { ALL_BOARDS, attentionAtom } from "@/lib/atoms/attention-atom";
import {
  attentionGroups,
  attentionLink,
  attentionReasonText,
  attentionTitle,
} from "@/lib/attention-view";
import { EmptyPane } from "@/components/empty-pane";
import { EmptyLink } from "@/components/empty-link";
import { GuideLink } from "@/components/guide-link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Which board the view is scoped to (`?board=`), or every board when absent. Kept only when it
 * decodes as a board id, as the card pane's `?card=` is: anything else reads as no scope.
 */
type AttentionSearch = { readonly board?: BoardInstanceId | undefined };

const decodeBoardId = Schema.decodeUnknownOption(BoardInstanceId);

export const Route = createFileRoute("/attention")({
  validateSearch: (search: Record<string, unknown>): AttentionSearch => {
    const board = Option.getOrUndefined(decodeBoardId(search["board"]));
    return board === undefined ? {} : { board };
  },
  component: AttentionRoute,
});

/**
 * What needs a person (LOB-77, part 3 of LOB-22): one list, grouped by what the person has to do —
 * decide a run's approval, answer a run's question, make the move a human gate keeps for a person —
 * with each row a link to the card that needs them — or, for an approval of a session no card owns
 * (LOB-271), to the session.
 *
 * The rows are `listAttention`, the server's answer, and nothing else: no card, run or approval is
 * walked from the browser, so a card the server would not list cannot appear here and a reload is a
 * fresh read. A card blocked on a dependency, a capability or a transient failure is waiting on
 * that, not on a person, and the server does not list it.
 */
function AttentionRoute() {
  const { board } = Route.useSearch();
  const result = useAtomValue(attentionAtom(board ?? ALL_BOARDS));

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading what needs a person</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12 w-full max-w-2xl" aria-hidden />
        ))}
      </div>
    );
  }

  // As on the board: a failed poll keeps the last answer on screen with a marker; only a first read
  // that fails, or a board the server says is gone, replaces the page.
  const error = AsyncResult.isFailure(result)
    ? Cause.findErrorOption(result.cause)
    : Option.none();
  const missing = Option.isSome(error) && error.value._tag === "BoardNotFound";
  const last = Option.getOrUndefined(AsyncResult.value(result));
  if (AsyncResult.isFailure(result) && (missing || last === undefined)) {
    return (
      <EmptyPane
        icon={<BellIcon strokeWidth={1.75} />}
        title={missing ? "No such board" : "What needs a person did not load"}
        detail={
          missing
            ? `This control plane holds no board ${board ?? ""}. It may have been made against another database.`
            : Cause.pretty(result.cause)
        }
        visible
      />
    );
  }
  if (last === undefined) return null;
  const stale = AsyncResult.isFailure(result) ? result.cause : undefined;
  const groups = attentionGroups(last);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">Needs a person</h1>
        {board === undefined ? (
          <span className="text-[11px] text-muted-foreground">every board</span>
        ) : (
          <>
            <span
              data-attention-scope={board}
              className="font-mono text-[10px] text-muted-foreground"
            >
              {board}
            </span>
            <Link
              to="/boards/$boardId"
              params={{ boardId: board }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Open the board
            </Link>
            <Link
              to="/attention"
              search={{}}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Every board
            </Link>
          </>
        )}
        {stale === undefined ? null : (
          <span
            role="status"
            data-attention-stale
            title={Cause.pretty(stale)}
            className="text-[11px] text-destructive"
          >
            Reconnecting: showing the last answer the server gave
          </span>
        )}
        <span
          data-attention-count={last.length}
          className="ml-auto text-[11px] text-muted-foreground"
        >
          {last.length} {last.length === 1 ? "thing" : "things"} waiting on a
          person
        </span>
      </header>
      {groups.length === 0 ? (
        <div data-attention-empty className="flex min-h-0 flex-1 flex-col">
          <EmptyPane
            icon={<BellIcon strokeWidth={1.75} />}
            title="Nothing needs a person"
            detail={
              board === undefined
                ? "No card or session waits on an approval, an answer to a run's question, or a move only a person can make. A card blocked on a dependency is waiting on that, not on you."
                : "No card on this board waits on an approval, an answer to a run's question, or a move only a person can make. A card blocked on a dependency is waiting on that, not on you."
            }
            action={
              <>
                <EmptyLink to="/boards">Open the boards</EmptyLink>
                <GuideLink step="run" />
              </>
            }
            visible
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
          {groups.map((group) => (
            <section
              key={group.kind}
              data-attention-group={group.kind}
              aria-label={group.title}
              className="flex max-w-3xl flex-col gap-2"
            >
              <h2 className="flex items-baseline gap-2 text-xs font-medium">
                {group.title}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {group.items.length}
                </span>
              </h2>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <AttentionRow
                    key={rowKey(item)}
                    item={item}
                    showRepo={board === undefined}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const rowKey = (item: AttentionItem): string =>
  item.reason._tag === "approval"
    ? `${item.task?.id ?? "session"}:${item.reason.sessionId}:${item.reason.requestId}`
    : `${item.task?.id ?? "session"}:${item.reason._tag}`;

/** The row's subject for `data-attention`: the card's id, or the session's when no card owns it. */
const rowSubject = (item: AttentionItem): string =>
  item.task?.id ??
  (item.reason._tag === "question" || item.reason._tag === "review"
    ? "session"
    : item.reason.sessionId);

const ROW_CLASS =
  "flex min-w-0 flex-1 flex-col gap-1 border border-border bg-card px-3 py-2 hover:border-ring/50 focus-visible:outline-1 focus-visible:outline-ring";

/**
 * One thing a person has to do: the card, why it is here, and a link that opens it in its board's
 * card pane, a question's at the card's thread where the answer is typed (LOB-239). The reason is
 * the server's words (the approval's action, the run's question, the gate's name), so the pane says
 * the same thing when it opens.
 */
const AttentionRow = ({
  item,
  showRepo,
}: {
  readonly item: AttentionItem;
  readonly showRepo: boolean;
}) => {
  const link = attentionLink(item);
  const { task } = item;
  const content = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-xs font-medium">
          {attentionTitle(item)}
        </span>
        {task?.priority === "urgent" ? (
          <Badge
            variant="outline"
            className="font-mono text-[10px] tracking-wide uppercase"
          >
            urgent
          </Badge>
        ) : null}
      </span>
      <span
        data-attention-text
        className="text-[11px] leading-snug break-words text-foreground/80"
      >
        {attentionReasonText(item)}
      </span>
      <span className="flex min-w-0 gap-2 font-mono text-[10px] text-muted-foreground">
        {showRepo && item.repo !== undefined ? (
          <span className="truncate">{item.repo}</span>
        ) : null}
        {task === undefined ? (
          <span className="shrink-0">no card</span>
        ) : (
          <>
            <span className="shrink-0">{task.column}</span>
            <span className="truncate" title={task.id}>
              {task.id}
            </span>
          </>
        )}
      </span>
    </>
  );
  return (
    <li
      data-attention={rowSubject(item)}
      data-attention-reason={item.reason._tag}
      {...(task === undefined ? { "data-attention-session": "" } : {})}
      className="flex"
    >
      {link.kind === "card" ? (
        <Link
          to="/boards/$boardId"
          params={{ boardId: link.boardId }}
          search={link.search}
          {...(link.hash === undefined ? {} : { hash: link.hash })}
          aria-label={`Open card ${attentionTitle(item)}`}
          className={ROW_CLASS}
        >
          {content}
        </Link>
      ) : link.kind === "session" ? (
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: link.sessionId }}
          aria-label={`Open session ${attentionTitle(item)}`}
          className={ROW_CLASS}
        >
          {content}
        </Link>
      ) : (
        <Link to="/sessions" aria-label={`Open sessions`} className={ROW_CLASS}>
          {content}
        </Link>
      )}
    </li>
  );
};
