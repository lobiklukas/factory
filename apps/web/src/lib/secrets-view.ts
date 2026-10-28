/**
 * The Repositories page's secrets (S-agent-secrets), as pure functions: which summaries belong to a
 * repo, what the form sends, and what a refusal says. The form's value leaves in one `setSecret`
 * and the page never holds it after: a summary carries no value, so there is none to show.
 */
import { Redacted, Schema } from "effect";
import {
  SECRET_MIN_LENGTH,
  SecretName,
  type SecretSummary,
  type SetSecretInput,
} from "@repo/domain/Secret";
import type { RepoSlug } from "@repo/domain/Session";

/** What the form holds while a person types. */
export type SecretForm = { readonly name: string; readonly value: string };

export const EMPTY_SECRET_FORM: SecretForm = { name: "", value: "" };

/** One repo's secrets, by name. */
export const secretsOf = (
  all: ReadonlyArray<SecretSummary>,
  repo: string,
): ReadonlyArray<SecretSummary> =>
  all
    .filter((secret) => secret.repo === repo)
    .toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * The `setSecret` a form sends, or the problem to show before anything is sent. The name is trimmed
 * and upper-cased, since it is the variable a command reads; the value is sent exactly as typed.
 */
export const secretInput = (
  repo: RepoSlug,
  form: SecretForm,
):
  | { readonly ok: true; readonly input: SetSecretInput }
  | { readonly ok: false; readonly problem: string } => {
  const name = form.name.trim().toUpperCase();
  if (!Schema.is(SecretName)(name)) {
    return {
      ok: false,
      problem:
        "A secret's name is the variable a command reads: uppercase letters, digits and _, not starting with a digit.",
    };
  }
  if (form.value.length < SECRET_MIN_LENGTH) {
    return {
      ok: false,
      problem: `A value is at least ${SECRET_MIN_LENGTH} characters: it is masked wherever a command prints it.`,
    };
  }
  return {
    ok: true,
    input: { repo, name, value: Redacted.make(form.value) },
  };
};

/** What a failed write shows: the server's words for a typed refusal, else the cause's text. */
export const secretRefusal = (
  error: { readonly _tag: string; readonly message: string } | undefined,
  fallback: string,
): string =>
  error === undefined || error.message.length === 0 ? fallback : error.message;
