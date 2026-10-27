/**
 * Moving a session's refs: fetch into its checkout and push its branch out (LOB-54, docs/design.md
 * D10, D11, D14).
 *
 * `workspace.ts` cuts the worktree (LOB-11); this module moves refs between that checkout and a
 * remote the checkout has configured. Both calls resolve a token from the `CredentialProvider` at
 * the moment they run and hand it to that one `git` process only, so the credential is supplied at
 * the call boundary and persisted nowhere:
 *
 * - **Not in `.git/config` and not in the remote URL.** The remote is named, never rewritten; its
 *   stored URL stays the credential-free one the operator configured. A stored URL that already
 *   carries a password is refused rather than used, because using it would make "persisted
 *   nowhere" a property of somebody else's configuration.
 * - **Not on the command line.** The credential helper given with `-c` is a fixed shell function
 *   that prints the token from the child's environment (`FACTORY_GIT_TOKEN`), so `ps` shows the
 *   helper's text and never the value. `http.extraHeader` would have put the token itself in argv.
 * - **Not in any helper that stores.** The empty `credential.helper=` first clears every helper
 *   the system, global and repo configuration named. Without it git would `approve` the working
 *   token to each of them after a successful push — `store` writes it to a plaintext file and
 *   `osxkeychain` to the login keychain — which is exactly the persistence D14 rules out.
 * - **Never prompted for.** `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`/`SSH_ASKPASS` make a
 *   rejected credential an exit code instead of a process waiting on a terminal nobody holds.
 *
 * The process is the control plane's, not the sandbox's: the token is in this one child's
 * environment for the duration of the call, which is the "held by the control plane and injected
 * per call" shape D14 asks for. The sandbox the agent's tools run in never sees it.
 *
 * The push is the narrow one D11 calls unattended: one `refs/heads/factory/**` branch, to the same
 * name on the remote, never forced, never a tag or a deletion. A branch outside `factory/` is
 * refused before any credential is resolved, and so is a name that could smuggle a second refspec
 * (`:`, a leading `+` or `-`). Failures are a `GitError` naming the operation, the remote and the
 * ref, with a `reason` a caller can switch on; git's stderr is classified, never quoted wholesale.
 */
import { Effect, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { RepoSlug } from "@repo/domain/Session";
import type { CredentialError } from "./credentials";
import { CredentialProvider } from "./credentials";

/** Why a fetch or a push did not move the ref. */
export const GitFailureReason = Schema.Literals([
  /** The remote has commits the branch does not: a push that would have to force. */
  "non-fast-forward",
  /** The remote refused the update itself (a hook, a ruleset, a protected branch). */
  "remote-rejected",
  /** The remote refused the credential. */
  "auth",
  /** The ref to fetch is not on the remote, or the branch to push is not in the checkout. */
  "missing-ref",
  /** This module refused the call before running git: a ref or remote outside policy. */
  "refused",
  /** Anything else: git could not run, or failed in a way the above do not name. */
  "failed",
]);
export type GitFailureReason = typeof GitFailureReason.Type;

/** A fetch or a push failed. Typed, so callers handle it instead of reading stderr. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  operation: Schema.Literals(["fetch", "push"]),
  remote: Schema.String,
  /** The full ref the operation was moving: `refs/heads/...` on the remote side. */
  ref: Schema.String,
  reason: GitFailureReason,
  message: Schema.String,
}) {}

/** The username GitHub expects beside an installation token or a PAT sent as a password. */
const TOKEN_USERNAME = "x-access-token";

/** The one environment variable the helper reads. Never written anywhere but the child's env. */
const TOKEN_ENV = "FACTORY_GIT_TOKEN";

/**
 * The inline credential helper. git runs it through the shell with the action appended (`get`,
 * `store`, `erase`); it answers `get` from the environment and ignores the other two, so nothing
 * is ever stored by it. The text is constant: the token never appears in it.
 */
const CREDENTIAL_HELPER = `!f() { if [ "$1" = get ]; then printf 'username=%s\\npassword=%s\\n' '${TOKEN_USERNAME}' "$${TOKEN_ENV}"; fi; }; f`;

