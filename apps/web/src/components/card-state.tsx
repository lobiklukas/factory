import { useState, type FormEvent } from "react";
import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import {
  CheckIcon,
  FlagIcon,
  PencilIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import type { BlockReason, BoardInstanceId, Task } from "@repo/domain/Task";
import {
  blockTaskAtom,
  boardAtom,
  unblockTaskAtom,
  updateTaskAtom,
} from "@/lib/atoms/board-atom";
import {
  blockedLabel,
  refusalIsCurrent,
  type RefusedWith,
} from "@/lib/board-view";
import {
  BLOCK_REASONS,
  blockNote,
  cardEditRefusal,
  otherPriority,
  titleDraft,
  type CardEditRefusal,
} from "@/lib/card-edit-view";
import { DASHBOARD_ACTOR } from "@/lib/approvals-view";
import type { CardWrites } from "@/components/card-pane";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * One state write from the card pane (C11), the way a move is one (LOB-76, LOB-239): it sends the
 * revision on screen, never a fresh read, and holds the pane's other writes while it is in flight and
 * until the board read shows the revision it answered (`CardWrites`). A refusal is the server's own
 * words, kept only while the card is still at the revision it refused at, and the board is read
 * again so the next press expects the revision the server actually holds.
 */
const useStateWrite = (
  boardId: BoardInstanceId,
  task: Task,
  writes: CardWrites,
) => {
  const refreshBoard = useAtomRefresh(boardAtom(boardId));
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<CardEditRefusal | null>(null);
  const shown = refusalIsCurrent(refusal, task) ? refusal : null;
  return {
    pending,
    held: pending || writes.busy || writes.settling,
    refusal: shown,
    clearRefusal: () => setRefusal(null),
    send: <E extends RefusedWith>(
      write: (revision: number) => Promise<Exit.Exit<Task, E>>,
      onLanded: () => void,
    ) => {
      const sent = task.revision;
      setPending(true);
      writes.begin();
      setRefusal(null);
      void write(sent)
        .then((exit) => {
          if (Exit.isSuccess(exit)) {
            writes.landed(exit.value.revision);
            onLanded();
            return;
          }
          setRefusal(
            cardEditRefusal(
              Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
              Cause.pretty(exit.cause),
              sent,
            ),
          );
          refreshBoard();
        })
        .finally(() => {
          setPending(false);
          writes.end();
        });
    },
  };
};

const Refused = ({ refusal }: { readonly refusal: CardEditRefusal | null }) =>
  refusal === null ? null : (
    <Alert
      variant="destructive"
      role="alert"
      data-card-edit-refusal={refusal.tag}
    >
      <AlertTitle>{refusal.title}</AlertTitle>
      <AlertDescription>
        <span className="font-mono text-[11px] break-words">
          {refusal.message}
        </span>
      </AlertDescription>
    </Alert>
  );

/**
 * The card's heading (C11): its title, which a pencil turns into an input (Enter saves, Escape
 * leaves it), and its priority, a toggle that flags the card urgent or clears the flag. Both are
 * `updateTask` at the revision on screen, and a draft that is blank, over-long or the card's own
 * title is not sent (`titleDraft`). Keyed by card, so one card's half-typed title is not carried to
 * the next one opened.
 */
export const CardHeading = ({
  boardId,
  task,
  writes,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly writes: CardWrites;
}) => {
  const update = useAtomSet(updateTaskAtom, { mode: "promiseExit" });
  const write = useStateWrite(boardId, task, writes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const checked = titleDraft(draft, task);
  const blocked = blockedLabel(task);

  const saveTitle = (event: FormEvent) => {
    event.preventDefault();
    if (!checked.ok || write.held) return;
    write.send(
      (revision) =>
        update({
          taskId: task.id,
          expectedRevision: revision,
          title: checked.title,
          actor: DASHBOARD_ACTOR,
        }),
      () => setEditing(false),
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {editing ? (
        <form
          aria-label="Edit the title"
          className="flex items-center gap-1.5"
          data-card-title-form
          onSubmit={saveTitle}
        >
          <Input
            autoFocus
            value={draft}
            aria-label="The card's title"
            data-card-title-input
            aria-invalid={!checked.ok && draft !== task.title}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="default"
            aria-label="Save the title"
            data-card-title-save
            disabled={!checked.ok || write.held}
            aria-busy={write.pending}
          >
            {write.pending ? (
              <Spinner className="size-3.5" />
            ) : (
              <CheckIcon className="size-3.5" strokeWidth={1.75} />
            )}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel the edit"
            onClick={() => setEditing(false)}
          >
            <XIcon className="size-3.5" strokeWidth={1.75} />
          </Button>
        </form>
      ) : (
        <h2 className="flex items-start gap-1.5 text-sm font-medium break-words">
          <span data-card-title>{task.title}</span>
          <button
            type="button"
            aria-label="Edit the title"
            data-card-title-edit
            className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setDraft(task.title);
              write.clearRefusal();
              setEditing(true);
            }}
          >
            <PencilIcon className="size-3" strokeWidth={1.75} />
          </button>
        </h2>
      )}
      {editing && !checked.ok && draft !== task.title ? (
        <p className="text-[11px] text-destructive" data-card-title-problem>
          {checked.reason}.
        </p>
      ) : null}
      <span className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <span>{task.column}</span>
        <span>r{task.revision}</span>
        <span className="truncate">{task.id}</span>
        <button
          type="button"
          data-card-priority={task.priority}
          aria-label={
            task.priority === "urgent"
              ? "Urgent: clear the flag"
              : "Mark the card urgent"
          }
          aria-pressed={task.priority === "urgent"}
          disabled={write.held}
          aria-busy={write.pending}
          className="disabled:opacity-50"
          onClick={() =>
            write.send(
              (revision) =>
                update({
                  taskId: task.id,
                  expectedRevision: revision,
                  priority: otherPriority(task.priority),
                  actor: DASHBOARD_ACTOR,
                }),
              () => {},
            )
          }
        >
          {task.priority === "urgent" ? (
            <Badge variant="outline" className="text-[10px] uppercase">
              <FlagIcon className="size-2.5" strokeWidth={1.75} />
              urgent
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground uppercase"
            >
              <FlagIcon className="size-2.5" strokeWidth={1.75} />
              mark urgent
            </Badge>
          )}
        </button>
        {blocked === null ? null : (
          <Badge variant="destructive" className="text-[10px]">
            {blocked}
          </Badge>
        )}
      </span>
      <Refused refusal={write.refusal} />
    </div>
  );
};

/**
 * The card's block (C11, B4): park it on a reason and a note, or lift the park. A block is a state,
 * not a column, so the card stays in its lane and the lane shows it. A card that is not blocked
 * offers **Block**, which opens a form (the reason, an optional note); one that is offers
 * **Unblock** and says what it waits on. Both send the revision on screen. A `needs_input` block
 * is a run's question and an answer in the thread lifts it, so the pane says so rather than
 * offering a second way to lift it blind.
 */
export const BlockControl = ({
  boardId,
  task,
  writes,
}: {
  readonly boardId: BoardInstanceId;
  readonly task: Task;
  readonly writes: CardWrites;
}) => {
  const block = useAtomSet(blockTaskAtom, { mode: "promiseExit" });
  const unblock = useAtomSet(unblockTaskAtom, { mode: "promiseExit" });
  const write = useStateWrite(boardId, task, writes);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<BlockReason>("dependency");
  const [note, setNote] = useState("");
  const blocked = task.blocked;

  return (
    <section
      aria-label="Block"
      data-card-block={blocked?.reason ?? "none"}
      className="flex flex-col gap-2"
    >
      <h2 className="text-[11px] font-medium text-muted-foreground uppercase">
        State
      </h2>
      {blocked !== undefined ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs">
            Blocked in {blocked.column}: {blockedLabel(task)}.
            {blocked.reason === "needs_input"
              ? " An answer in the thread lifts it."
              : null}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-card-unblock
            aria-label="Unblock the card"
            disabled={write.held}
            aria-busy={write.pending}
            className="w-full justify-start"
            onClick={() =>
              write.send(
                (revision) =>
                  unblock({
                    taskId: task.id,
                    expectedRevision: revision,
                    actor: DASHBOARD_ACTOR,
                  }),
                // A form left open from before the block would reopen under the lifted card.
                () => setOpen(false),
              )
            }
          >
            {write.pending ? (
              <Spinner className="size-3.5" />
            ) : (
              <PlayIcon className="size-3.5" strokeWidth={1.75} />
            )}
            Unblock
          </Button>
        </div>
      ) : open ? (
        <form
          aria-label="Block the card"
          className="flex flex-col gap-2"
          data-card-block-form
          onSubmit={(event) => {
            event.preventDefault();
            if (write.held) return;
            write.send(
              (revision) => {
                const text = blockNote(note);
                return block({
                  taskId: task.id,
                  expectedRevision: revision,
                  reason,
                  ...(text === undefined ? {} : { note: text }),
                  actor: DASHBOARD_ACTOR,
                });
              },
              () => {
                setOpen(false);
                setNote("");
              },
            );
          }}
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">Why the card is blocked</legend>
            {BLOCK_REASONS.map((option) => (
              <label
                key={option.reason}
                className={cn(
                  "flex items-center gap-2 text-xs",
                  reason === option.reason && "font-medium",
                )}
              >
                <input
                  type="radio"
                  name="block-reason"
                  value={option.reason}
                  data-block-reason={option.reason}
                  checked={reason === option.reason}
                  onChange={() => setReason(option.reason)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <Textarea
            value={note}
            aria-label="What the card is waiting on"
            data-card-block-note-input
            placeholder="What is it waiting on? (optional)"
            onChange={(event) => setNote(event.target.value)}
            className="max-h-32 font-mono"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              data-card-block-submit
              disabled={write.held}
              aria-busy={write.pending}
            >
              {write.pending ? (
                <Spinner className="size-3.5" />
              ) : (
                <PauseIcon className="size-3.5" strokeWidth={1.75} />
              )}
              Block
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-card-block-open
          aria-label="Block the card"
          disabled={write.held}
          className="w-full justify-start"
          onClick={() => {
            write.clearRefusal();
            setOpen(true);
          }}
        >
          <PauseIcon className="size-3.5" strokeWidth={1.75} />
          Block…
        </Button>
      )}
      <Refused refusal={write.refusal} />
    </section>
  );
};
