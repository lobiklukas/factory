/**
 * The deployment's git path to a repo's forge for a session that has a checkout of its own (C17):
 * fetch the base before the worktree is cut, push the session's branch before the PR step opens the
 * PR, and ask the forge which branch is the repo's default.
 *
 * Before this, `git.ts`'s `pushBranch` and `fetchBranch` had no caller outside their tests: the PR
 * step measured the local branch and asked GitHub for a PR whose head GitHub did not have, the agent
 * could not push it either (credential-shaped variables are stripped from its environment), and the
 * worktree was cut from the operator's local base, however far behind the remote it was.
 *
 * **Which URL** (`forgeUrlFor`). The registry's `url` for the repo; or, for a repo registered with
 * a checkout and no URL at all, `https://github.com/<repo>.git` when the checkout's own `origin`
 * names that very repository. A repo with neither, or with a URL `resolveForgeUrl` would not send a
 * token to (not GitHub, not `https`, not a loopback fake), has no forge the control plane may reach:
 * its sessions are cut and its PRs opened as they were before, and the caller warns. The URL is
 * never defaulted from the slug alone, because a slug registered for a local drive or a test is not
 * a GitHub repository, and a default would send the deployment's real token to one.
 *
 * **Where a fetched base lands.** `refs/remotes/factory/<base>` in the registered checkout — not
 * `origin`, which is the operator's remote and may name another repository (a fork), and never
 * `refs/heads/<base>`, which the operator may have checked out with work in its tree. The worktree is
 * cut at that tracking ref, and every measurement of the branch picks its base with
 * `measureBaseOf`.
 *
 * It reaches `SessionService` as a value (`SessionServiceOptions.repoRemote`), the way `RepoMirror`
 * does: the session layer does not require a credential provider or a process spawner, and a
 * deployment, or a test, supplies the remote it wants. The credential is `git.ts`'s: resolved per
 * call, handed to one process, written nowhere.
 */