/** Configuration for one invocation: clear every configured helper, then add ours. */
const credentialArgs = [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${CREDENTIAL_HELPER}`,
] as const;

/** The branch prefix a session may push unattended (D10, D11). */
export const SESSION_BRANCH_PREFIX = "factory/";

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * A branch name safe to put in a refspec: slash-separated segments of letters, digits, `.`, `_`
 * and `-`, none starting with `.` or `-`, none ending in `.lock` or `.`, and no `..`. Deliberately
 * narrower than `git check-ref-format`: every branch the control plane names (`main`,
 * `factory/<session-id>`, `factory/doc-<id>`) fits, and nothing that could read as a second
 * refspec, an option, or a force does.
 */
export const isSafeBranchName = (branch: string): boolean =>
  branch.length > 0 &&
  !branch.includes("..") &&
  branch
    .split("/")
    .every(
      (segment) =>
        SEGMENT.test(segment) &&
        !segment.endsWith(".lock") &&
        !segment.endsWith("."),
    );

const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

type GitRun = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * One `git` process in the checkout. With a token, the credential arguments and environment are
 * added; without one, git runs as configured (the read-only `remote get-url` below). A spawn that
 * fails — git missing, the directory gone — is reported as the exit code `-1` with the platform's
 * message as stderr, so the classification below has one input shape.
 */
const runGit = (
  worktree: string,
  args: ReadonlyArray<string>,
  token?: Redacted.Redacted<string>,
): Effect.Effect<GitRun, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "git",
        token === undefined ? [...args] : [...credentialArgs, ...args],
        {
          cwd: worktree,
          extendEnv: true,
          env: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
            ...(token === undefined
              ? {}
              : { [TOKEN_ENV]: Redacted.value(token) }),
          },
          stdin: "ignore",
        },
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.succeed({ stdout: "", stderr: String(error), exitCode: -1 }),
    ),
  );

/** Replace the token's bytes wherever they appear, so no message can carry them. */
const scrub = (text: string, token: Redacted.Redacted<string>): string => {
  const value = Redacted.value(token);
  return value.length === 0 ? text : text.split(value).join("<redacted>");
};

/** git's own one-line diagnosis (`fatal: ...` / `error: ...`), when it gave one. */
const diagnosis = (stderr: string): string | undefined =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("fatal:") || line.startsWith("error:"));

/** Classify a failed run by what git said, without quoting it. */
const classify = (stderr: string): GitFailureReason => {
  const text = stderr.toLowerCase();
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|returned error: 40[13]|invalid username or password/.test(
      text,
    )
  )
    return "auth";
  if (/couldn't find remote ref|src refspec .* does not match any/.test(text))
    return "missing-ref";
  return "failed";
};

type RefCall = {
  readonly operation: "fetch" | "push";
  readonly remote: string;
  readonly ref: string;
};

const refused = (call: RefCall, why: string) =>
  new GitError({
    ...call,
    reason: "refused",
    message: `${call.operation} of ${call.ref} via ${call.remote} refused: ${why}`,
  });

const failure = (
  call: RefCall,
  run: GitRun,
  token: Redacted.Redacted<string>,
): GitError => {
  const reason = classify(run.stderr);
  const said = diagnosis(run.stderr);
  const detail =
    reason === "auth"
      ? "the remote refused the credential"
      : reason === "missing-ref"
        ? "the ref does not exist"
        : said === undefined
          ? `git exited ${run.exitCode}`
          : scrub(said, token);
  return new GitError({
    ...call,
    reason,
    message: `${call.operation} of ${call.ref} via ${call.remote} failed: ${detail}`,
  });
};

/** A URL's userinfo password, when it has one: `https://user:secret@host/...`. */
const carriesPassword = (url: string): boolean => {
  try {
    return new URL(url).password.length > 0;
  } catch {
    // scp-like (`git@host:path`) and local paths have no password to carry.
    return false;
  }
};

/**
 * Validate the remote and read its stored URL, refusing one that already carries a credential.
 * Runs before the token is resolved, so a refused call never asks the provider for anything.
 */
const checkRemote = (
  worktree: string,
  call: RefCall,
): Effect.Effect<void, GitError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (!REMOTE_NAME.test(call.remote))
      return yield* refused(call, "the remote is not a configured remote name");
    const url = yield* runGit(worktree, ["remote", "get-url", call.remote]);
    if (url.exitCode !== 0)
      return yield* refused(call, "the checkout has no such remote");
    if (carriesPassword(url.stdout.trim()))
      return yield* refused(
        call,
        "the remote's stored URL carries a credential; remove it, the token is supplied per call",
      );
  });

export type FetchBranchInput = {
  /** The session's checkout: its worktree, or any directory inside the repository. */
  readonly worktree: string;
  /** The repo the token is resolved for. */
  readonly repo: RepoSlug;
  /** A remote configured in the checkout. Defaults to `origin`. */
  readonly remote?: string;
  /** The remote branch to fetch, e.g. the session's base (`main`). */
  readonly branch: string;
};

export type FetchedBranch = {
  /** Where the fetched tip now lives locally: `refs/remotes/<remote>/<branch>`. */
  readonly ref: string;
  readonly sha: string;
};

/**
 * Fetch one branch from the checkout's remote into `refs/remotes/<remote>/<branch>`. The tracking
 * ref is updated even when the remote rewound, the way a default `git fetch` does: it mirrors the
 * remote, and nothing local is lost by it. Tags are not fetched.
 */
