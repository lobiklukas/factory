import { useState, type FormEvent } from "react";
import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import type { RepoSlug } from "@repo/domain/Session";
import type { BoardInstanceId, Task, TaskPriority } from "@repo/domain/Task";
import { createTaskAtom } from "@/lib/atoms/board-atom";
import {
  createCardInput,
  createRefusal,
  EMPTY_CARD_FORM,
  type CardForm,
  type CardProblem,
} from "@/lib/card-create-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

const PRIORITIES: ReadonlyArray<{
  readonly value: TaskPriority;
  readonly label: string;
}> = [
  { value: "normal", label: "Normal" },
  { value: "urgent", label: "Urgent: first in its lane" },
];

/**
 * The "New card" dialog (LOB-275): delegate work from the board, without a terminal.
 *
 * Open while the URL says so (`?new=card`, `NEW_CARD`), so the board header's action, a reload, and
 * any page that links to it (C9's empty states, planned) all open the same form. The card is the
 * board's: the repository is the board's (LOB-255) and is shown, not asked for, and the column is
 * the definition's initial one (LOB-267). `onCreated` gets the server's card; the lanes show it from
 * the board read, never from this answer.
 */
export const NewCardDialog = ({
  boardId,
  repo,
  column,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly boardId: BoardInstanceId;
  readonly repo: RepoSlug;
  readonly column: string | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (task: Task) => void;
}) => (
  <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
    <DialogContent data-new-card-dialog className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>New card</DialogTitle>
        <DialogDescription>
          On <span className="font-mono">{repo}</span>, opening in{" "}
          <span className="font-mono">{column ?? "the first column"}</span>. A
          run started on it is told the title and the body.
        </DialogDescription>
      </DialogHeader>
      {/* Mounted only while the dialog is open, so each opening starts from an empty form. */}
      <NewCardForm boardId={boardId} onCreated={onCreated} />
    </DialogContent>
  </Dialog>
);

/**
 * The form itself: `createTask` as the dashboard. A problem the payload cannot get past (an empty
 * title, a body over its cap) is shown inline on the field and sends nothing. A refusal the server
 * gives (a base ref no run can start from) is a toast in the server's words, and the form keeps
 * everything typed, so the person fixes one field instead of retyping the card.
 */
const NewCardForm = ({
  boardId,
  onCreated,
}: {
  readonly boardId: BoardInstanceId;
  readonly onCreated: (task: Task) => void;
}) => {
  const create = useAtomSet(createTaskAtom, { mode: "promiseExit" });
  const [form, setForm] = useState<CardForm>(EMPTY_CARD_FORM);
  const [problem, setProblem] = useState<CardProblem | null>(null);
  const [pending, setPending] = useState(false);

  const edit = <K extends keyof CardForm>(field: K, value: CardForm[K]) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setProblem(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = createCardInput(boardId, form);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setPending(true);
    void create(parsed.input)
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          onCreated(exit.value);
          return;
        }
        const refusal = createRefusal(
          Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
          Cause.pretty(exit.cause),
        );
        toast.error("The card was not created", {
          description: refusal.message,
        });
      })
      .finally(() => setPending(false));
  };

  const invalid = (field: CardProblem["field"]) =>
    problem?.field === field ? true : undefined;
  const describedBy = (field: CardProblem["field"], help?: string) =>
    [problem?.field === field ? "new-card-problem" : undefined, help]
      .filter((id) => id !== undefined)
      .join(" ") || undefined;

  return (
    <form
      data-card-form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-card-title">Title</Label>
        <Input
          id="new-card-title"
          name="title"
          value={form.title}
          onChange={(event) => edit("title", event.currentTarget.value)}
          placeholder="Pin the Postgres major in compose"
          autoComplete="off"
          aria-required
          aria-invalid={invalid("title")}
          aria-describedby={describedBy("title")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-card-body">Body (markdown, optional)</Label>
        <Textarea
          id="new-card-body"
          name="body"
          value={form.body}
          onChange={(event) => edit("body", event.currentTarget.value)}
          placeholder={
            "## Goal\n\nWhat done looks like, and what to leave alone."
          }
          spellCheck={false}
          aria-invalid={invalid("body")}
          aria-describedby={describedBy("body")}
          className="max-h-64 min-h-28 font-mono"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-card-priority">Priority</Label>
          <select
            id="new-card-priority"
            name="priority"
            value={form.priority}
            onChange={(event) => {
              const chosen = PRIORITIES.find(
                (priority) => priority.value === event.currentTarget.value,
              );
              if (chosen !== undefined) edit("priority", chosen.value);
            }}
            className="h-8 w-full rounded-none border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            {PRIORITIES.map((priority) => (
              <option key={priority.value} value={priority.value}>
                {priority.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-card-base">Base ref (optional)</Label>
          <Input
            id="new-card-base"
            name="baseRef"
            value={form.baseRef}
            onChange={(event) => edit("baseRef", event.currentTarget.value)}
            placeholder="main"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid("baseRef")}
            aria-describedby={describedBy("baseRef", "new-card-base-help")}
            className="font-mono"
          />
        </div>
      </div>
      <p id="new-card-base-help" className="text-[11px] text-muted-foreground">
        The branch, tag or commit its runs cut their worktree from. Blank is the
        repository&apos;s default.
      </p>
      {problem === null ? null : (
        <p
          id="new-card-problem"
          role="alert"
          data-card-problem={problem.field}
          className="text-xs text-destructive"
        >
          {problem.message}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button
          type="submit"
          data-card-submit
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlusIcon className="size-4" strokeWidth={1.75} />
          )}
          Create card
        </Button>
      </DialogFooter>
    </form>
  );
};
