import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import {
  ArrowRightIcon,
  BoxesIcon,
  CheckIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  PlayIcon,
  UserCheckIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import type { SessionId } from "@repo/domain/Session";
import type {
  BoardDefinition,
  BoardInstanceId,
  Task,
  TaskBlocked,
} from "@repo/domain/Task";
import {
  boardAtom,
  commentTaskAtom,
  moveTaskAtom,
  startRunAtom,
  taskCommentsAtom,
  taskRunsAtom,
  taskSpecAtom,
} from "@/lib/atoms/board-atom";
import {
  awaitingMove,
  blockedLabel,
  externalLink,
  landedOn,
  moveRefusal,
  offeredMoves,
  recordLanding,
  refusalIsCurrent,
  runSelection,
  runStart,
  type Landed,
  type MoveRefusal,
} from "@/lib/board-view";
import {
  commentKindLabel,
  commentRefusal,
  commentTime,
  composerIntent,
  draftAfterSend,
  liftedBlock,
  sendable,
  THREAD_ANCHOR,
  type CommentRefusal,
} from "@/lib/thread-view";
import { DASHBOARD_ACTOR } from "@/lib/approvals-view";
import { specLists } from "@/lib/spec-view";
import { startPrompt, startSendable } from "@/lib/run-start-view";
import { RunApprovals } from "@/components/approvals";
import { SessionPane } from "@/components/session-pane";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The card's writes, one per pane (LOB-239): Moves and the Thread both write the card at the revision
 * on screen, so while either is in flight, or has landed and the board read has not caught up, both
 * hold their sends. Otherwise a move clicked just after an answer (or a comment just after a move)
 * sends the old revision and is refused as stale for the person's own write.
 */
type CardWrites = {
  /** A write from this pane is in flight. */
  readonly busy: boolean;
  /** A write landed at a revision the board read does not show yet. */
  readonly settling: boolean;
  /** The revision the last landed write answered, while the card on screen is that card. */
  readonly landedAt: number | null;
  readonly begin: () => void;
  readonly landed: (revision: number) => void;
  readonly end: () => void;
};

const useCardWrites = (task: Task): CardWrites => {
  const [busy, setBusy] = useState(false);
  const [landed, setLanded] = useState<Landed>(null);
  const landedAt = landedOn(landed, task);
  return {
    busy,
    settling: awaitingMove(landedAt, task),
    landedAt,
    begin: () => setBusy(true),
    landed: (revision) =>
      setLanded((previous) => recordLanding(previous, task.id, revision)),
    end: () => setBusy(false),
  };
};

/**
 * The card pane's moves (LOB-76): one button per transition the card's column declares, and
 * nothing else (docs/board.md B5).
 *
 * A gated move is offered — the dashboard is a person — but marked: the icon, the gate's name, and
 * an accessible name that says a person is approving something. The click sends the revision this
 * pane rendered; a refusal is shown with the service's own words, and the card is not moved here
 * either way — the lanes move it when the server's next answer says it moved.
 *
 * Two things follow the card rather than the click. A refusal is shown only while the card is still
 * at the revision the server refused at: once it moves on (a CLI move, a poll), the refusal is about
 * a card that is gone. And after a move lands the buttons stay disabled until the board read shows
 * the revision the server answered, so a second click cannot send the old revision and be refused as
 * stale for the person's own move. The hold is the pane's (`CardWrites`), shared with the Thread.
 */
const Moves = ({
  boardId,
  task,
  definition,
  writes,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly definition: BoardDefinition;
  readonly writes: CardWrites;
}) => {
  const move = useAtomSet(moveTaskAtom, { mode: "promiseExit" });
  const refreshBoard = useAtomRefresh(boardAtom(boardId));
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<MoveRefusal | null>(null);
  const moves = offeredMoves(task, definition);
  const shown = refusalIsCurrent(refusal, task) ? refusal : null;

  return (
    <section aria-label="Moves" className="flex flex-col gap-2">
      <h2 className="text-[11px] font-medium text-muted-foreground uppercase">
        Move
      </h2>
      {moves.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-no-moves>
          {task.column} declares no moves: the card is finished.
        </p>
      ) : (
        <ul
          aria-label={`Moves out of ${task.column}`}
          className="flex flex-col gap-1.5"
        >
          {moves.map((offered) => (
            <li key={offered.to}>
              <Button
                type="button"
                variant={offered.gate === undefined ? "outline" : "default"}
                size="sm"
                data-move-to={offered.to}
                data-human-gate={offered.gate}
                aria-label={
                  offered.gate === undefined
                    ? `Move to ${offered.to}`
                    : `Move to ${offered.to}: the ${offered.gate} gate, a person's move`
                }
                disabled={pending !== null || writes.busy || writes.settling}
                aria-busy={pending === offered.to}
                className="w-full justify-start"
                onClick={() => {
                  const sent = task.revision;
                  setPending(offered.to);
                  writes.begin();
                  setRefusal(null);
                  void move({
                    taskId: task.id,
                    expectedRevision: sent,
                    to: offered.to,
                    actor: DASHBOARD_ACTOR,
                  })
                    .then((exit) => {
                      if (Exit.isSuccess(exit)) {
                        writes.landed(exit.value.revision);
                        return;
                      }
                      setRefusal(
                        moveRefusal(
                          Option.getOrUndefined(
                            Cause.findErrorOption(exit.cause),
                          ),
                          Cause.pretty(exit.cause),
                          sent,
                        ),
                      );
                      // The view the click was made from is stale or wrong: read the server's
                      // truth again, so the next attempt expects the revision it actually holds.
                      refreshBoard();
                    })
                    .finally(() => {
                      setPending(null);
                      writes.end();
                    });
                }}
              >
                {pending === offered.to ? (
                  <Spinner className="size-3.5" />
                ) : offered.gate === undefined ? (
                  <ArrowRightIcon className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <UserCheckIcon className="size-3.5" strokeWidth={1.75} />
                )}
                <span className="font-mono text-[11px]">{offered.to}</span>
                {offered.gate === undefined ? null : (
                  <span className="ml-auto font-mono text-[10px] tracking-wide uppercase opacity-80">
                    person · {offered.gate}
                  </span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {shown === null ? null : (
        <Alert variant="destructive" role="alert" data-move-refusal={shown.tag}>
          <AlertTitle>{shown.title}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-[11px] break-words">
              {shown.message}
            </span>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
};

const BLOCK_FROM: Readonly<Record<TaskBlocked["reason"], string>> = {
  dependency: "waiting on a dependency",
  needs_input: "needs input",
  capability: "missing a capability",
  transient: "a transient failure",
};

/**
 * The card's thread (LOB-239, B7): the question a parked run asked, a person's answer, and every
 * note, oldest first, each with its kind, its actor and its time, and its body verbatim — whitespace
 * kept, nothing wrapped into a paraphrase, because the next run on the card is quoted the same text.
 *
 * The composer is `commentTask` at the revision this pane rendered, as the dashboard (a person). On a
 * card blocked `needs_input` the send is the answer, and the server lifts the block in the same
 * transaction; the pane says so before the send (the button reads **Answer**) and after it (the
 * block it lifted). A stale revision — the card changed while the person typed — is refused by the
 * server, and the pane re-reads the card and its thread and keeps the draft: nothing typed is lost,
 * and nothing is resent behind the person's back, since someone else's answer may already have made
 * theirs a note.
 *
 * A send typed on while it is in flight keeps what was typed after it: only the sent text is cleared.
 * Like a move, a landed comment holds both the composer and the moves until the board read shows it
 * (`CardWrites`): an answer lands two revisions on, and the old one would be refused as stale.
 *
 * The attention view's question rows open the pane at `#thread`; the section then scrolls into view
 * and the composer takes the focus, so the person lands where the answer is typed.
 */
const Thread = ({
  boardId,
  task,
  writes,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly writes: CardWrites;
}) => {
  const thread = useAtomValue(taskCommentsAtom(task.id));
  const refreshThread = useAtomRefresh(taskCommentsAtom(task.id));
  const refreshBoard = useAtomRefresh(boardAtom(boardId));
  const comment = useAtomSet(commentTaskAtom, { mode: "promiseExit" });
  const hash = useLocation({ select: (location) => location.hash });
  const section = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<CommentRefusal | null>(null);
  const [lifted, setLifted] = useState<TaskBlocked | undefined>(undefined);
  const intent = composerIntent(task);
  const ready = sendable(draft);
  const held = pending || writes.busy || writes.settling;
  const { landedAt } = writes;
  // As with a move: a refusal describes the revision the server refused at and no later one.
  const shown = refusalIsCurrent(refusal, task) ? refusal : null;
  // The lifted block stays on screen until the card is blocked again by something after the answer.
  const liftedShown =
    lifted !== undefined &&
    (task.blocked === undefined ||
      (landedAt !== null && task.revision < landedAt))
      ? lifted
      : undefined;
  // The last answer stays on screen through a failed refresh; only a first read that fails says so.
  const listed = Option.getOrUndefined(AsyncResult.value(thread));

  useEffect(() => {
    if (hash !== THREAD_ANCHOR) return;
    section.current?.scrollIntoView({ block: "start" });
    composer.current?.focus({ preventScroll: true });
  }, [hash]);

  const send = () => {
    if (!ready.ok || held) return;
    const sent = task.revision;
    const before = task;
    const body = draft;
    setPending(true);
    writes.begin();
    setRefusal(null);
    void comment({
      taskId: task.id,
      expectedRevision: sent,
      body,
      actor: DASHBOARD_ACTOR,
    })
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setDraft((current) => draftAfterSend(current, body));
          writes.landed(exit.value.revision);
          setLifted(liftedBlock(before, exit.value));
          return;
        }
        setRefusal(
          commentRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
            sent,
          ),
        );
        // The draft stays where it is; the card and its thread are read again, so the next send
        // expects the revision the server holds and the person sees what changed before they send.
        refreshBoard();
        refreshThread();
      })
      .finally(() => {
        setPending(false);
        writes.end();
      });
  };

  return (
    <section
      ref={section}
      id={THREAD_ANCHOR}
      aria-label="Thread"
      data-thread={task.id}
      className="flex scroll-mt-3 flex-col gap-2"
    >
      <h2 className="flex items-baseline gap-2 text-[11px] font-medium text-muted-foreground uppercase">
        Thread
        {listed === undefined ? null : (
          <span className="font-mono text-[10px]" data-thread-count>
            {listed.length}
          </span>
        )}
      </h2>
      {listed === undefined ? (
        AsyncResult.isFailure(thread) ? (
          <p className="text-xs text-destructive">
            The thread did not load: {Cause.pretty(thread.cause)}
          </p>
        ) : (
          <Spinner className="size-3.5 text-muted-foreground" />
        )
      ) : listed.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-thread-empty>
          No comment on this card yet.
        </p>
      ) : (
        <ol
          aria-label="Comments, oldest first"
          className="flex flex-col gap-1.5"
        >
          {listed.map((entry, index) => (
            <li
              key={`${entry.revision}:${index}`}
              data-comment-kind={entry.kind}
              data-comment-actor={entry.actor}
              data-comment-revision={entry.revision}
              className={cn(
                "flex flex-col gap-1 border border-border px-2.5 py-2",
                entry.kind === "question" && "border-l-2 border-l-amber-500",
                entry.kind === "answer" && "border-l-2 border-l-emerald-500",
              )}
            >
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                <span
                  className="font-medium tracking-wide text-foreground uppercase"
                  data-comment-kind-label
                >
                  {commentKindLabel(entry.kind)}
                </span>
                <span className="truncate" data-comment-by>
                  {entry.actor}
                </span>
                <span>r{entry.revision}</span>
                <time
                  dateTime={entry.createdAt}
                  className="ml-auto shrink-0"
                  data-comment-at
                >
                  {commentTime(entry.createdAt)}
                </time>
              </span>
              <p
                className="text-xs leading-snug break-words whitespace-pre-wrap"
                data-comment-body
              >
                {entry.body}
              </p>
            </li>
          ))}
        </ol>
      )}
      {liftedShown === undefined ? null : (
        <p
          role="status"
          data-thread-lifted={liftedShown.reason}
          className="flex items-start gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400"
        >
          <CheckIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
          Answered: the card is no longer blocked (
          {BLOCK_FROM[liftedShown.reason]} from {liftedShown.column}). The next
          run on it reads the answer in its prompt.
        </p>
      )}
      <form
        aria-label={intent.answers ? "Answer the question" : "Comment"}
        className="flex flex-col gap-1.5"
        data-thread-intent={intent.answers ? "answer" : "note"}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Textarea
          ref={composer}
          value={draft}
          data-thread-composer
          aria-label={
            intent.answers ? "Your answer to the question" : "Your comment"
          }
          aria-describedby="thread-intent"
          placeholder={
            intent.answers
              ? "Answer the run's question…"
              : "Add a note to the card…"
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          className="max-h-48 font-mono"
        />
        <div className="flex items-start gap-2">
          <p
            id="thread-intent"
            className="flex-1 text-[11px] text-muted-foreground"
          >
            {intent.answers
              ? `Blocked: needs input from ${intent.from}. Your answer lifts the block, and the next run on the card reads it.`
              : "A note on the card: its column and state do not change."}
            {ready.ok || draft === "" ? null : (
              <span className="block text-destructive" data-thread-unsendable>
                {ready.reason}.
              </span>
            )}
          </p>
          <Button
            type="submit"
            size="sm"
            variant={intent.answers ? "default" : "outline"}
            data-thread-send
            disabled={!ready.ok || held}
            aria-busy={pending}
          >
            {pending ? (
              <Spinner className="size-3.5" />
            ) : (
              <MessageSquareIcon className="size-3.5" strokeWidth={1.75} />
            )}
            {intent.verb}
          </Button>
        </div>
      </form>
      {shown === null ? null : (
        <Alert
          variant="destructive"
          role="alert"
          data-comment-refusal={shown.tag}
        >
          <AlertTitle>{shown.title}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-[11px] break-words">
              {shown.message}
            </span>
            <span className="block text-[11px]">
              Your text is still in the box. The card and its thread were read
              again: check them, then send it again if it still stands.
            </span>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
};

/**
 * The card's runs (LOB-76): start one from the card, and list every one started against it.
 *
 * A run is one Pi Durable session (B1), so the list is `task_runs` and each row opens that session
 * as the run pane below. The start is offered only from a working column (B4); elsewhere the button
 * is disabled and says why, rather than vanishing.
 *
 * Start run opens a prompt field holding the card's default prompt (C6: its title, its body and the
 * column's instruction, the text `factory board start` sends with no `--prompt`), and Send opens the
 * run and sends the field's text as its first message, so the run is working when the pane shows it.
 */
const Runs = ({
  boardId,
  task,
  definition,
  selected,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly definition: BoardDefinition;
  readonly selected: SessionId | undefined;
}) => {
  const runs = useAtomValue(taskRunsAtom(task.id));
  const start = useAtomSet(startRunAtom, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  // The prompt field: `null` while closed, the text as typed while open, with the column it was
  // built for. It opens with the card as it is now, so a card edited meanwhile is read again by
  // closing and reopening it; a card that moves while it is open is not sent (`moved`).
  const [open, setOpen] = useState<{
    readonly text: string;
    readonly column: string;
  } | null>(null);
  const draft = open === null ? null : open.text;
  const setDraft = (text: string) =>
    setOpen((current) => (current === null ? null : { ...current, text }));
  const allowed = runStart(task, definition);
  const moved = open !== null && open.column !== task.column;
  const ready = startSendable(draft ?? "");
  const sendable = ready.ok && allowed.allowed && !moved;
  // The last answer stays on screen through a failed refresh; only a first read that fails says so.
  const listed = Option.getOrUndefined(AsyncResult.value(runs));

  const send = () => {
    if (draft === null || !sendable || starting) return;
    setStarting(true);
    void start({ task, prompt: draft })
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setOpen(null);
          if (exit.value.sendFailure !== undefined) {
            toast.warning("The run opened, but its first message was refused", {
              description: exit.value.sendFailure,
            });
          }
          void navigate({
            to: "/boards/$boardId",
            params: { boardId },
            search: { card: task.id, run: exit.value.session.id },
          });
          return;
        }
        toast.error("No run was started", {
          description: Cause.pretty(exit.cause),
        });
      })
      .finally(() => setStarting(false));
  };

  return (
    <section aria-label="Runs" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-medium text-muted-foreground uppercase">
          Runs
        </h2>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-start-run
          disabled={!allowed.allowed || starting || draft !== null}
          aria-busy={starting}
          aria-expanded={draft !== null}
          title={
            allowed.allowed
              ? `Start a run from ${allowed.column}`
              : allowed.reason
          }
          aria-describedby={allowed.allowed ? undefined : "run-start-blocked"}
          onClick={() =>
            setOpen({
              text: startPrompt(task, definition),
              column: task.column,
            })
          }
        >
          <PlayIcon className="size-3.5" strokeWidth={1.75} />
          Start run
        </Button>
      </div>
      {draft === null ? null : (
        <form
          aria-label="Start a run"
          data-start-form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <Textarea
            value={draft}
            autoFocus
            data-start-prompt
            aria-label="The run's first message"
            aria-describedby="run-start-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
            className="max-h-64 font-mono"
          />
          <div className="flex items-start gap-2">
            <p
              id="run-start-hint"
              className="flex-1 text-[11px] text-muted-foreground"
            >
              The card's title, its body and this column's instruction. Send
              opens the run and sends this as its first message.
              {ready.ok ? null : (
                <span className="block text-destructive" data-start-unsendable>
                  {ready.reason}.
                </span>
              )}
              {moved ? (
                <span className="block text-destructive" data-start-moved>
                  The card moved from {open.column} to {task.column} while this
                  was open: cancel and start again.
                </span>
              ) : null}
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-start-cancel
              disabled={starting}
              onClick={() => setOpen(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              data-start-send
              disabled={!sendable || starting}
              aria-busy={starting}
            >
              {starting ? (
                <Spinner className="size-3.5" />
              ) : (
                <PlayIcon className="size-3.5" strokeWidth={1.75} />
              )}
              Send
            </Button>
          </div>
        </form>
      )}
      {allowed.allowed ? null : (
        <p id="run-start-blocked" className="text-[11px] text-muted-foreground">
          {allowed.reason}.
        </p>
      )}
      {listed === undefined ? (
        AsyncResult.isFailure(runs) ? (
          <p className="text-xs text-destructive">
            The runs did not load: {Cause.pretty(runs.cause)}
          </p>
        ) : (
          <Spinner className="size-3.5 text-muted-foreground" />
        )
      ) : listed.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-no-runs>
          No run has been started against this card.
        </p>
      ) : (
        <ul aria-label="Runs of this card" className="flex flex-col">
          {listed.map((run) => (
            <li key={run.sessionId} data-run={run.sessionId}>
              <Link
                to="/boards/$boardId"
                params={{ boardId }}
                search={{ card: task.id, run: run.sessionId }}
                aria-current={run.sessionId === selected ? "true" : undefined}
                className={cn(
                  "flex items-baseline gap-2 px-2 py-1.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground",
                  run.sessionId === selected && "bg-muted text-foreground",
                )}
              >
                <span className="truncate">{run.sessionId}</span>
                <span className="shrink-0">from {run.column}</span>
                <span className="ml-auto shrink-0">
                  {run.startedAt.slice(0, 19).replace("T", " ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/**
 * The card's spec (LOB-238): what its newest specifying run declared with the `spec` tool — the goal,
 * the acceptance criteria, the gaps and the open questions — and which run declared it.
 *
 * A card no run has specified says so, rather than rendering nothing, so a pane with no spec cannot
 * be mistaken for one that failed to load. The last answer stays on screen through a failed poll.
 */
const Spec = ({ task }: { readonly task: Task }) => {
  const result = useAtomValue(taskSpecAtom(task.id));
  const loaded = AsyncResult.value(result);
  return (
    <section aria-label="Spec" className="flex flex-col gap-2">
      <h2 className="text-[11px] font-medium text-muted-foreground uppercase">
        Spec
      </h2>
      {Option.isNone(loaded) ? (
        AsyncResult.isFailure(result) ? (
          <p className="text-xs text-destructive">
            The spec did not load: {Cause.pretty(result.cause)}
          </p>
        ) : (
          <Spinner className="size-3.5 text-muted-foreground" />
        )
      ) : loaded.value === null ? (
        <p className="text-xs text-muted-foreground" data-no-spec>
          No run has declared a spec for this card.
        </p>
      ) : (
        <div
          className="flex flex-col gap-2"
          data-spec={loaded.value.sessionId}
          data-spec-revision={loaded.value.revision}
        >
          <p className="text-xs break-words" data-spec-goal>
            {loaded.value.goal}
          </p>
          {specLists(loaded.value).map((list) => (
            <div
              key={list.key}
              className="flex flex-col gap-1"
              data-spec-list={list.key}
              data-spec-count={list.items.length}
            >
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase">
                {list.title}
              </h3>
              {list.items.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {list.empty}
                </p>
              ) : (
                <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px]">
                  {list.items.map((item, index) => (
                    <li key={index} data-spec-item className="break-words">
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="font-mono text-[10px] text-muted-foreground">
            declared by {loaded.value.sessionId} in {loaded.value.column}, r
            {loaded.value.revision}
          </p>
        </div>
      )}
    </section>
  );
};

/**
 * The selected run, as panes inside the card (LOB-76): its transcript and steering (the session
 * pane, composer included), its approvals, and its sandbox. `/sandboxes` and `/approvals` left the
 * rail for here, because each only means something for one run of one card.
 */
const RunPanes = ({ sessionId }: { readonly sessionId: SessionId }) => (
  <Tabs
    defaultValue="transcript"
    className="flex min-h-0 flex-1 flex-col gap-0 border-t border-border"
  >
    <TabsList variant="line" className="shrink-0 px-2">
      <TabsTrigger value="transcript">Transcript</TabsTrigger>
      <TabsTrigger value="approvals">Approvals</TabsTrigger>
      <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
    </TabsList>
    <TabsContent
      value="transcript"
      className="flex min-h-0 flex-1 flex-col"
      data-run-pane={sessionId}
    >
      <SessionPane sessionId={sessionId} />
    </TabsContent>
    <TabsContent value="approvals" className="min-h-0 overflow-y-auto">
      <RunApprovals sessionId={sessionId} />
    </TabsContent>
    <TabsContent value="sandbox" className="p-4">
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <BoxesIcon className="size-4 shrink-0" strokeWidth={1.75} />
        No sandbox: runs execute in the control plane for the MVP (docs/board.md
        B12), and sandbox lifecycle is M4.
      </p>
    </TabsContent>
  </Tabs>
);

/**
 * The card pane (LOB-76): where a person acts on a card — moves it, reads and answers its thread
 * (LOB-239), and starts and opens its runs.
 *
 * It reads the same board answer the lanes do, so the card here and the card in its lane are one
 * value and cannot disagree about the column or the revision a move will expect. Selection lives in
 * the URL (`?card=`, `?run=`), not in this browser: a link to a card opens the same pane anywhere.
 */
export const CardPane = ({
  boardId,
  task,
  definition,
  run,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly definition: BoardDefinition;
  readonly run: SessionId | undefined;
}) => {
  const blocked = blockedLabel(task);
  const external = externalLink(task);
  const writes = useCardWrites(task);
  const runs = useAtomValue(taskRunsAtom(task.id));
  const selection = runSelection(
    run,
    Option.getOrUndefined(AsyncResult.value(runs)),
    AsyncResult.isWaiting(runs),
  );
  return (
    <aside
      aria-label="Card"
      data-card-pane={task.id}
      data-card-pane-column={task.column}
      data-card-pane-revision={task.revision}
      data-card-pane-blocked={task.blocked?.reason}
      className="flex min-h-0 w-[38rem] max-w-[60vw] shrink-0 flex-col border-l border-border bg-background"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-sm font-medium break-words">{task.title}</h2>
          <span className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{task.column}</span>
            <span>r{task.revision}</span>
            <span className="truncate">{task.id}</span>
            {task.priority === "urgent" ? (
              <Badge variant="outline" className="text-[10px] uppercase">
                urgent
              </Badge>
            ) : null}
            {blocked === null ? null : (
              <Badge variant="destructive" className="text-[10px]">
                {blocked}
              </Badge>
            )}
          </span>
          {/* Where the card came from (LOB-254): the tracker issue, linked when the card has a link. */}
          {external === null ? null : external.href === undefined ? (
            <span
              data-card-external={external.label}
              className="truncate font-mono text-[10px] text-muted-foreground"
            >
              {external.label}
            </span>
          ) : (
            <a
              href={external.href}
              target="_blank"
              rel="noreferrer noopener"
              data-card-external={external.label}
              data-card-external-link={external.href}
              aria-label={`Open ${external.label} where it was filed (opens in a new tab)`}
              className="flex min-w-0 items-center gap-1 self-start font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <ExternalLinkIcon
                className="size-3 shrink-0"
                strokeWidth={1.75}
              />
              <span className="truncate">{external.label}</span>
            </a>
          )}
        </div>
        <Link
          to="/boards/$boardId"
          params={{ boardId }}
          search={{}}
          aria-label="Close the card"
          className="grid size-7 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-4" strokeWidth={1.75} />
        </Link>
      </header>
      <div
        className={cn(
          "flex flex-col gap-4 overflow-y-auto px-4 py-3",
          // With no run open the card's own sections take the pane; with one, the run's panes get
          // the larger share and these scroll.
          run === undefined || selection === "none"
            ? "min-h-0 flex-1"
            : "max-h-[45%] shrink-0",
        )}
      >
        <Moves
          key={task.id}
          boardId={boardId}
          task={task}
          definition={definition}
          writes={writes}
        />
        <Thread
          key={`thread:${task.id}`}
          boardId={boardId}
          task={task}
          writes={writes}
        />
        <Spec task={task} />
        <Runs
          boardId={boardId}
          task={task}
          definition={definition}
          selected={run}
        />
      </div>
      {run === undefined || selection === "none" ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          Pick a run to see its transcript, steer it, and answer its approvals.
        </p>
      ) : selection === "loading" ? (
        <div className="border-t border-border px-4 py-3">
          <Spinner className="size-3.5 text-muted-foreground" />
        </div>
      ) : selection === "foreign" ? (
        <p
          className="border-t border-border px-4 py-3 text-xs text-muted-foreground"
          data-run-foreign={run}
        >
          {run} is not a run of this card, so its transcript, composer and
          approvals are not opened here.
        </p>
      ) : (
        <RunPanes key={run} sessionId={run} />
      )}
    </aside>
  );
};
