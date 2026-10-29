import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import type { SessionSummary } from "@repo/domain/Session";
import { startSessionAtom } from "@/lib/atoms/session-atom";
import { serverInfoAtom } from "@/lib/atoms/server-info-atom";
import { costPredictionAtom } from "@/lib/atoms/cost-atom";
import { reposAtom } from "@/lib/atoms/repos-atom";
import { predictionKey, predictionText } from "@/lib/cost-view";
import { modelChoices } from "@/lib/model-picker-view";
import {
  editSessionForm,
  EMPTY_SESSION_FORM,
  newSessionInput,
  NO_REPO,
  repoChoices,
  startRefusal,
  type SessionField,
  type SessionForm,
  type SessionProblem,
} from "@/lib/session-create-view";
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

/**
 * How long the prompt rests before the form asks what it would cost: a prediction is a server read,
 * and one per keystroke would ask for every prefix of the task.
 */
const PREDICT_AFTER_MS = 400;

const SELECT_CLASS =
  "h-8 w-full truncate rounded-none border border-input bg-transparent px-2 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * The "New session" dialog (E6): delegate the operator's own task, on the repo they pick.
 *
 * Opening it creates nothing; only a submit does, with `createSession` exactly as the form built it
 * (`newSessionInput`) and then the prompt as the first message. An answer lands where it was asked
 * only while the opening that sent it is still on screen (`NewSessionForm`): there `onCreated` gets
 * the server's session and a refusal is shown inline. An answer that arrives after the person closed
 * that opening, or after a later one replaced it, is a toast instead: a session with a link to it, or
 * the refusal in the server's words. So an answer never pulls anyone into a pane they left, never
 * closes a form they have since started typing into, and a refusal is never dropped unseen.
 */
