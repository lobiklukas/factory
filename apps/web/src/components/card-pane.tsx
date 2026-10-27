import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import {
  ArrowRightIcon,
  BoxesIcon,
  PlayIcon,
  UserCheckIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import type { SessionId } from "@repo/domain/Session";
import type { BoardDefinition, BoardInstanceId, Task } from "@repo/domain/Task";
import {
  boardAtom,
  moveTaskAtom,
  startRunAtom,
  taskRunsAtom,
} from "@/lib/atoms/board-atom";
import {
  awaitingMove,
  blockedLabel,
  moveRefusal,
  offeredMoves,
  refusalIsCurrent,
  runSelection,
  runStart,
  type MoveRefusal,
} from "@/lib/board-view";
import { DASHBOARD_ACTOR } from "@/lib/approvals-view";
import { RunApprovals } from "@/components/approvals";
import { SessionPane } from "@/components/session-pane";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
 * stale for the person's own move.
 */
const Moves = ({
  boardId,
  task,
  definition,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly definition: BoardDefinition;
}) => {
  const move = useAtomSet(moveTaskAtom, { mode: "promiseExit" });
  const refreshBoard = useAtomRefresh(boardAtom(boardId));
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<MoveRefusal | null>(null);
  const [landedAt, setLandedAt] = useState<number | null>(null);
  const moves = offeredMoves(task, definition);
  const settling = awaitingMove(landedAt, task);
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
                disabled={pending !== null || settling}
                aria-busy={pending === offered.to}
                className="w-full justify-start"
                onClick={() => {
                  const sent = task.revision;
                  setPending(offered.to);
                  setRefusal(null);
                  void move({
                    taskId: task.id,
                    expectedRevision: sent,
                    to: offered.to,
                    actor: DASHBOARD_ACTOR,
                  })
                    .then((exit) => {
                      if (Exit.isSuccess(exit)) {
                        setLandedAt(exit.value.revision);
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
                    .finally(() => setPending(null));
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

/**
 * The card's runs (LOB-76): start one from the card, and list every one started against it.
 *
 * A run is one Pi Durable session (B1), so the list is `task_runs` and each row opens that session
 * as the run pane below. The start is offered only from a working column (B4); elsewhere the button
 * is disabled and says why, rather than vanishing.
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
  const allowed = runStart(task, definition);
  // The last answer stays on screen through a failed refresh; only a first read that fails says so.
  const listed = Option.getOrUndefined(AsyncResult.value(runs));

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
          disabled={!allowed.allowed || starting}
          aria-busy={starting}
          title={
            allowed.allowed
              ? `Start a run from ${allowed.column}`
              : allowed.reason
          }
          aria-describedby={allowed.allowed ? undefined : "run-start-blocked"}
          onClick={() => {
            setStarting(true);
            void start(task)
              .then((exit) => {
                if (Exit.isSuccess(exit)) {
                  void navigate({
                    to: "/boards/$boardId",
                    params: { boardId },
                    search: { card: task.id, run: exit.value.id },
                  });
                  return;
                }
                toast.error("No run was started", {
                  description: Cause.pretty(exit.cause),
                });
              })
              .finally(() => setStarting(false));
          }}
        >
          {starting ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5" strokeWidth={1.75} />
          )}
          Start run
        </Button>
      </div>
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
 * The card pane (LOB-76): where a person acts on a card.
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
      <div className="flex max-h-[45%] shrink-0 flex-col gap-4 overflow-y-auto px-4 py-3">
        <Moves
          key={task.id}
          boardId={boardId}
          task={task}
          definition={definition}
        />
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
