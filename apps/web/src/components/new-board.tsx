import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option, Schema } from "effect";
import { PlusIcon } from "lucide-react";
import type { CreatedBoard, DefinitionSummary } from "@repo/domain/Task";
import { BoardInstanceId } from "@repo/domain/Task";
import { createBoardAtom, definitionsAtom } from "@/lib/atoms/board-atom";
import { reposAtom } from "@/lib/atoms/repos-atom";
import {
  boardRefusal,
  createBoardInput,
  initialBoardForm,
  OTHER_REPO,
  reconcileRepoPick,
  versionChoices,
  type BoardField,
  type BoardForm,
  type BoardProblem,
  type BoardRefusal,
} from "@/lib/board-create-view";
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

const SELECT_CLASS =
  "h-8 w-full rounded-none border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30";

const decodeBoardId = Schema.decodeUnknownOption(BoardInstanceId);

/**
 * The "New board" dialog (C5): bind a repository to a definition version from the dashboard, as
 * `factory board create` does, so an empty control plane no longer sends an operator to a terminal.
 *
 * Open while the URL says so (`/boards?new=board`, `NEW_BOARD`), so the header's action, the empty
 * state, a reload and any page that links to it open the same form. `onCreated` gets the server's
 * board; `/boards` shows it from the list read, never from this answer.
 */
export const NewBoardDialog = ({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (board: CreatedBoard) => void;
}) => {
  // Held here, not in the form, so the dialog can refuse to close under a request in flight: a
  // close (Cancel, the X, Escape, a click outside) would unmount the form while `.then` still
  // navigates to the board it made, taking away a person who had just walked away.
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        data-new-board-dialog
        showCloseButton={!pending}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
          <DialogDescription>
            A board binds one repository to a version of a board definition. The
            version is pinned when the board is made; a repository has one
            board.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while the dialog is open, so each opening reads the lists afresh. */}
        <NewBoardLoader
          pending={pending}
          setPending={setPending}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
};

/**
 * Waits for the definitions (and the registry, when it answers) before showing the form, so the
 * form opens already on the default definition. A registry that fails to read is not fatal: a slug
 * can be typed, because `createBoard` accepts a repository the registry has not seen (it does not
 * register it; the board page warns when that repository has no checkout). A definition list that
 * fails is: there is nothing to pick, and the server's words say why.
 */
const NewBoardLoader = ({
  pending,
  setPending,
  onCreated,
}: {
  readonly pending: boolean;
  readonly setPending: (pending: boolean) => void;
  readonly onCreated: (board: CreatedBoard) => void;
}) => {
  const definitions = useAtomValue(definitionsAtom);
  const repos = useAtomValue(reposAtom);
  if (AsyncResult.isFailure(definitions)) {
    return (
      <p
        role="alert"
        data-board-definitions-failed
        className="text-xs text-destructive"
      >
        The definitions did not load: {Cause.pretty(definitions.cause)}
      </p>
    );
  }
  const loaded = Option.getOrUndefined(AsyncResult.value(definitions));
  if (loaded === undefined || AsyncResult.isInitial(repos)) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Spinner className="size-3.5" />
        Loading definitions and repositories
      </div>
    );
  }
  const registered = AsyncResult.isSuccess(repos)
    ? repos.value.map((repo) => repo.repo as string)
    : [];
  return (
    <NewBoardForm
      definitions={loaded}
      registered={registered}
      pending={pending}
      setPending={setPending}
      onCreated={onCreated}
    />
  );
};

/**
 * The form itself: `createBoard` as the dashboard. A problem the payload cannot get past (a slug
 * outside `owner/name`) is shown on the field and sends nothing. A refusal the server gives
 * (`BoardExists`, `DefinitionNotFound`) is shown in the dialog in the server's own words, with a
 * link to the board that stands in the way for the first, and the form keeps what was chosen.
 */