import { Duration, Effect, type FileSystem, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { RepoSlug } from "@repo/domain/Session";
import type { CredentialError, CredentialProvider } from "./credentials";
import {
  type FetchedBranch,
  fetchBranch,
  type GitError,
  type PushedBranch,
  pushBranch,
  remoteDefaultBranch,
  resolveForgeUrl,
} from "./git";
import { gitAnswer, resolveCommit } from "./repos";

/** The remote name a fetched base is tracked under in the registered checkout. */
export const BASE_REMOTE = "factory";

/** Where `fetchBase` leaves the base's tip in the checkout, and what a worktree is cut at. */
export const baseTrackingRef = (branch: string): string =>
  `refs/remotes/${BASE_REMOTE}/${branch}`;

/**
 * The URL the control plane may push to and fetch from for `repo`, or `undefined` when the registry
 * holds none it may send a token to. Checked here, before any call, so "no forge" is a decision the
 * caller logs rather than a refused push it has to tell apart from a failed one.
 */
export const forgeUrlOf = (repo: RepoSlug, url: string): string | undefined =>
  url !== "" && resolveForgeUrl(repo, url).ok ? url : undefined;

/**
 * The `https://github.com/<repo>.git` a checkout's own remote URL names, or `undefined` when it
 * names another host or another repository. The three spellings `git clone` leaves behind are read
 * — `https://github.com/<repo>(.git)`, `git@github.com:<repo>(.git)` and
 * `ssh://git@github.com/<repo>(.git)` — and an https URL carrying a credential is not one of them.
 * What is answered is always the https form: the token is sent over https, never over ssh.
 */
export const githubUrlOfRemote = (
  repo: RepoSlug,
  remote: string,
): string | undefined => {
  const trimmed = remote.trim();
  const path = (/^https:\/\/github\.com\/(.+)$/i.exec(trimmed) ??
    /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/(.+)$/i.exec(trimmed) ??
    /^(?:[^@/:]+@)?github\.com:(?!\/)(.+)$/i.exec(trimmed))?.[1];
  if (path === undefined) return undefined;
  const named = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (named.toLowerCase() !== repo.toLowerCase()) return undefined;
  const url = `https://github.com/${repo}.git`;
  return resolveForgeUrl(repo, url).ok ? url : undefined;
};

/**
 * The forge URL for a registered repo (C17, review): the registry's `url` when `forgeUrlOf` takes it;
 * else, for a repo registered with no URL at all but with a checkout, the GitHub URL its checkout's
 * `origin` names, when that is `github.com/<repo>` itself (`githubUrlOfRemote`). That is the
 * registration `noCheckoutWarning` tells an operator to run (`factory repo add <repo> --path <dir>`),
 * and an `origin` naming the very slug is the evidence that the slug is a real GitHub repository — a
 * slug registered for a drive or a test, whose checkout's remote is a local path or nothing, still
 * gets no token. A registered URL that `forgeUrlOf` refuses is not second-guessed from the checkout:
 * the operator named a remote, and it is not this one. The remote's URL is read, never printed.
 */
export const forgeUrlFor = (
  repo: RepoSlug,
  url: string,
  checkout: string | null | undefined,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const registered = forgeUrlOf(repo, url);
    if (registered !== undefined) return registered;
    if (url !== "" || checkout === null || checkout === undefined)
      return undefined;
    const origin = yield* gitAnswer(checkout, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    return origin === undefined ? undefined : githubUrlOfRemote(repo, origin);
  });

/**
 * The ref `head` is measured against for a session whose base is `base` (C17, review): whichever of
 * the checkout's local `<base>` and the fetched `refs/remotes/factory/<base>` gives `head` the later
 * merge base — the one the branch was actually cut from, or a later tip of it. Every measurement of a
 * session's branch goes through this one answer — the PR step's cap and body, the board's
 * `non_empty_diff` (`TaskService`) and the run's own `verify` tool — so a branch the board measures
 * as empty is one the step would publish as empty.
 *
 * Why not "the tracking ref whenever it exists": a session cut at the fetched tip, in a checkout
 * whose local `<base>` is behind it, would count the forge's own new commits as the session's if
 * measured against the local base; and a session cut from the local base (its fetch failed) beside
 * a stale tracking ref would count the operator's pulled commits as the session's if measured
 * against the tracking ref. `base...head` is measured from the merge base, so the candidate whose
 * merge base with `head` descends from the other's is the one that counts only the branch's commits.
 * Equal merge bases measure the same diff, and answer `base`.
 *
 * `base` whenever there is no tracking ref, or a ref does not resolve (the measurement then fails on
 * its own terms); the tracking ref when the checkout has no local `<base>` at all.
 */
export const measureBaseOf = (input: {
  /** Any directory inside the repository: the session's worktree or the registered checkout. */
  readonly directory: string;
  readonly base: string;
  readonly head: string;
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const tracking = baseTrackingRef(input.base);
    const trackingTip = yield* resolveCommit(input.directory, tracking);
    if (trackingTip === undefined) return input.base;
    const baseTip = yield* resolveCommit(input.directory, input.base);
    if (baseTip === undefined) return tracking;
    const headTip = yield* resolveCommit(input.directory, input.head);
    if (headTip === undefined) return input.base;
    const [fromTracking, fromBase] = yield* Effect.all([
      gitAnswer(input.directory, ["merge-base", trackingTip, headTip]),
      gitAnswer(input.directory, ["merge-base", baseTip, headTip]),
    ]);
    if (fromTracking === undefined || fromTracking === "") return input.base;
    if (fromBase === undefined || fromBase === "") return tracking;
    if (fromTracking === fromBase) return input.base;
    const later = yield* gitAnswer(input.directory, [
      "merge-base",
      "--is-ancestor",
      fromBase,
      fromTracking,
    ]);
    return later === undefined ? input.base : tracking;
  });

/**
 * How long a question the session's create waits on — the base's fetch, the forge's default branch
 * — before it is answered from the checkout instead (C17, review). The fetch runs while the create
 * holds an admission slot and the checkout's fetch gate, so a forge that blackholes connections
 * must cost a create seconds, not git's five-minute default; a fetch of one branch the checkout
 * mostly has already is well inside it.
 */
export const FORGE_QUESTION_TIMEOUT = Duration.seconds(30);

type RemoteFailure = GitError | CredentialError;

export type RepoRemote = {
  /** Fetch `branch` from the forge into `checkout`'s `refs/remotes/factory/<branch>`. */
  readonly fetchBase: (input: {
    readonly repo: RepoSlug;
    readonly url: string;
    readonly checkout: string;
    readonly branch: string;
  }) => Effect.Effect<FetchedBranch, RemoteFailure>;
  /** Push the session's `factory/*` branch from its worktree to the same name on the forge. */
  readonly push: (input: {
    readonly repo: RepoSlug;
    readonly url: string;
    readonly worktree: string;
    readonly branch: string;
    /** The commit to push to `branch`, when the caller measured one: see `PushBranchInput.commit`. */
    readonly commit?: string | undefined;
  }) => Effect.Effect<PushedBranch, RemoteFailure>;
  /** The branch the forge's `HEAD` names: the repo's default. */
  readonly defaultBranch: (input: {
    readonly repo: RepoSlug;
    readonly url: string;
  }) => Effect.Effect<string, RemoteFailure>;
};

/** The deployment's remote: `git.ts` against the registry's URL, with the worker's credential. */
export const gitRepoRemote: Effect.Effect<
  RepoRemote,
  never,
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    | CredentialProvider
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
  >();
  // One fetch at a time per checkout: the tracking ref is updated under git's ref lock, and the
  // second of two sessions opening at once would fail on it rather than wait.
  const gates = new Map<string, Semaphore.Semaphore>();
  const gateFor = (checkout: string): Semaphore.Semaphore => {
    const known = gates.get(checkout);
    if (known !== undefined) return known;
    const made = Semaphore.makeUnsafe(1);
    gates.set(checkout, made);
    return made;
  };
  return {
    fetchBase: (input) =>
      fetchBranch({
        worktree: input.checkout,
        repo: input.repo,
        url: input.url,
        remote: BASE_REMOTE,
        branch: input.branch,
        timeout: FORGE_QUESTION_TIMEOUT,
      }).pipe(
        Effect.provideContext(context),
        gateFor(input.checkout).withPermits(1),
      ),
    push: (input) =>
      pushBranch({
        worktree: input.worktree,
        repo: input.repo,
        url: input.url,
        branch: input.branch,
        ...(input.commit === undefined ? {} : { commit: input.commit }),
      }).pipe(Effect.provideContext(context)),
    defaultBranch: (input) =>
      remoteDefaultBranch({
        repo: input.repo,
        url: input.url,
        timeout: FORGE_QUESTION_TIMEOUT,
      }).pipe(Effect.provideContext(context)),
  } satisfies RepoRemote;
});