export const NewSessionDialog = ({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (session: SessionSummary) => void;
}) => {
  // Whether the dialog is open now. During the close animation the form is still mounted, so its own
  // mount alone does not say the person is still on it.
  const shown = useRef(open);
  useEffect(() => {
    shown.current = open;
    return () => {
      shown.current = false;
    };
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent data-new-session-dialog className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Delegate a task. On a repository, the session works in a worktree of
            its own on{" "}
            <span className="font-mono">factory/&lt;session&gt;</span>, which is
            what a pull request is opened from.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while the dialog is open, so each opening starts from an empty form. */}
        <NewSessionForm shown={() => shown.current} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
};

/**
 * The form itself. A problem the payload cannot get past (an empty prompt, a budget that is not an
 * amount, a cap with nothing to cap at) is shown on its field and sends nothing. A refusal the server
 * gives (a base ref the checkout does not have, a model it does not serve, at capacity) is shown
 * inline in the server's words, and the form keeps everything typed, so the person fixes one field
 * instead of retyping the task.
 */
const NewSessionForm = ({
  shown,
  onCreated,
}: {
  readonly shown: () => boolean;
  readonly onCreated: (session: SessionSummary) => void;
}) => {
  const start = useAtomSet(startSessionAtom, { mode: "promiseExit" });
  // This opening of the dialog: each opening mounts a form of its own, so an answer to a submit made
  // here is this form's to show only while this form is still mounted and the dialog still open.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stillHere = () => mounted.current && shown();
  const [form, setForm] = useState<SessionForm>(EMPTY_SESSION_FORM);
  const [problem, setProblem] = useState<SessionProblem | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The model the session is created on (LOB-274): the server's catalog, or its default. A server
  // that has not answered (or could not) leaves only the default, which still starts one.
  const info = useAtomValue(serverInfoAtom);
  const models = modelChoices(
    AsyncResult.isSuccess(info) ? info.value : undefined,
  );
  // The repositories the factory knows (LOB-253), or none yet: a scratch session needs none.
  const reposResult = useAtomValue(reposAtom);
  const repos = repoChoices(
    AsyncResult.isSuccess(reposResult) ? reposResult.value : undefined,
  );
  const chosenRepo = repos.find((choice) => choice.repo === form.repo);

  // What the session would cost, before it exists (LOB-38): a range from the completed sessions most
  // like it, on the model and repo picked. Asked once the prompt rests, and not at all while it is
  // blank. Capping at its high is a choice only a range can offer.
  const settledPrompt = useSettled(form.prompt, PREDICT_AFTER_MS);
  const asked = settledPrompt.trim() !== "";
  const prediction = useAtomValue(
    costPredictionAtom(
      predictionKey(
        asked ? settledPrompt : "",
        form.model,
        form.repo ?? NO_REPO,
      ),
    ),
  );
  const predicted =
    asked && settledPrompt === form.prompt && AsyncResult.isSuccess(prediction)
      ? prediction.value
      : undefined;
  const canCap = predicted?.range !== undefined;

  const edit = <K extends keyof SessionForm>(
    field: K,
    value: SessionForm[K],
  ) => {
    setForm((previous) => editSessionForm(previous, field, value));
    setProblem(null);
    setRefusal(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = newSessionInput(form, predicted);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setRefusal(null);
    setPending(true);
    void start(parsed.start)
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          const { session, sendFailure } = exit.value;
          // The session exists either way: open it, and say the prompt did not reach it.
          if (sendFailure !== undefined) {
            toast.error("The session was created, but its prompt was refused", {
              description: sendFailure,
            });
          }
          if (stillHere()) {
            onCreated(session);
            return;
          }
          toast.success("Session started", {
            description: session.id,
            action: { label: "Open", onClick: () => onCreated(session) },
          });
          return;
        }
        const refused = startRefusal(
          Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
          Cause.pretty(exit.cause),
        );
        if (stillHere()) {
          setRefusal(refused);
          return;
        }
        // The form that would show it is gone: the refusal is still the person's to see.
        toast.error("No session was created", { description: refused });
      })
      .finally(() => setPending(false));
  };

  const invalid = (field: SessionField) =>
    problem?.field === field ? true : undefined;
  const describedBy = (field: SessionField, help?: string) =>
    [problem?.field === field ? "new-session-problem" : undefined, help]
      .filter((id) => id !== undefined)
      .join(" ") || undefined;

  return (
    <form
      data-session-form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-session-prompt">Prompt</Label>
        <Textarea
          id="new-session-prompt"
          name="prompt"
          value={form.prompt}
          onChange={(event) => edit("prompt", event.currentTarget.value)}
          placeholder="Pin the Postgres major in compose, and say why in the PR."
          autoFocus
          aria-required
          aria-invalid={invalid("prompt")}
          aria-describedby={describedBy("prompt")}
          className="max-h-64 min-h-28"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-session-repo">Repository</Label>
          <select
            id="new-session-repo"
            name="repo"
            value={form.repo ?? NO_REPO}
            onChange={(event) => {
              const chosen = repos.find(
                (choice) => choice.value === event.currentTarget.value,
              );
              // A cap ticked for the old repo's range is unticked (`editSessionForm`).
              if (chosen !== undefined) edit("repo", chosen.repo);
            }}
            className={SELECT_CLASS}
          >
            {repos.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-session-base">Base ref (optional)</Label>
          <Input
            id="new-session-base"
            name="baseRef"
            value={form.baseRef}
            onChange={(event) => edit("baseRef", event.currentTarget.value)}
            placeholder={chosenRepo?.defaultBaseRef ?? "main"}
            disabled={form.repo === undefined}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="new-session-base-help"
            className="font-mono"
          />
        </div>
      </div>
      <p
        id="new-session-base-help"
        className="text-[11px] text-muted-foreground"
      >
        {form.repo === undefined
          ? "No repo: the session works in a scratch directory, cuts no worktree and opens no pull request."
          : `The branch, tag or commit the worktree is cut from. Blank is the repository's default (${chosenRepo?.defaultBaseRef ?? "main"}).`}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-session-model">Model</Label>
          <select
            id="new-session-model"
            name="model"
            value={form.model}
            // A cap ticked for the old model's range is unticked (`editSessionForm`).
            onChange={(event) => edit("model", event.currentTarget.value)}
            className={SELECT_CLASS}
          >
            {models.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-session-budget">Budget, US$ (optional)</Label>
          <Input
            id="new-session-budget"
            name="budget"
            inputMode="decimal"
            value={
              form.capped && predicted?.range !== undefined
                ? String(predicted.range.high)
                : form.budget
            }
            onChange={(event) => edit("budget", event.currentTarget.value)}
            placeholder="none"
            disabled={form.capped}
            autoComplete="off"
            aria-invalid={invalid("budget")}
            aria-describedby={describedBy("budget")}
            className="font-mono"
          />
        </div>
      </div>
      <p
        data-cost-prediction={predicted?.basis}
        data-cost-low={predicted?.range?.low}
        data-cost-high={predicted?.range?.high}
        className="font-mono text-[10px] leading-relaxed text-muted-foreground"
      >
        {!asked && form.prompt.trim() === ""
          ? "Type the task to see what it is predicted to cost"
          : predicted !== undefined
            ? predictionText(predicted)
            : AsyncResult.isFailure(prediction) && settledPrompt === form.prompt
              ? "No estimate: the prediction did not load"
              : "Predicting the cost…"}
      </p>
      <label
        htmlFor="new-session-cap"
        className="flex items-center gap-2 text-[11px] text-muted-foreground"
      >
        <input
          id="new-session-cap"
          name="cap"
          type="checkbox"
          checked={form.capped}
          // Once ticked it can always be unticked, even if the range it was ticked for is gone.
          disabled={!canCap && !form.capped}
          onChange={(event) => edit("capped", event.currentTarget.checked)}
          aria-invalid={invalid("cap")}
          aria-describedby={describedBy("cap")}
          className="size-3"
        />
        Cap at predicted high
      </label>
      <label
        htmlFor="new-session-open-pr"
        className="flex items-center gap-2 text-[11px] text-muted-foreground"
      >
        <input
          id="new-session-open-pr"
          name="openPr"
          type="checkbox"
          checked={form.openPr && form.repo !== undefined}
          // A scratch session has no branch to publish.
          disabled={form.repo === undefined}
          onChange={(event) => edit("openPr", event.currentTarget.checked)}
          className="size-3"
        />
        Open a PR when done
      </label>
      {problem === null ? null : (
        <p
          id="new-session-problem"
          role="alert"
          data-session-problem={problem.field}
          className="text-xs text-destructive"
        >
          {problem.message}
        </p>
      )}
      {refusal === null ? null : (
        <p
          role="alert"
          data-session-refusal=""
          className="text-xs break-words text-destructive"
        >
          The server refused the session: {refusal}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button
          type="submit"
          data-session-submit
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlusIcon className="size-4" strokeWidth={1.75} />
          )}
          Start session
        </Button>
      </DialogFooter>
    </form>
  );
};

/** `value` once it has stopped changing for `ms`: what a read keyed on typing is keyed on. */
const useSettled = (value: string, ms: number): string => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    // oxlint-disable-next-line effecttsgo/global-timers -- the debounce is UI state, not a modeled Effect timer.
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
};