const NewBoardForm = ({
  definitions,
  registered,
  pending,
  setPending,
  onCreated,
}: {
  readonly definitions: ReadonlyArray<DefinitionSummary>;
  readonly registered: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly setPending: (pending: boolean) => void;
  readonly onCreated: (board: CreatedBoard) => void;
}) => {
  const create = useAtomSet(createBoardAtom, { mode: "promiseExit" });
  const [held, setForm] = useState<BoardForm>(() =>
    initialBoardForm(definitions, registered),
  );
  // The registry re-reads every few seconds and may fail or lose a row; what is shown and what is
  // sent is the form as the current list can honour it, never a pick the list no longer holds.
  const form = reconcileRepoPick(held, registered);
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [refusal, setRefusal] = useState<BoardRefusal | null>(null);

  const edit = (patch: Partial<BoardForm>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setProblem(null);
    setRefusal(null);
  };

  const definition = definitions.find(
    (entry) => entry.id === form.definitionId,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = createBoardInput(form);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      setRefusal(null);
      return;
    }
    setProblem(null);
    setRefusal(null);
    setPending(true);
    void create(parsed.input)
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          onCreated(exit.value);
          return;
        }
        setRefusal(
          boardRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
          ),
        );
      })
      .finally(() => setPending(false));
  };

  const invalid = (field: BoardField) =>
    problem?.field === field ? true : undefined;
  const describedBy = (field: BoardField) =>
    problem?.field === field ? "new-board-problem" : undefined;
  const existing =
    refusal?.existingBoardId === undefined
      ? undefined
      : Option.getOrUndefined(decodeBoardId(refusal.existingBoardId));

  return (
    <form
      data-board-form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-board-repo">Repository</Label>
        {registered.length === 0 ? null : (
          <select
            id="new-board-repo"
            name="repoPick"
            value={form.repoPick}
            onChange={(event) => edit({ repoPick: event.currentTarget.value })}
            aria-invalid={invalid("repo")}
            aria-describedby={describedBy("repo")}
            className={SELECT_CLASS}
          >
            {registered.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
            <option value={OTHER_REPO}>Another repository…</option>
          </select>
        )}
        {registered.length > 0 && form.repoPick !== OTHER_REPO ? null : (
          <Input
            id={
              registered.length === 0 ? "new-board-repo" : "new-board-repo-text"
            }
            name="repoText"
            aria-label={registered.length === 0 ? undefined : "Repository slug"}
            value={form.repoText}
            onChange={(event) =>
              edit({
                repoText: event.currentTarget.value,
                repoPick: OTHER_REPO,
              })
            }
            placeholder="owner/name"
            autoComplete="off"
            spellCheck={false}
            aria-required
            aria-invalid={invalid("repo")}
            aria-describedby={describedBy("repo")}
            className="font-mono"
          />
        )}
        <p className="text-[11px] text-muted-foreground">
          {registered.length === 0
            ? "No repository is registered yet. Type its slug; the board is made, and warns when the repository has no checkout to cut worktrees from."
            : "A registered repository, or another slug. A board over a repository with no checkout is made, and warns that its runs have nothing to cut worktrees from."}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-board-definition">Definition</Label>
          <select
            id="new-board-definition"
            name="definitionId"
            value={form.definitionId}
            onChange={(event) =>
              edit({
                definitionId: event.currentTarget.value,
                version: "",
              })
            }
            aria-invalid={invalid("definition")}
            aria-describedby={describedBy("definition")}
            className={SELECT_CLASS}
          >
            {definitions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-board-version">Version</Label>
          <select
            id="new-board-version"
            name="version"
            value={form.version}
            onChange={(event) => edit({ version: event.currentTarget.value })}
            aria-invalid={invalid("definition")}
            aria-describedby={describedBy("definition")}
            className={SELECT_CLASS}
          >
            {versionChoices(definition).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {problem === null ? null : (
        <p
          id="new-board-problem"
          role="alert"
          data-board-problem={problem.field}
          className="text-xs text-destructive"
        >
          {problem.message}
        </p>
      )}
      {refusal === null ? null : (
        <div
          role="alert"
          data-board-refusal={refusal.tag}
          className="flex flex-col gap-1 text-xs text-destructive"
        >
          <p className="break-words">{refusal.message}</p>
          {existing === undefined ? null : (
            <Link
              to="/boards/$boardId"
              params={{ boardId: existing }}
              data-board-existing={existing}
              className="font-mono underline underline-offset-2"
            >
              Open the existing board {existing}
            </Link>
          )}
        </div>
      )}
      <DialogFooter>
        <DialogClose
          render={<Button type="button" variant="outline" disabled={pending} />}
        >
          Cancel
        </DialogClose>
        <Button
          type="submit"
          data-board-submit
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlusIcon className="size-4" strokeWidth={1.75} />
          )}
          Create board
        </Button>
      </DialogFooter>
    </form>
  );
};
