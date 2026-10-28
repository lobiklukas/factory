import { createFileRoute } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  GitBranchIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RepoSummary } from "@repo/domain/Session";
import { reposAtom, registerRepoAtom } from "@/lib/atoms/repos-atom";
import {
  EMPTY_REPO_FORM,
  notRunnableCount,
  registerInput,
  registerRefusal,
  runnability,
  RUNNABLE_TITLE,
  sameDirectory,
  BASE_REF_HELP,
  urlLabel,
  type RegisterRefusal,
  type RepoForm,
} from "@/lib/repos-view";
import { EmptyPane } from "@/components/empty-pane";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

export const Route = createFileRoute("/repos")({
  component: ReposRoute,
});

/**
 * Repositories (LOB-262): the registry `registerRepo` writes and `listRepos` reads (LOB-253), and
 * the form that fills it without a terminal.
 *
 * The list is the server's, polled, never a copy this page keeps: a repo a session registered by
 * naming a new slug, or one added with `factory repo add`, shows up here, and a checkout deleted
 * behind the registry's back reads as not runnable on the next poll. Each row says whether a session
 * on it will get a worktree, and when it will not, why and what to do — the first thing a person
 * who just started the factory needs to know, since a run on a repo with no checkout opens in an
 * empty directory and has nothing to review.
 */