export const fetchBranch = (
  input: FetchBranchInput,
): Effect.Effect<
  FetchedBranch,
  GitError | CredentialError,
  CredentialProvider | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const remote = input.remote ?? "origin";
    const call: RefCall = {
      operation: "fetch",
      remote,
      ref: `refs/heads/${input.branch}`,
    };
    if (!isSafeBranchName(input.branch))
      return yield* refused(call, "the branch name is not a plain branch");
    yield* checkRemote(input.worktree, call);
    const token = yield* (yield* CredentialProvider).tokenFor(input.repo);
    const tracking = `refs/remotes/${remote}/${input.branch}`;
    const run = yield* runGit(
      input.worktree,
      ["fetch", "--no-tags", remote, `+${call.ref}:${tracking}`],
      token,
    );
    if (run.exitCode !== 0) return yield* failure(call, run, token);
    const sha = yield* runGit(input.worktree, ["rev-parse", tracking]);
    if (sha.exitCode !== 0) return yield* failure(call, sha, token);
    return { ref: tracking, sha: sha.stdout.trim() };
  }).pipe(Effect.withSpan("git.fetchBranch"));

export type PushBranchInput = {
  /** The session's checkout, where the branch was committed. */
  readonly worktree: string;
  /** The repo the token is resolved for. */
  readonly repo: RepoSlug;
  /** A remote configured in the checkout. Defaults to `origin`. */
  readonly remote?: string;
  /** The session's branch, under `factory/`. Pushed to the same name on the remote. */
  readonly branch: string;
};

export type PushedBranch = {
  /** The remote ref that moved (or already held the commit). */
  readonly ref: string;
  /** The commit the remote ref now names. */
  readonly sha: string;
  /** What the push did, from git's porcelain flag. */
  readonly outcome: "created" | "updated" | "up-to-date";
};

/**
 * One line of `git push --porcelain`: `<flag>\t<from>:<to>\t<summary>`. The flag is ` ` (fast
 * forward), `*` (new ref), `=` (up to date), `!` (rejected), `+` (forced) or `-` (deleted); the last
 * two cannot happen here, since nothing is forced or deleted.
 */
const porcelainLine = (
  stdout: string,
  ref: string,
): { readonly flag: string; readonly summary: string } | undefined => {
  for (const line of stdout.split("\n")) {
    const [flag, refs, summary] = line.split("\t");
    if (flag === undefined || refs === undefined || summary === undefined)
      continue;
    if (refs.split(":")[1] === ref) return { flag, summary };
  }
  return undefined;
};

/**
 * Push the session's branch to the same name on the remote, never forced.
 *
 * A remote that moved past the branch is a `GitError` with reason `non-fast-forward` — git calls
 * the two shapes of it `non-fast-forward` (the checkout knows the remote's commit) and `fetch
 * first` (it does not), and to a caller they are the same answer: fetch, integrate, push again.
 */
export const pushBranch = (
  input: PushBranchInput,
): Effect.Effect<
  PushedBranch,
  GitError | CredentialError,
  CredentialProvider | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const remote = input.remote ?? "origin";
    const ref = `refs/heads/${input.branch}`;
    const call: RefCall = { operation: "push", remote, ref };
    if (!isSafeBranchName(input.branch))
      return yield* refused(call, "the branch name is not a plain branch");
    if (!input.branch.startsWith(SESSION_BRANCH_PREFIX))
      return yield* refused(
        call,
        `only ${SESSION_BRANCH_PREFIX}** branches are pushed unattended`,
      );
    yield* checkRemote(input.worktree, call);
    const token = yield* (yield* CredentialProvider).tokenFor(input.repo);
    const run = yield* runGit(
      input.worktree,
      ["push", "--porcelain", "--no-follow-tags", remote, `${ref}:${ref}`],
      token,
    );
    const line = porcelainLine(run.stdout, ref);
    if (line?.flag === "!") {
      const nonFastForward = /non-fast-forward|fetch first/.test(line.summary);
      const remoteRejected = line.summary.startsWith("[remote rejected]");
      return yield* new GitError({
        ...call,
        reason: nonFastForward
          ? "non-fast-forward"
          : remoteRejected
            ? "remote-rejected"
            : "failed",
        message: nonFastForward
          ? `push of ${ref} via ${remote} rejected: the remote has commits this branch does not; fetch and integrate them, then push again`
          : `push of ${ref} via ${remote} rejected: ${scrub(line.summary, token)}`,
      });
    }
    if (run.exitCode !== 0 || line === undefined)
      return yield* failure(call, run, token);
    const sha = yield* runGit(input.worktree, ["rev-parse", ref]);
    if (sha.exitCode !== 0) return yield* failure(call, sha, token);
    const outcome: PushedBranch["outcome"] =
      line.flag === "*"
        ? "created"
        : line.flag === "="
          ? "up-to-date"
          : "updated";
    return { ref, sha: sha.stdout.trim(), outcome };
  }).pipe(Effect.withSpan("git.pushBranch"));
