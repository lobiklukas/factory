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
import type { BaseRefCheck } from "@repo/domain/Server";
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

/** How a `gitAnswer` reads git's answer; each defaults to what a short probe wants. */
export type GitAnswerOptions = {
  /** Trim the answer (default): a probe's one line. `false` keeps a file's bytes as they are. */
  readonly trim?: boolean;
  /** The most stdout git may print before it is killed and the answer is `undefined`. */
  readonly maxBuffer?: number;
  /** How long git may take before the answer is `undefined`, in milliseconds. */
  readonly timeoutMs?: number;
};

/**
 * How one hook-free `git` ended (`gitRun`): its stdout when it exited 0, or how it failed — the exit
 * code when it exited with one, `undefined` when it could not run, was killed (the deadline, an
 * overfull `maxBuffer`) or ended on a signal.
 */
export type GitRun =
  | { readonly _tag: "ok"; readonly stdout: string }
  | { readonly _tag: "failed"; readonly exitCode: number | undefined };

/**
 * One hook-free `git` in `directory`, answering how it ended: what `gitAnswer` reads, for a caller
 * that must tell "git said no" (an exit code the command documents) from "git could not say".
 */
export const gitRun = (
  directory: string,
  args: ReadonlyArray<string>,
  options: GitAnswerOptions = {},
): Effect.Effect<GitRun> =>
  Effect.callback<GitRun>((resume, signal) => {
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
      {
        encoding: "utf8",
        signal,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        ...(options.maxBuffer === undefined
          ? {}
          : { maxBuffer: options.maxBuffer }),
      },
      (error, stdout) => {
        if (error === null) {
          resume(
            Effect.succeed({
              _tag: "ok",
              stdout: options.trim === false ? stdout : stdout.trim(),
            }),
          );
          return;
        }
        // `code` is the exit status only for a git that exited on its own; a spawn failure carries
        // a string (`ENOENT`), and a killed one (`killed`, a `signal`) has no answer to read.
        const exited =
          typeof error.code === "number" &&
          error.killed !== true &&
          (error.signal ?? null) === null;
        resume(
          Effect.succeed({
            _tag: "failed",
            exitCode: exited ? (error.code as number) : undefined,
          }),
        );
      },
    );
  });

/**
 * One hook-free `git` in `directory` that answers its stdout (trimmed unless asked not to), or
 * `undefined` when git failed, could not run, printed more than `maxBuffer`, or outlived the
 * deadline. The probes below are read-only questions about a checkout, and "git could not say" is
 * an answer to each of them.
 */
export const gitAnswer = (
  directory: string,
  args: ReadonlyArray<string>,
  options: GitAnswerOptions = {},
): Effect.Effect<string | undefined> =>
  gitRun(directory, args, options).pipe(
    Effect.map((run) => (run._tag === "ok" ? run.stdout : undefined)),
  );

/**
 * What `ref` names in the repository `directory` is in, told apart from git failing to say: a
 * commit, `absent` when git answered that it names none (`rev-parse --verify --quiet` exits 1 and
 * prints nothing), or `failed` for any other end — a directory that is no repository (exit 128), a
 * git that could not run, or one that outlived `timeoutMs`. A caller that must not read "git could
 * not say" as "there is nothing there" (a policy read, S-factory-config-as-code) reads this.
 */
export const lookupCommit = (
  directory: string,
  ref: string,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<
  | { readonly _tag: "commit"; readonly sha: string }
  | { readonly _tag: "absent" }
  | { readonly _tag: "failed" }
> =>
  gitRun(
    directory,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    options,
  ).pipe(
    Effect.map((run) =>
      run._tag === "ok"
        ? run.stdout === ""
          ? ({ _tag: "failed" } as const)
          : ({ _tag: "commit", sha: run.stdout } as const)
        : run.exitCode === 1
          ? ({ _tag: "absent" } as const)
          : ({ _tag: "failed" } as const),
    ),
  );

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

/**
 * Whether a repo's base ref names a commit in the place a session's worktree is cut from (E8): the
 * checkout's work tree, or the factory's clone. A checkout answers a local branch or an `origin/`
 * tracking one, as `git worktree add` does; the clone is fetched into `refs/remotes/origin/<base>`
 * (`RepoMirror`), so that is the only name it is asked for. A repo with neither has nothing to ask,
 * which is its own answer rather than a failure of the ref.
 */
export const checkBaseRef = (input: {
  readonly ref: string;
  /** `RepoSummary.workTree`: present exactly when the repo's checkout is inside a work tree. */
  readonly workTree: string | undefined;
  /** `RepoSummary.mirrorPath`: the factory's bare clone, when one exists. */
  readonly mirrorPath: string | undefined;
}): Effect.Effect<BaseRefCheck> =>
  Effect.gen(function* () {
    const { ref } = input;
    const found = (sha: string): BaseRefCheck => ({
      ref,
      status: "ok",
      message: `${ref} resolves to ${sha.slice(0, 7)}`,
    });
    if (input.workTree !== undefined) {
      const sha =
        (yield* resolveCommit(input.workTree, ref)) ??
        (yield* resolveCommit(input.workTree, `refs/remotes/origin/${ref}`));
      return sha === undefined
        ? {
            ref,
            status: "unresolved",
            message: `no commit named ${ref} in ${input.workTree}`,
          }
        : found(sha);
    }
    if (input.mirrorPath !== undefined) {
      const sha = yield* resolveCommit(
        input.mirrorPath,
        `refs/remotes/origin/${ref}`,
      );
      return sha === undefined
        ? {
            ref,
            status: "unresolved",
            message: `the clone ${input.mirrorPath} has no ${ref}`,
          }
        : found(sha);
    }
    return {
      ref,
      status: "no_checkout",
      message: `no git checkout or clone to resolve ${ref} in`,
    };
  });
