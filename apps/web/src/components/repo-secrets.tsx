import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import { CircleAlertIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RepoSlug } from "@repo/domain/Session";
import {
  deleteSecretAtom,
  secretsAtom,
  setSecretAtom,
} from "@/lib/atoms/secrets-atom";
import {
  EMPTY_SECRET_FORM,
  secretInput,
  secretRefusal,
  secretsOf,
  type SecretForm,
} from "@/lib/secrets-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

/**
 * A repository's secrets (S-agent-secrets): the names it stores, and a form that sets one. Write-only
 * by construction: the list is `listSecrets`' summaries, which carry no value, and the form's value
 * field is a password input cleared the moment the server answers — the page never reads a value
 * back, because no RPC answers one. A run gets a secret only in the commands its repository's
 * `.factory/config` declares it for.
 */
export const RepoSecrets = ({ repo }: { readonly repo: RepoSlug }) => {
  const result = useAtomValue(secretsAtom);
  const set = useAtomSet(setSecretAtom, { mode: "promiseExit" });
  const remove = useAtomSet(deleteSecretAtom, { mode: "promiseExit" });
  const [form, setForm] = useState<SecretForm>(EMPTY_SECRET_FORM);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const all = Option.getOrUndefined(AsyncResult.value(result));
  const secrets = all === undefined ? undefined : secretsOf(all, repo);
  const slug = repo.replace(/[^a-z0-9]+/g, "-");

  const edit =
    (field: keyof SecretForm) => (event: FormEvent<HTMLInputElement>) => {
      setForm({ ...form, [field]: event.currentTarget.value });
      setProblem(null);
      setSaved(null);
    };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = secretInput(repo, form);
    setSaved(null);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setPending(true);
    void set(parsed.input)
      .then((exit) => {
        // The value is dropped whatever the answer: a refused value is retyped, never kept.
        setForm({ name: exit._tag === "Success" ? "" : form.name, value: "" });
        if (Exit.isSuccess(exit)) {
          setSaved(exit.value.name);
          return;
        }
        setProblem(
          secretRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
          ),
        );
      })
      .finally(() => setPending(false));
  };

  const drop = (name: string) => {
    setSaved(null);
    void remove({ repo, name }).then((exit) => {
      if (Exit.isFailure(exit)) {
        setProblem(
          secretRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
          ),
        );
      }
    });
  };

  return (
    <section
      aria-label={`Secrets of ${repo}`}
      data-repo-secrets={repo}
      className="flex flex-col gap-2 border-t border-border pt-2"
    >
      <h3 className="flex items-center gap-1.5 text-[11px] font-medium">
        <KeyRoundIcon className="size-3" strokeWidth={1.75} />
        Secrets
        <span className="font-normal text-muted-foreground">
          write-only; given only to the commands .factory/config declares them
          for
        </span>
      </h3>
      {secrets === undefined ? (
        <p className="text-[11px] text-muted-foreground">
          {AsyncResult.isFailure(result)
            ? "Secrets did not load."
            : "Loading secrets…"}
        </p>
      ) : secrets.length === 0 ? (
        <p data-secrets-empty className="text-[11px] text-muted-foreground">
          No secret stored.
        </p>
      ) : (
        <ul aria-label={`Secrets of ${repo}`} className="flex flex-col gap-1">
          {secrets.map((secret) => (
            <li
              key={secret.name}
              data-secret-name={secret.name}
              className="flex items-center gap-2 text-[11px]"
            >
              <span className="font-mono">{secret.name}</span>
              <span className="text-muted-foreground">
                set {secret.updatedAt}
                {secret.updatedBy === "" ? "" : ` by ${secret.updatedBy}`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                aria-label={`Delete secret ${secret.name}`}
                data-secret-delete={secret.name}
                onClick={() => drop(secret.name)}
              >
                <Trash2Icon className="size-3.5" strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        data-secret-form={repo}
        onSubmit={submit}
        noValidate
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={`secret-name-${slug}`} className="text-[11px]">
            Name
          </Label>
          <Input
            id={`secret-name-${slug}`}
            name="name"
            value={form.name}
            onInput={edit("name")}
            placeholder="TEST_API_KEY"
            autoComplete="off"
            spellCheck={false}
            className="h-7 w-44 font-mono text-xs"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`secret-value-${slug}`} className="text-[11px]">
            Value
          </Label>
          <Input
            id={`secret-value-${slug}`}
            name="value"
            type="password"
            value={form.value}
            onInput={edit("value")}
            autoComplete="new-password"
            spellCheck={false}
            className="h-7 w-56 font-mono text-xs"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={pending}
          aria-busy={pending}
          data-secret-save
        >
          {pending ? <Spinner className="size-3.5" /> : null}
          Save secret
        </Button>
        {problem === null ? null : (
          <p
            role="alert"
            data-secret-problem
            className="flex basis-full items-center gap-1.5 text-[11px] text-destructive"
          >
            <CircleAlertIcon className="size-3" strokeWidth={1.75} />
            {problem}
          </p>
        )}
        {saved === null ? null : (
          <p
            role="status"
            data-secret-saved={saved}
            className="basis-full text-[11px]"
          >
            Saved <span className="font-mono">{saved}</span>. Its value is not
            shown again.
          </p>
        )}
      </form>
    </section>
  );
};
