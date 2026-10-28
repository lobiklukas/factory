/**
 * The factory's own clone of a repo registered with only a URL (LOB-265, LOB-66's deferred
 * "clone-or-fetch").
 *
 * A repo with a local checkout is cut from that checkout (`workspace.ts`). A repo with none — Cursor,
 * Amp and Codex all clone the onboarded repo themselves — gets a bare repository under the session
 * root, `<SESSION_ROOT>/.cache/<owner>/<name>.git`, that every session on it fetches its base ref
 * into and cuts its worktree from. It is the same shape the sandbox reuses later: one object store
 * per repo, one linked worktree per session.
 *
 * This module is the policy around `git.ts`'s `syncMirror`: where the mirror lives, one sync at a
 * time per repo (two fetches into one bare repository would race on its tracking ref), and a
 * failure as the wire's `RepoCloneFailed`, which names the repo and the reason and never a URL or a
 * token. The credential is `git.ts`'s: resolved at the call, in one process's environment, written
 * to no config and no helper store. The mirror's own config is `git init --bare`'s and nothing more.
 *
 * It reaches `SessionService` as a value (`SessionServiceOptions.repoMirror`), the way the review
 * poster does: the session layer does not require a credential provider or a process spawner, and a
 * deployment, or a test, supplies the mirror it wants.
 */
import { Effect, type FileSystem, Path, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
  RepoCloneFailed,
  type RepoCloneFailureReason,
  type RepoSlug,
} from "@repo/domain/Session";
import type { CredentialProvider } from "./credentials";
import { syncMirror } from "./git";

/** The branch a sync fetched, and where it now is in the mirror. */
export type MirrorTip = {
  /** The bare repository: what `git worktree add` runs in. */
  readonly path: string;
  /** The local ref the fetch updated: `refs/remotes/origin/<base>`. A worktree is cut at it. */
  readonly ref: string;
  readonly sha: string;
};

export type RepoMirror = {
  /**
   * Where the repo's mirror lives, whether or not it has been cloned yet. Pure, so a read can ask
   * whether there is one to tear a worktree down from without touching the network.
   */
  readonly directory: (repo: RepoSlug) => string;
  /**
   * Clone the repo's `baseRef` into the mirror, or fetch it when the mirror exists, and say where it
   * is. Serialized per repo.
   */
  readonly sync: (input: {
    readonly repo: RepoSlug;
    readonly url: string;
    readonly baseRef: string;
  }) => Effect.Effect<MirrorTip, RepoCloneFailed>;
};

/**
 * `<root>/.cache/<owner>/<name>.git`, absolute. The directory sits beside the sessions' (`<root>/
 * <owner>/<name>/<session id>`) and cannot be one of them: `sync` refuses a slug with a segment that
 * starts with a dot, so no repo is named `.cache`.
 */
export const mirrorDirectory = (
  path: Path.Path,
  root: string,
  repo: RepoSlug,
): string => {
  const [owner = "", name = ""] = repo.split("/");
  return path.resolve(root, ".cache", owner, `${name}.git`);
};

/** A slug whose segments are dotfiles (`.`, `..`, `.cache`) would name a directory it must not. */
const hasDotSegment = (repo: RepoSlug): boolean =>
  repo.split("/").some((segment) => segment.startsWith("."));

/** The deployment's mirror: `syncMirror` into `<root>/.cache`, with the worker's read credential. */
export const gitRepoMirror = (options: {
  readonly root: string;
}): Effect.Effect<
  RepoMirror,
  never,
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | CredentialProvider
      | ChildProcessSpawner.ChildProcessSpawner
      | FileSystem.FileSystem
    >();
    const path = yield* Path.Path;
    const directory = (repo: RepoSlug) =>
      mirrorDirectory(path, options.root, repo);
    // One permit per repo, made on first use: a fetch into a bare repository takes a lock on its
    // tracking ref, and the second of two simultaneous sessions would fail on it rather than wait.
    const gates = new Map<string, Semaphore.Semaphore>();
    const gateFor = (repo: RepoSlug): Semaphore.Semaphore => {
      const known = gates.get(repo);
      if (known !== undefined) return known;
      const made = Semaphore.makeUnsafe(1);
      gates.set(repo, made);
      return made;
    };
    const sync: RepoMirror["sync"] = (input) => {
      const failed = (reason: RepoCloneFailureReason, message: string) =>
        new RepoCloneFailed({ repo: input.repo, reason, message });
      if (hasDotSegment(input.repo))
        return Effect.fail(
          failed(
            "refused",
            `repo ${input.repo}: a slug with a segment that starts with a dot is not cloned`,
          ),
        );
      const mirror = directory(input.repo);
      return syncMirror({
        mirror,
        repo: input.repo,
        url: input.url,
        branch: input.baseRef,
      }).pipe(
        Effect.map(({ ref, sha }) => ({ path: mirror, ref, sha })),
        Effect.mapError((error) =>
          error._tag === "GitError"
            ? failed(
                // The two push-only reasons cannot come from a fetch; `failed` keeps the type total.
                error.reason === "non-fast-forward" ||
                  error.reason === "remote-rejected"
                  ? "failed"
                  : error.reason,
                `repo ${input.repo}: ${error.message}`,
              )
            : failed("credential", `repo ${input.repo}: ${error.message}`),
        ),
        Effect.provideContext(context),
        gateFor(input.repo).withPermits(1),
      );
    };
    return { directory, sync } satisfies RepoMirror;
  });
