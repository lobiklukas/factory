import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { GitForkIcon, Minimize2Icon, SquareIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import type { SessionId } from "@repo/domain/Session";
import type { CompactionWindow } from "@/lib/compaction-view";
import {
  compactionDelta,
  compactionRow,
  formatSpend,
  spendOf,
} from "@/lib/compaction-view";
import {
  compactSessionAtom,
  forkSessionAtom,
  sendMessageAtom,
  sessionAtom,
  type SessionView,
} from "@/lib/atoms/session-atom";
import { forgetSession, recordSession } from "@/lib/atoms/session-registry";
import { TaskPanel } from "@/components/task-panel";
import { TranscriptRow } from "@/components/transcript-entry";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * The header chip.
 *
 * Mintlify labels a finished run `Accepted` and v0 shows `Restarting` beside a
 * live ticker, so state here is one word and a dot, never a sentence. `mode`
 * sits next to it because a folded transcript must never look like a live one
 * (docs/design.md D8).
 */
const StatusChip = ({ view }: { readonly view: SessionView }) => (
  <div className="flex items-center gap-2">
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-mono text-[10px] tracking-wide uppercase",
        view.summary.status === "busy" && "border-ring/40 text-ring",
      )}
    >
      <span
        className={cn(
          "size-1.5",
          view.summary.status === "busy"
            ? "animate-pulse bg-ring"
            : "bg-muted-foreground/50",
        )}
        aria-hidden
      />
      {view.summary.status}
    </Badge>
    <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
      {view.summary.mode === "live" ? "live stream" : "historical fold"}
    </span>
    {/*
     * Where an in-flight tool call goes now that the transcript does not label
     * calls: v0 puts the current step beside the status word, and one line beats
     * a marker in the transcript that a busy run keeps appending to.
     */}
    {view.live.tools.map((tool) => (
      <span
        key={tool.callId}
        className="font-mono text-[10px] tracking-wide text-muted-foreground"
      >
        {tool.name}
        {tool.status === "running" ? "…" : ""}
      </span>
    ))}
  </div>
);

/**
 * The pane while it attaches.
 *
 * Skeleton lines rather than a spinner alone, so the transcript's shape is
 * already reserved when the first row lands and the composer does not jump.
 * `role="status"` carries the announcement a pile of grey rectangles cannot.
 */