function ReposRoute() {
  const result = useAtomValue(reposAtom);

  // As on the spend view: a failed poll keeps the last answer on screen with a marker; only a first
  // read that fails replaces the list. The form stays either way, so a person can still register.
  const last = Option.getOrUndefined(AsyncResult.value(result));
  const stale = AsyncResult.isFailure(result) ? result.cause : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">Repositories</h1>
        <span className="text-[11px] text-muted-foreground">
          what sessions can be cut a worktree from
        </span>
        {stale === undefined || last === undefined ? null : (
          <span
            role="status"
            data-repos-stale
            title={Cause.pretty(stale)}
            className="text-[11px] text-destructive"
          >
            Reconnecting: showing the last answer the server gave
          </span>
        )}
        {last === undefined ? null : (
          <span
            data-repos-count={last.length}
            data-repos-not-runnable={notRunnableCount(last)}
            className="ml-auto font-mono text-[11px] text-muted-foreground"
          >
            {last.length} {last.length === 1 ? "repository" : "repositories"}
            {notRunnableCount(last) === 0
              ? ""
              : `, ${notRunnableCount(last)} cannot run`}
          </span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        <AddRepository />
        {AsyncResult.isInitial(result) ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">Loading repositories</span>
            {[0, 1].map((row) => (
              <Skeleton
                key={row}
                className="h-16 w-full max-w-3xl"
                aria-hidden
              />
            ))}
          </div>
        ) : last === undefined ? (
          <EmptyPane
            icon={<GitBranchIcon strokeWidth={1.75} />}
            title="Repositories did not load"
            detail={
              stale === undefined ? "No answer yet." : Cause.pretty(stale)
            }
            visible
          />
        ) : last.length === 0 ? (
          <p data-repos-empty className="text-xs text-muted-foreground">
            No repository is registered. Add the one the factory works on above:
            a session on it then gets a worktree of its own.
          </p>
        ) : (
          <ul
            aria-label="Repositories"
            className="flex max-w-3xl flex-col gap-2"
          >
            {last.map((repo) => (
              <RepoRow key={repo.repo} repo={repo} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The "Add repository" form: `registerRepo`, so a slug that already exists is updated, and a field
 * left blank keeps what the row holds. A refusal is shown inline in the server's words (a path that
 * is not a git work tree names the path); the form keeps what was typed, so the person fixes the
 * field instead of retyping the rest. Local path is optional: a repo with no checkout registers, and
 * the list then flags it as not runnable.
 */
const AddRepository = () => {
  const register = useAtomSet(registerRepoAtom, { mode: "promiseExit" });
  const [form, setForm] = useState<RepoForm>(EMPTY_REPO_FORM);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<RegisterRefusal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [registered, setRegistered] = useState<string | null>(null);

  const edit =
    (field: keyof RepoForm) => (event: FormEvent<HTMLInputElement>) => {
      setForm({ ...form, [field]: event.currentTarget.value });
      setProblem(null);
      setRefusal(null);
    };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = registerInput(form);
    setRegistered(null);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      setRefusal(null);
      return;
    }
    setProblem(null);
    setRefusal(null);
    setPending(true);
    void register(parsed.input)
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setForm(EMPTY_REPO_FORM);
          setRegistered(exit.value.repo);
          return;
        }
        setRefusal(
          registerRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
          ),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <section
      aria-label="Add repository"
      className="flex max-w-3xl flex-col gap-3"
    >
      <h2 className="text-xs font-medium">Add repository</h2>
      <form
        data-repo-form
        onSubmit={submit}
        noValidate
        className="grid gap-3 md:grid-cols-2"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-slug">Slug</Label>
          <Input
            id="repo-slug"
            name="repo"
            value={form.repo}
            onInput={edit("repo")}
            placeholder="acme/widgets"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem === null ? undefined : true}
            aria-describedby={
              problem === null ? undefined : "repo-slug-problem"
            }
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-path">Local path (optional)</Label>
          <Input
            id="repo-path"
            name="localPath"
            value={form.localPath}
            onInput={edit("localPath")}
            placeholder="/home/me/src/widgets"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-base">Default base ref (optional)</Label>
          <Input
            id="repo-base"
            name="defaultBaseRef"
            value={form.defaultBaseRef}
            onInput={edit("defaultBaseRef")}
            placeholder="main"
            aria-describedby="repo-base-help"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <p id="repo-base-help" className="text-[11px] text-muted-foreground">
            {BASE_REF_HELP}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-url">Clone URL (optional)</Label>
          <Input
            id="repo-url"
            name="url"
            value={form.url}
            onInput={edit("url")}
            placeholder="https://github.com/acme/widgets.git"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground md:col-span-2">
          The path is on the machine the API runs on, and must be absolute and
          inside a git work tree: a session is cut a worktree from it. Without
          one the repository is registered but cannot run. Registering a slug
          that exists updates it, and a blank field keeps its value.
        </p>
        {problem === null ? null : (
          <p
            id="repo-slug-problem"
            role="alert"
            data-repo-problem
            className="text-xs text-destructive md:col-span-2"
          >
            {problem}
          </p>
        )}
        {refusal === null ? null : (
          <Alert
            variant="destructive"
            role="alert"
            data-repo-refusal={refusal.tag}
            className="md:col-span-2"
          >
            <CircleAlertIcon strokeWidth={1.75} />
            <AlertTitle>The repository was not registered</AlertTitle>
            <AlertDescription>
              <span className="font-mono text-[11px] break-words">
                {refusal.message}
              </span>
            </AlertDescription>
          </Alert>
        )}
        {registered === null ? null : (
          <p
            role="status"
            data-repo-registered={registered}
            className="flex items-center gap-1.5 text-xs md:col-span-2"
          >
            <CircleCheckIcon className="size-3.5" strokeWidth={1.75} />
            Registered <span className="font-mono">{registered}</span>
          </p>
        )}
        <div className="md:col-span-2">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? (
              <Spinner className="size-3.5" />
            ) : (
              <PlusIcon className="size-4" strokeWidth={1.75} />
            )}
            Add repository
          </Button>
        </div>
      </form>
    </section>
  );
};

/**
 * One repository: its slug, whether a session on it can run, and the facts behind that. A repo that
 * cannot run carries the reason and the fix in the row itself, so the page never makes the person
 * discover it by starting a session that has nothing to review.
 */
const RepoRow = ({ repo }: { readonly repo: RepoSummary }) => {
  const state = runnability(repo);
  return (
    <li
      data-repo-row={repo.repo}
      data-repo-runnable={state.runnable}
      data-repo-cause={state.runnable ? undefined : state.cause}
      className="flex min-w-0 flex-col gap-2 border border-border bg-card px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-medium">{repo.repo}</span>
        {state.runnable ? (
          <span
            data-repo-state="runnable"
            title={RUNNABLE_TITLE}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          >
            <CircleCheckIcon className="size-3" strokeWidth={1.75} />
            runnable
          </span>
        ) : (
          <span
            data-repo-state="not-runnable"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive"
          >
            <CircleAlertIcon className="size-3" strokeWidth={1.75} />
            not runnable
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          base {repo.defaultBaseRef}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground">Checkout</dt>
        <dd data-repo-path className="min-w-0 font-mono break-all">
          {repo.localPath ?? "none registered"}
        </dd>
        {sameDirectory(repo.workTree, repo.localPath) ? null : (
          <>
            <dt className="text-muted-foreground">Repository root</dt>
            <dd data-repo-work-tree className="min-w-0 font-mono break-all">
              {repo.workTree}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Clone URL</dt>
        <dd className="min-w-0 font-mono break-all">{urlLabel(repo.url)}</dd>
        <dt className="text-muted-foreground">.factory/config</dt>
        <dd>{repo.hasFactoryConfig ? "declares commands" : "none"}</dd>
      </dl>
      {state.runnable ? null : (
        <p
          role="note"
          data-repo-reason
          className="border-l-2 border-destructive pl-2 text-[11px] leading-relaxed"
        >
          {state.reason}{" "}
          <span data-repo-fix className="text-muted-foreground">
            {state.fix}
          </span>
        </p>
      )}
    </li>
  );
};
