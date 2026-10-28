/**
 * What a registered repo's local checkout says about itself (LOB-253): whether it is inside a git
 * work tree a session's worktree can be cut from, which work tree that is, and whether it declares
 * its commands in `.factory/config`.
 *
 * These are read from the disk each time a registry row is answered and never stored: the checkout
 * is operator state outside the factory, and a path that was a repository when it was registered can
 * be moved or deleted since. `registerRepo` uses the same check to refuse a path that is not one, so
 * the registry never gains a checkout `workspace.ts` would fail to cut a worktree from.
 *
 * The check is "inside a work tree", not "is a work tree's root": a directory inside a checkout (a
 * monorepo package) is a valid local path, and `workspace.ts`'s `git worktree add` finds the same
 * repository from it by git's ordinary discovery. The cost is that a plain directory under some
 * unrelated enclosing repository is accepted too, and sessions would be cut from that repository.
 * So the answer carries the work tree's root (`rev-parse --show-toplevel`), and the CLI prints it:
 * the operator sees which repository a session will be cut from rather than having to infer it.
 *
 * The git call carries `core.hooksPath=/dev/null` and `core.fsmonitor=false` as `git.ts`'s
 * uncredentialed calls do: the path is the operator's, but nothing about it is the control plane's
 * to run. It is asynchronous (`execFile`, as `prStep.ts`'s diff is), so a checkout on a slow mount
 * holds one fiber rather than the API's event loop, and `listRepos`'s probes do run side by side.
 */
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the probe is the local git CLI, the same one `workspace.ts` cuts the worktree with.
import { execFile } from "node:child_process";
import { CONFIG_FILE, type WorkspaceDeps } from "./workspace";

/** What a checkout says about itself; both `false` and no `workTree` when there is no checkout. */
export type CheckoutFacts = {
  readonly localPathIsGit: boolean;
  readonly hasFactoryConfig: boolean;
  /** The root of the work tree the path is inside; present exactly when `localPathIsGit`. */
  readonly workTree?: string;
};

const NO_CHECKOUT: CheckoutFacts = {
  localPathIsGit: false,
  hasFactoryConfig: false,
};

/** How long `rev-parse` may take before the path is answered as not a work tree. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The root of the git work tree `directory` is inside, or `undefined` when it is not inside one.
 *
 * `rev-parse --is-inside-work-tree` prints `false` (and exits 0) inside a `.git` directory, so the
 * answer is the printed word, not the exit code; `--show-toplevel` after it prints the root, and
 * fails outside a work tree. A missing directory, a plain one, a git that cannot run or one that
 * outlives the deadline is `undefined`. An interrupted caller kills git rather than leaving it.
 */
export const workTreeRoot = (
  directory: string,
): Effect.Effect<string | undefined> =>
  Effect.callback<string | undefined>((resume, signal) => {
    execFile(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        directory,
        "rev-parse",
        "--is-inside-work-tree",
        "--show-toplevel",
      ],
      { encoding: "utf8", signal, timeout: GIT_TIMEOUT_MS },
      // stderr is dropped: a path that is not a repository is an answer, not a log line.
      (error, stdout) => {
        const [inside, root] = stdout.split("\n").map((line) => line.trim());
        resume(
          Effect.succeed(
            error === null &&
              inside === "true" &&
              root !== undefined &&
              root !== ""
              ? root
              : undefined,
          ),
        );
      },
    );
  });

/** Read every fact about a checkout, or answer `NO_CHECKOUT` for a repo that has none. */
export const inspectCheckout = (
  localPath: string | undefined,
  deps: WorkspaceDeps,
): Effect.Effect<CheckoutFacts> =>
  localPath === undefined
    ? Effect.succeed(NO_CHECKOUT)
    : Effect.all(
        {
          workTree: workTreeRoot(localPath),
          hasFactoryConfig: deps.fs
            .exists(deps.path.join(localPath, ...CONFIG_FILE))
            .pipe(Effect.orElseSucceed(() => false)),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ workTree, hasFactoryConfig }) => ({
          localPathIsGit: workTree !== undefined,
          hasFactoryConfig,
          ...(workTree === undefined ? {} : { workTree }),
        })),
      );

/**
 * One hook-free `git` in `directory` that answers its trimmed stdout, or `undefined` when git
 * failed, could not run, or outlived the deadline. The probes below are read-only questions about a
 * checkout, and "git could not say" is an answer to each of them.
 */
export const gitAnswer = (
  directory: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string | undefined> =>
  Effect.callback<string | undefined>((resume, signal) => {
    execFile(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        directory,
        ...args,
      ],
      { encoding: "utf8", signal, timeout: GIT_TIMEOUT_MS },
      (error, stdout) =>
        resume(Effect.succeed(error === null ? stdout.trim() : undefined)),
    );
  });

/**
 * The commit `ref` names in the repository `directory` is in, or `undefined` when it names none.
 * `--end-of-options` keeps a ref that starts with `-` from being read as an option.
 */
export const resolveCommit = (
  directory: string,
  ref: string,
): Effect.Effect<string | undefined> =>
  gitAnswer(directory, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).pipe(
    Effect.map((sha) => (sha === undefined || sha === "" ? undefined : sha)),
  );

/** Whether `ref` (a full ref name) resolves to a commit in the repository `directory` is in. */
export const refExists = (
  directory: string,
  ref: string,
): Effect.Effect<boolean> =>
  resolveCommit(directory, ref).pipe(Effect.map((sha) => sha !== undefined));

/**
 * The branch a checkout's repo treats as its default, read from the checkout alone (C17): what a
 * registration with no `--base-ref` records when the forge cannot be asked. In order: the branch
 * `origin/HEAD` names (what `git clone` records as the remote's default), a local `main`, a local
 * `master`, the branch the checkout has checked out. `undefined` when none of them answers — a
 * detached checkout of a repo with neither name — and the caller keeps its own default.
 */
export const checkoutDefaultBranch = (
  checkout: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const remoteHead = yield* gitAnswer(checkout, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    const fromOrigin = remoteHead?.startsWith("refs/remotes/origin/")
      ? remoteHead.slice("refs/remotes/origin/".length)
      : undefined;
    if (fromOrigin !== undefined && fromOrigin !== "") return fromOrigin;
    for (const name of ["main", "master"]) {
      if (yield* refExists(checkout, `refs/heads/${name}`)) return name;
    }
    const head = yield* gitAnswer(checkout, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    return head?.startsWith("refs/heads/")
      ? head.slice("refs/heads/".length)
      : undefined;
  });
