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
 * **Which URL.** The registry's `url` for the repo, and only that. A repo registered with no URL, or
 * with one `resolveForgeUrl` would not send a token to (not GitHub, not `https`, not a loopback
 * fake), has no forge the control plane may reach: its sessions are cut and its PRs opened as they
 * were before, and the caller says so in the log. The URL is never defaulted to
 * `https://github.com/<repo>.git` here, because a slug registered for a local drive or a test is not
 * a GitHub repository, and a default would send the deployment's real token to one.
 *
 * **Where a fetched base lands.** `refs/remotes/factory/<base>` in the registered checkout — not
 * `origin`, which is the operator's remote and may name another repository (a fork), and never
 * `refs/heads/<base>`, which the operator may have checked out with work in its tree. The worktree is
 * cut at that tracking ref, and the PR step measures the branch against it.
 *
 * It reaches `SessionService` as a value (`SessionServiceOptions.repoRemote`), the way `RepoMirror`
 * does: the session layer does not require a credential provider or a process spawner, and a
 * deployment, or a test, supplies the remote it wants. The credential is `git.ts`'s: resolved per
 * call, handed to one process, written nowhere.
 */
import { Effect, type FileSystem, Semaphore } from "effect";
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
      }).pipe(Effect.provideContext(context)),
    defaultBranch: (input) =>
      remoteDefaultBranch({ repo: input.repo, url: input.url }).pipe(
        Effect.provideContext(context),
      ),
  } satisfies RepoRemote;
});
