import type { RegisterRepoInput, RepoSummary } from "@repo/domain/Session";
import { RepoSlug } from "@repo/domain/Session";
import { Schema } from "effect";

/**
 * The Repositories page's wording and form rules (LOB-262).
 *
 * The rows are `listRepos`, the server's answer, and the only facts here: whether a repo can run is
 * read off the two the server computed from the checkout (`localPath`, `localPathIsGit`), never
 * guessed from a slug or a URL. Pure on purpose, so the cases a screenshot cannot settle (a path
 * that stopped being a repository, a form typed with spaces) are unit cases.
 */

/** Why a repo cannot cut a session's worktree, and what the operator does about it. */
export type Runnability =
  | { readonly runnable: true }
  | {
      readonly runnable: false;
      /** Which of the two causes: nothing registered, or what is registered is not a work tree. */
      readonly cause: "no_checkout" | "not_a_work_tree";
      readonly reason: string;
      readonly fix: string;
    };

/**
 * Whether a session on `repo` gets a `factory/<session-id>` worktree. It does exactly when the repo
 * has a local checkout that is inside a git work tree, or no checkout and a clone URL the factory
 * has already cloned into its own cache (`mirrorPath`, LOB-265): any other repo still opens
 * sessions, but in an empty directory, where nothing the run changes can be diffed or reviewed.
 */
export const runnability = (repo: RepoSummary): Runnability => {
  if (repo.localPath === undefined && repo.mirrorPath !== undefined) {
    return { runnable: true };
  }
  if (repo.localPath === undefined && repo.url !== "") {
    return {
      runnable: false,
      cause: "no_checkout",
      reason:
        "The factory has not cloned this repository yet (the clone has not run, or it failed), so a session opens in an empty directory and no worktree is cut.",
      fix: "Run `factory repo sync` for this repo to clone it now, or save the row again here to retry the clone; check the URL and the API's read credential if it keeps failing.",
    };
  }
  if (repo.localPath === undefined) {
    return {
      runnable: false,
      cause: "no_checkout",
      reason:
        "No local checkout is registered, so a session opens in an empty directory and no worktree is cut.",
      fix: "Register a clone URL for the factory to clone itself, or the absolute path of a clone on the API's machine (Add repository, with this slug and a URL or a local path).",
    };
  }
  if (!repo.localPathIsGit) {
    return {
      runnable: false,
      cause: "not_a_work_tree",
      reason: `${repo.localPath} is not inside a git work tree (it was moved, deleted or never cloned), so no worktree can be cut from it.`,
      fix: "Register the path of a git checkout, or clone the repository to that path.",
    };
  }
  return { runnable: true };
};

/**
 * What "runnable" does and does not promise. The server reports a checkout, not whether the base
 * ref exists in it: a checkout whose default branch is `master`, or one with no commits, is flagged
 * runnable here and still refused at `createSession` ("failed to create worktree at main").
 */
export const RUNNABLE_TITLE =
  "A git checkout is registered. A session also needs the default base ref to exist in it.";

/** The form's note under the base ref: the one condition the page cannot check for the person. */
export const BASE_REF_HELP =
  "Must name a branch or commit that exists in the checkout; a blank ref keeps the row's, or uses main for a new one.";

/**
 * Whether two paths name the same directory as written: trailing slashes ignored. The server's
 * `workTree` is git's resolved root, so a path through a symlink still differs from it, which is why
 * the row labels the line "Repository root" rather than claiming a difference.
 */
export const sameDirectory = (
  workTree: string | undefined,
  localPath: string | undefined,
): boolean => {
  if (workTree === undefined) return true;
  const strip = (value: string): string =>
    value.length > 1 ? value.replace(/\/+$/, "") : value;
  return localPath !== undefined && strip(workTree) === strip(localPath);
};

/** How many of `repos` cannot run: the number the page's header and its empty-state rules read. */
export const notRunnableCount = (repos: ReadonlyArray<RepoSummary>): number =>
  repos.filter((repo) => !runnability(repo).runnable).length;

/** What the "Add repository" form holds, as typed: every field a string. */
export type RepoForm = {
  readonly repo: string;
  readonly localPath: string;
  readonly defaultBaseRef: string;
  readonly url: string;
};

export const EMPTY_REPO_FORM: RepoForm = {
  repo: "",
  localPath: "",
  defaultBaseRef: "",
  url: "",
};

/**
 * The slug rule in the person's words. The pattern is `RepoSlug`'s own, so a slug this accepts is
 * one the client can send; `registerRepo` would otherwise fail on the client's encode with a schema
 * error, not an answer the server gave.
 */
export const SLUG_HELP =
  "A slug is owner/name in lowercase letters, digits, '.', '_' or '-', for example acme/widgets.";

/** The form's slug problem, or `undefined` when the slug is acceptable. */
export const slugProblem = (slug: string): string | undefined => {
  const trimmed = slug.trim();
  if (trimmed === "") return "A repository needs a slug.";
  return Schema.is(RepoSlug)(trimmed)
    ? undefined
    : `"${trimmed}" is not a valid slug. ${SLUG_HELP}`;
};

/**
 * The `registerRepo` payload a form means, or the slug problem that stops it.
 *
 * A field left blank is left out, never sent as `""`: the server keeps the row's value for a field
 * it was not given, so blank means "leave it", and a second registration naming only a base ref
 * keeps the checkout (LOB-253). Every field is trimmed, because a path pasted from a terminal
 * carries its newline and the server would refuse `/a/b ` as not a work tree.
 */
export const registerInput = (
  form: RepoForm,
):
  | { readonly ok: true; readonly input: RegisterRepoInput }
  | { readonly ok: false; readonly problem: string } => {
  const problem = slugProblem(form.repo);
  if (problem !== undefined) return { ok: false, problem };
  const localPath = form.localPath.trim();
  const defaultBaseRef = form.defaultBaseRef.trim();
  const url = form.url.trim();
  return {
    ok: true,
    input: {
      repo: Schema.decodeSync(RepoSlug)(form.repo.trim()),
      ...(localPath === "" ? {} : { localPath }),
      ...(defaultBaseRef === "" ? {} : { defaultBaseRef }),
      ...(url === "" ? {} : { url }),
    },
  };
};

/** A refused registration: the server's message verbatim, and which refusal it was. */
export type RegisterRefusal = {
  readonly tag: string;
  readonly message: string;
};

/**
 * What a failed `registerRepo` shows. A typed refusal (`SessionError`, e.g. `invalid_input` naming
 * a path that is not a git work tree) is shown in the server's own words, because they name the
 * path and say why; anything else (a dropped connection) falls back to the cause's text.
 */
export const registerRefusal = (
  error: { readonly _tag: string; readonly message: string } | undefined,
  fallback: string,
): RegisterRefusal =>
  error === undefined || error.message.length === 0
    ? { tag: error?._tag ?? "Unknown", message: fallback }
    : { tag: error._tag, message: error.message };

/** A clone URL for display: blank for a repo nobody gave one. */
export const urlLabel = (url: string): string =>
  url === "" ? "no clone URL" : url;
