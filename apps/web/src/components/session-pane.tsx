import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import {
  GitForkIcon,
  GitPullRequestIcon,
  Loader2Icon,
  SquareIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import type { SessionId } from "@repo/domain/Session";
import type { CompactionSettle, CompactionWindow } from "@/lib/compaction-view";
import {
  compactionDelta,
  compactionRow,
  formatSpend,
  requestedCompaction,
  settleCompaction,
  settleFor,
  spendOf,
  verdictVisible,
} from "@/lib/compaction-view";
import {
  compactSessionAtom,
  forkSessionAtom,
  readSessionHistoryAtom,
  sendMessageAtom,
  sessionAtom,
  withdrawMessageAtom,
  type SessionView,
} from "@/lib/atoms/session-atom";
import { sessionListAtom } from "@/lib/atoms/session-list";
import { prLink } from "@/lib/pr-link";
import { sessionModel } from "@/lib/server-info-view";
import { SessionsBackLink } from "@/components/sessions-back-link";
import { CheckoutWarning } from "@/components/checkout-warning";
import { CompactButton } from "@/components/compact-button";
import { TaskPanel } from "@/components/task-panel";
import { TranscriptRow } from "@/components/transcript-entry";
import { visibleEntries } from "@/lib/transcript-view";
import {
  currentHistory,
  nextBefore,
  withEarlierPage,
  type EarlierHistory,
} from "@/lib/history-view";
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
 * The session's PR, beside its name (LOB-65).
 *
 * The link is what the session recorded (`summary.prUrl`), so it appears on attach for a PR opened
 * earlier and mid-stream when a `prOpened` event lands. A session with no PR shows nothing here —
 * the header is the session's identity, and a "no PR" chip on every new session would be noise. It
 * opens in a new tab: the pane is a live stream, and navigating away from it would drop the attach.
 */
const PrAnchor = ({ prUrl }: { readonly prUrl: string | undefined }) => {
  const link = prLink(prUrl);
  if (link === null) return null;
  return (
    <a
      data-pr-link
      href={link.href}
      target="_blank"
      rel="noreferrer"
      title={link.href}
      className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
    >
      <GitPullRequestIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
      {link.label}
    </a>
  );
};

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
  const withdraw = useAtomSet(withdrawMessageAtom, { mode: "promise" });
  const readHistory = useAtomSet(readSessionHistoryAtom, { mode: "promise" });
  /** Earlier transcript read on request (LOB-243), above what the view carries. */
  const [history, setHistory] = useState<EarlierHistory | null>(null);
  const [readingHistory, setReadingHistory] = useState(false);
  const refreshList = useAtomRefresh(sessionListAtom);
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [forking, setForking] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactionWindow, setCompactionWindow] =
    useState<CompactionWindow | null>(null);
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * What the last press of Compact has come to (LOB-224): pending, settled with a summary, or
   * settled with nothing to cut. The state machine is `settleCompaction`'s; the pane only renders
   * what it says, so "the spinner never stops" is a case a unit test can fail.
   */
  const [settle, setSettle] = useState<CompactionSettle>({ state: "idle" });

  useEffect(() => {
    attach(sessionId);
  }, [attach, sessionId]);

  const view = AsyncResult.getOrElse(result, () => null);
  const queued =
    view === null ? [] : view.queued.filter((q) => !withdrawn.has(q.id));

  // The sidebar is the server's list, so the pane does not write to it; it asks
  // for a re-read when the status it is streaming changes, which keeps the row of
  // the session on screen from lagging the header beside it.
  const status = view?.summary.status;
  useEffect(() => {
    if (status !== undefined) refreshList();
  }, [refreshList, status]);

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

  /**
   * The entries that have a row (LOB-273). The log's `title` and text-less `system` entries are
   * bookkeeping; `index` keeps each row's place in the full log for the compaction lookup below.
   */
  const rows = view === null ? [] : visibleEntries(view.entries);

  /**
   * The earlier pages that sit above `rows` (LOB-243), and where the next press reads before. Kept
   * apart from `rows` so the compaction lookup keeps indexing the view's own entries.
   */
  const loaded =
    view === null ? null : currentHistory(history, sessionId, view.earlier);
  const earlierRows = loaded === null ? [] : visibleEntries(loaded.entries);
  const before = view === null ? undefined : nextBefore(loaded, view.earlier);

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
   * The press as it applies to this route. One pane component serves every session, and a task id
   * from another session's graph means nothing here.
   */
  const settleNow = settleFor(settle, sessionId);

  /**
   * Read what the press came to on every stream event and after the call answers (LOB-224).
   *
   * `settle` is in the dependencies, not just `view`: a compaction with no cut settles inside the
   * few milliseconds the `compactSession` call takes, so its task-list events can all have been
   * folded *before* the answer installs `requested`. Without re-running here, the pane would sit on
   * the pending line forever — the spinner that never stops, one layer down.
   *
   * `settleCompaction` returns the state it was given when nothing changed, so the extra runs stop
   * as soon as the state does.
   */
  useEffect(() => {
    if (view === null) return;
    setSettle((previous) =>
      settleCompaction(previous, {
        sessionId,
        tasks: view.tasks,
        entries: view.entries,
      }),
    );
  }, [sessionId, settle, view]);

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

  /**
   * Whether a compaction is under way: the call is in flight, or its task is still live (LOB-224).
   *
   * One press at a time. A second admission while the first task runs would compact against a
   * context the first one is rewriting, and the pending line is already the answer to "is anything
   * happening".
   */
  const compactRunning = compacting || settleNow.state === "requested";

  /**
   * Whether the verdict is on screen (LOB-224). The state machine decides what the press came to;
   * this decides whether it may be said yet, which is not the same thing while a run is in flight.
   */
  const showVerdict = verdictVisible(
    settleNow,
    view !== null && view.live.busy,
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
       * Below `md` the header wraps (LOB-210): the pane is the whole width beside the rail there,
       * but a 390 px phone still has no room for the session's name *and* its actions on one line,
       * and one of them would be cut off. The name keeps the first row, so the reader knows which
       * session the actions act on; the readings and the actions wrap below it, inside the pane.
       */}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2 md:h-12 md:flex-nowrap md:py-0">
        <div className="flex min-w-0 items-center gap-3 max-md:basis-full">
          <SessionsBackLink className="-ml-2" />
          <h1 className="truncate text-sm font-medium">
            {view?.summary.title ?? "Session"}
          </h1>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {sessionId}
          </span>
          <PrAnchor prUrl={view?.summary.prUrl} />
          {/* The model this session is pinned to (LOB-272): faux/faux-1 is a scripted answer. */}
          {sessionModel(view?.summary.model) === null ? null : (
            <span
              data-session-model
              title="The model this session runs on"
              className="shrink-0 font-mono text-[10px] text-muted-foreground"
            >
              {view?.summary.model}
            </span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 md:flex-nowrap">
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
           * Below `md` the readings and the actions wrap onto rows of their own (LOB-210), so the
           * two buttons stay together rather than one of them landing alone on a third row.
           */}
          <span aria-hidden className="basis-full md:hidden" />
          {/*
           * Compact now (LOB-185's RPC, LOB-222's atom, LOB-223's action, LOB-224's settle). The
           * call admits a task and answers its id; the summary lands in the transcript over the
           * stream, or the task settles with nothing to cut — the pending line below says which is
           * happening, so the button itself carries no spinner.
           */}
          <CompactButton
            blocked={compactBlocked}
            running={compactRunning}
            calling={compacting}
            state={
              settleNow.state === "requested"
                ? "requested"
                : settleNow.state === "idle"
                  ? "idle"
                  : "settled"
            }
            onPress={() => {
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
                .then(({ taskId }) => {
                  // The task list as this press saw it, not as it is when the answer arrives: the
                  // reducer needs the *press-time* projection to tell "the task has not appeared
                  // yet" from "the task has already settled".
                  setSettle(
                    requestedCompaction({
                      sessionId,
                      taskId,
                      entriesBefore: view.entries.length,
                      tasks: view.tasks,
                    }),
                  );
                })
                .catch((cause: unknown) => {
                  // Nothing was admitted, so there is no row to measure and no task to watch; drop
                  // the readings too, so a later compaction is not charged for this attempt.
                  setCompactionWindow(null);
                  setSettle({ state: "idle" });
                  toast.error("No compaction was started", {
                    description:
                      cause instanceof Error ? cause.message : String(cause),
                  });
                })
                .finally(() => setCompacting(false));
            }}
          />
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
                  // The sidebar re-reads the server's list on its own (`SESSIONS_KEY`), so the
                  // route is the only thing to move.
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
        </div>
      </header>
      <CheckoutWarning warning={view?.workspaceWarning} />

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

                {/*
                 * A historical read of a long session carries its newest entries (LOB-243); the
                 * rest is read a page at a time, on request, and lands above them.
                 */}
                {view !== null && before !== undefined ? (
                  <div className="flex justify-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-show-earlier={before}
                      aria-busy={readingHistory}
                      disabled={readingHistory}
                      onClick={() => {
                        const anchor = view.earlier;
                        if (anchor === undefined) return;
                        setReadingHistory(true);
                        void readHistory({ sessionId, before })
                          .then((page) =>
                            setHistory((previous) =>
                              withEarlierPage(
                                currentHistory(previous, sessionId, anchor),
                                sessionId,
                                anchor,
                                page,
                              ),
                            ),
                          )
                          .catch((cause: unknown) => {
                            toast.error("Earlier entries did not load", {
                              description:
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                            });
                          })
                          .finally(() => setReadingHistory(false));
                      }}
                    >
                      {readingHistory ? (
                        <Spinner className="size-3.5 text-muted-foreground" />
                      ) : null}
                      Show earlier entries
                    </Button>
                  </div>
                ) : null}

                {earlierRows.map(({ entry }) => (
                  <MessageScrollerItem key={entry.id} messageId={entry.id}>
                    <TranscriptRow entry={entry} />
                  </MessageScrollerItem>
                ))}

                {rows.map(({ entry, index }, position) => (
                  <MessageScrollerItem
                    key={entry.id}
                    messageId={entry.id}
                    scrollAnchor={position === rows.length - 1}
                  >
                    <TranscriptRow
                      entry={entry}
                      spend={
                        view !== null &&
                        compactionSummaryRow === index &&
                        compactionWindow !== null
                          ? compactionDelta(compactionWindow, view.usage)
                          : undefined
                      }
                    />
                  </MessageScrollerItem>
                ))}

                {view !== null && rows.length === 0 ? (
                  <Empty>
                    <EmptyTitle>No messages yet</EmptyTitle>
                    <EmptyDescription>
                      Nothing has been said in this run. Send it a message and
                      it lands here.
                    </EmptyDescription>
                  </Empty>
                ) : null}

                {/*
                 * What the last press of Compact came to (LOB-224), in the tail because that is
                 * where the summary will land: a pending line that is replaced by the row it was
                 * waiting for, or by the verdict that there is nothing to cut. Both states reserve the
                 * same height (`min-h-16`: the verdict's heading plus two lines of its copy, which is
                 * what it needs while the transcript column can hold a sentence), so the verdict
                 * replaces the spinner without moving the transcript. At a phone width the shell
                 * leaves the pane a ~60px column and everything there wraps: that squeeze is the
                 * dashboard's, not this box's, and no reservation here could absorb it.
                 *
                 * The region itself is always mounted — `sr-only` while it has nothing to say, so
                 * it costs no layout and no gap — because a screen reader announces a change
                 * *inside* the region it already knows, not a region inserted together with its
                 * text. `data-compaction-status` carries what the press came to, so a drive never
                 * has to match on copy; whether the verdict is *shown* is `verdictVisible`'s
                 * question, and that is the difference a busy run makes.
                 */}
                <div
                  role="status"
                  data-slot="compaction-status"
                  data-compaction-status={settleNow.state}
                  className={
                    settleNow.state === "requested" || showVerdict
                      ? undefined
                      : "sr-only"
                  }
                >
                  {settleNow.state === "requested" ? (
                    <div className="flex min-h-16 items-center gap-2 text-xs text-muted-foreground">
                      <Loader2Icon
                        data-slot="spinner"
                        aria-hidden
                        className="size-3 animate-spin"
                      />
                      Compacting this session…
                    </div>
                  ) : null}
                  {showVerdict ? (
                    <div className="flex min-h-16 flex-col justify-center gap-1">
                      <p className="text-sm">Nothing to compact</p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        This session is too short to cut. Its recent turns stay
                        verbatim.
                      </p>
                    </div>
                  ) : null}
                </div>
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
                  onClick={() => {
                    // Hidden while the call is in flight; the server's queue is what keeps it gone
                    // (LOB-166). A refused withdrawal puts the row back, because the message is
                    // still queued and will still run.
                    setWithdrawn((prev) => new Set([...prev, q.id]));
                    void withdraw({ sessionId, submissionId: q.id })
                      .then((answer) => {
                        if (answer.outcome === "already_placed") {
                          toast.info("Too late to withdraw", {
                            description: "A run already took this message.",
                          });
                        }
                      })
                      .catch((cause: unknown) => {
                        setWithdrawn((prev) => {
                          const next = new Set(prev);
                          next.delete(q.id);
                          return next;
                        });
                        toast.error("The message was not withdrawn", {
                          description:
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                        });
                      });
                  }}
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
            // A verdict describes the transcript at the press. The operator's next turn moves the
            // transcript on, and a line saying the session is too short to cut would then be a
            // claim about a log that no longer exists (LOB-224).
            setSettle((previous) =>
              previous.state === "settled-nothing"
                ? { state: "idle" }
                : previous,
            );
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