const AttachingSkeleton = () => (
  <div role="status" className="flex flex-col gap-5">
    <span className="sr-only">Attaching to the session</span>
    {[0, 1, 2, 3].map((row) => (
      <div key={row} className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-3 w-1/4" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    ))}
  </div>
);

export const SessionPane = ({
  sessionId,
}: {
  readonly sessionId: SessionId;
}) => {
  const [result, attach] = useAtom(sessionAtom);
  const send = useAtomSet(sendMessageAtom);
  const fork = useAtomSet(forkSessionAtom, { mode: "promise" });
  const compact = useAtomSet(compactSessionAtom, { mode: "promise" });
  const record = useAtomSet(recordSession);
  const forget = useAtomSet(forgetSession);
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [forking, setForking] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactionWindow, setCompactionWindow] =
    useState<CompactionWindow | null>(null);
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    attach(sessionId);
  }, [attach, sessionId]);

  const view = AsyncResult.getOrElse(result, () => null);
  const queued =
    view === null ? [] : view.queued.filter((q) => !withdrawn.has(q.id));

  // The registry is written here rather than in the atom: writing an atom from
  // an atom needs an `AtomRegistry` in context, and the pane is already the
  // place that knows what the stream last reported.
  useEffect(() => {
    if (view !== null) record(view.summary);
  }, [record, view]);

  /**
   * Freeze a compaction's end reading once its spend has landed (LOB-223).
   *
   * The summary row and the usage event are separate stream events, so the row can appear before
   * the summarizer's own spend is written. Waiting for both is why this is an effect rather than a
   * value computed at press time: the delta is read live until the transcript holds the row *and*
   * the session has spent more than it had at the press, and from then on it is a fixed number, so
   * later turns cannot quietly grow it.
   */
  useEffect(() => {
    if (view === null || compactionWindow === null) return;
    if (compactionWindow.after !== null) return;
    if (compactionRow(compactionWindow, sessionId, view.entries) === undefined)
      return;
    const began = spendOf(compactionWindow.before);
    const now = spendOf(view.usage);
    if (began.tokens === now.tokens && began.costTotal === now.costTotal)
      return;
    setCompactionWindow({ ...compactionWindow, after: view.usage });
  }, [compactionWindow, sessionId, view]);

  const attaching = AsyncResult.isInitial(result);
  const failure = AsyncResult.isFailure(result) ? result.cause : null;

  /**
   * The row the current compaction window belongs to (LOB-223). Computed once for the transcript:
   * "which summary did my press write" is a question about the list, not about a row.
   */
  const compactionSummaryRow =
    view === null
      ? undefined
      : compactionRow(compactionWindow, sessionId, view.entries);

  /**
   * Why Compact cannot be pressed right now, or `null` when it can (LOB-223).
   *
   * A disabled button that says nothing is a dead control: the same header either has a run in
   * flight (compact at the next boundary is a different action from compacting now, so this one
   * waits) or a pane that has not attached. Both reasons are in the DOM — as the button's `title`
   * and, for a screen reader, as the description it points at.
   */
  const compactBlocked =
    view === null
      ? failure === null
        ? "Attaching to the session"
        : "This session could not be read"
      : view.live.busy
        ? "Wait for this run to finish before compacting"
        : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-sm font-medium">
            {view?.summary.title ?? "Session"}
          </h1>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {sessionId}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {attaching ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : null}
          {view !== null ? <StatusChip view={view} /> : null}
          {queued.length > 0 ? (
            <Badge variant="secondary" className="font-mono text-[10px]">
              {queued.length} queued
            </Badge>
          ) : null}
          {/*
           * The session's own spend, beside the actions that change it (LOB-223). It is a running
           * total for the whole session, so it is the reading a compaction is measured against —
           * and it prints no dollar figure when the provider reported none.
           */}
          {view === null ? null : (
            <span
              data-session-usage
              className="font-mono text-[10px] text-muted-foreground tabular-nums"
              title="This session's usage so far"
            >
              {formatSpend(spendOf(view.usage))}
            </span>
          )}
          {/*
           * Compact now (LOB-185's RPC, LOB-222's atom, LOB-223's action). The call admits a task
           * and answers its id; the summary lands in the transcript over the stream, so there is
           * nothing to await here and nothing to navigate to.
           */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Compact session"
            title={
              compacting
                ? "Compacting"
                : (compactBlocked ?? "Compact this session now")
            }
            aria-busy={compacting}
            aria-describedby={
              compactBlocked === null ? undefined : "compact-blocked"
            }
            disabled={compactBlocked !== null || compacting}
            onClick={() => {
              if (view === null) return;
              setCompacting(true);
              // The before reading, and where the transcript ended: the summary the task writes is
              // the first compaction entry after this one, and its spend is the difference.
              setCompactionWindow({
                sessionId,
                before: view.usage,
                entriesBefore: view.entries.length,
                after: null,
              });
              void compact({ sessionId })
                .catch((cause: unknown) => {
                  // Nothing was admitted, so there is no row to measure; drop the readings too, so
                  // a later compaction is not charged for this attempt.
                  setCompactionWindow(null);
                  toast.error("No compaction was started", {
                    description:
                      cause instanceof Error ? cause.message : String(cause),
                  });
                })
                .finally(() => setCompacting(false));
            }}
          >
            {compacting ? (
              <Spinner className="size-3.5 text-muted-foreground" />
            ) : (
              <Minimize2Icon className="size-4" strokeWidth={1.75} />
            )}
            Compact
          </Button>
          {compactBlocked === null ? null : (
            <span id="compact-blocked" className="sr-only">
              {compactBlocked}
            </span>
          )}
          {/*
           * Fork from here (LOB-182). A text button, not an icon-only one: the header has the room,
           * and "Fork" beside the status chip says what the live session can become without the
           * reader hovering to find out. It is disabled until the pane has a view, because the fork
           * names this session and there is nothing to name while the attach is still in flight.
           */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Fork from here"
            title="Fork from here"
            aria-busy={forking}
            disabled={view === null || forking}
            onClick={() => {
              setForking(true);
              void fork(sessionId)
                .then((summary) => {
                  // The child is recorded before navigating: the registry is what the sidebar
                  // lists, and the pane the route moves to would record it one render later.
                  record(summary);
                  void navigate({
                    to: "/sessions/$sessionId",
                    params: { sessionId: summary.id },
                  });
                })
                .catch((cause: unknown) => {
                  toast.error("No fork was created", {
                    description:
                      cause instanceof Error ? cause.message : String(cause),
                  });
                })
                .finally(() => setForking(false));
            }}
          >
            {forking ? (
              <Spinner className="size-3.5 text-muted-foreground" />
            ) : (
              <GitForkIcon className="size-4" strokeWidth={1.75} />
            )}
            Fork
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Forget this session"
            onClick={() => forget(sessionId)}
          >
            <XIcon className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
      </header>

      {/*
       * What the run is doing right now, before what it said (LOB-184). The list is the stream's
       * projection of Pi Durable's task graph, so a task that settles leaves the strip as it left
       * the graph — no reload, no history to keep.
       */}
      <TaskPanel
        tasks={view === null ? [] : view.tasks}
        attaching={attaching}
      />

      {/*
       * The scroller follows the stream: a live run appends while you read, and
       * before this the pane never moved, so the newest line was always the one
       * you had to scroll to find. `defaultScrollPosition="end"` opens on the
       * latest row, and the button appears only once you have scrolled away.
       */}
      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        {/*
         * The wrapper exists because the primitive's root is `size-full`, and
         * `h-full` only resolves against a parent with a definite height. A
         * `flex-1 min-h-0` box gives it one; without it the scroller sizes to its
         * content and the composer leaves the viewport.
         */}
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageScroller>
            <MessageScrollerViewport aria-label="Transcript">
              <MessageScrollerContent className="mx-auto w-full max-w-[68ch] gap-5 px-6 py-6">
                {attaching ? <AttachingSkeleton /> : null}

                {failure !== null ? (
                  <Alert variant="destructive">
                    <AlertTitle>This session could not be read</AlertTitle>
                    <AlertDescription>
                      The control plane refused the attach. What it said:
                      <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                        {Cause.pretty(failure)}
                      </pre>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {view?.entries.map((entry, index) => (
                  <MessageScrollerItem
                    key={entry.id}
                    messageId={entry.id}
                    scrollAnchor={index === view.entries.length - 1}
                  >
                    <TranscriptRow
                      entry={entry}
                      spend={
                        compactionSummaryRow === index &&
                        compactionWindow !== null
                          ? compactionDelta(compactionWindow, view.usage)
                          : undefined
                      }
                    />
                  </MessageScrollerItem>
                ))}

                {view !== null && view.entries.length === 0 ? (
                  <Empty>
                    <EmptyTitle>Nothing in this log yet</EmptyTitle>
                    <EmptyDescription>
                      The run has opened and committed nothing. Send it
                      something and the first entry lands here.
                    </EmptyDescription>
                  </Empty>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </div>
      </MessageScrollerProvider>

      {queued.length > 0 ? (
        <div className="shrink-0 border-t border-border px-6 py-2">
          <div className="mx-auto flex max-w-[68ch] flex-col gap-1">
            {queued.map((q) => (
              <div
                key={q.id}
                className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground"
              >
                <span className="truncate">
                  {typeof q.content === "string"
                    ? q.content
                    : q.content == null
                      ? q.id
                      : JSON.stringify(q.content)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setWithdrawn((prev) => new Set([...prev, q.id]))
                  }
                >
                  Withdraw
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="shrink-0 border-t border-border px-6 py-3">
        <form
          className="mx-auto flex max-w-[68ch] flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0) return;
            send({ sessionId, content: draft });
            setDraft("");
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Send a message to this session"
              rows={1}
              className="min-h-9 resize-none"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {view?.summary.status === "busy" ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Interrupt this run"
              >
                <SquareIcon className="size-4" strokeWidth={1.75} />
              </Button>
            ) : null}
            <Button type="submit" disabled={draft.trim().length === 0}>
              Send
            </Button>
          </div>
          {/* Enter-to-send was real but undiscoverable; this is the only place
              the composer states its own contract. */}
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Kbd>Enter</Kbd> send
            <Kbd>Shift</Kbd>
            <Kbd>Enter</Kbd> newline
          </p>
        </form>
      </div>
    </div>
  );
};
