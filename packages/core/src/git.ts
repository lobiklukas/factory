/**
 * Moving a session's refs: fetch into its checkout and push its branch out (LOB-54, docs/design.md
 * D10, D11, D14, D15).
 *
 * `workspace.ts` cuts the worktree (LOB-11); this module moves refs between that checkout and the
 * repo's forge. Both calls resolve a token from the `CredentialProvider` at the moment they run and
 * hand it to one `git` process only, so the credential is supplied at the call boundary and
 * persisted nowhere.
 *
 * **The checkout never configures the credentialed process.** The session's worktree is also the
 * agent's working directory (D10), so everything in its `.git` — hooks, `core.hooksPath`,
 * `core.fsmonitor`, remotes and `pushurl`s, `url.*.insteadOf`, `http.proxy`, `http.sslVerify`,
 * `include.path` — is agent-writable, and D15 says hooks are not a boundary. So the git that holds
 * the token does not run in the checkout at all. It runs against a scratch bare repository this
 * module creates per call in a temp directory the control plane owns, with the checkout's object
 * store attached as its object directory (`GIT_OBJECT_DIRECTORY`): it can read the session's
 * commits and write fetched objects back, but reads no line of the checkout's config, runs none of
 * its hooks, and finds no remote there to be redirected through. System and global config are
 * off as well (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`); what configures the process
 * is the `-c` list below and nothing else. The uncredentialed calls that do run in the checkout
 * (`rev-parse`, `for-each-ref`, `update-ref`) carry `core.hooksPath=/dev/null` and
 * `core.fsmonitor=false`, so the control plane runs no agent-written code even without a token.
 *
 * **The token goes to the repo it was issued for, and nowhere else.** The URL is an explicit
 * argument, never a remote name: `https://github.com/<repo>.git` by default, or a caller's URL that
 * must be on GitHub's origin or a loopback host, be `https` (plain `http` only to loopback, which is
 * what the tests serve), carry no userinfo, query or fragment, and name `<repo>` as its path. git is allowed that one protocol,
 * follows no redirect, recurses into no submodule, and the helper is scoped to that URL's origin,
 * so even a URL git computed some other way would get no answer from it.
 *
 * **The token is not on disk, not in argv, not in any helper that stores.** The credential helper
 * given with `-c` is a fixed shell function that prints the token from the child's environment
 * (`FACTORY_GIT_TOKEN`), so `ps` shows the helper's text and never the value; the empty
 * `credential.helper=` before it clears any other helper, so nothing `approve`s the token into a
 * store; and `GIT_TERMINAL_PROMPT=0` with an empty `GIT_ASKPASS`/`SSH_ASKPASS`/`core.askPass` makes a
 * rejected credential an exit code instead of a process waiting on a terminal nobody holds.
 *
 * The push is the narrow one D11 calls unattended: one `refs/heads/factory/**` branch, to the same
 * name on the remote, never forced, never a tag or a deletion, and the commit pushed is the one
 * resolved before the credential was, so the sha returned is the sha sent. A branch outside
 * `factory/` is refused before any credential is resolved, and so is a name that could smuggle a
 * second refspec (`:`, a leading `+` or `-`). Every network call has a deadline. Failures are a
 * `GitError` naming the operation, the repo and the ref, with a `reason` a caller can switch on;
 * git's stderr is classified, never quoted wholesale.
 */
import { Duration, Effect, FileSystem, Redacted, Schema, Stream } from "effect";
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
  /** This module refused the call before running git: a ref or URL outside policy. */
  "refused",
  /** The network call did not finish before its deadline; the process was killed. */
  "timeout",
  /** Anything else: git could not run, or failed in a way the above do not name. */
  "failed",
]);
export type GitFailureReason = typeof GitFailureReason.Type;

/** A fetch or a push failed. Typed, so callers handle it instead of reading stderr. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  operation: Schema.Literals(["fetch", "push"]),
  /** The repo the call was for. Never a URL, so a refused URL's userinfo is never echoed. */
  repo: Schema.String,
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

/** The forge a repo slug names when the caller gives no URL. */
export const DEFAULT_FORGE_ORIGIN = "https://github.com";

/** How long one credentialed network call may run before it is killed. */
export const DEFAULT_GIT_TIMEOUT: Duration.Input = Duration.minutes(5);

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

/** Hosts plain `http` may be used with: the token never leaves the machine to reach them. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The one URL a credentialed call may talk to, already checked against its repo. */
export type ForgeUrl = {
  /** What git is given: `<origin><path>`, no userinfo, query or fragment. */
  readonly url: string;
  /** `scheme://host[:port]`: the scope the credential helper answers for. */
  readonly origin: string;
  readonly scheme: "https" | "http";
};

/**
 * The URL a token for `repo` may be sent to, or why `url` is not one. With no `url`, the repo on
 * GitHub. A given URL must be on GitHub's origin or a loopback host (the tests' forge; a GitHub
 * Enterprise host would be added here, deliberately), be `https` (`http` only to loopback), carry
 * no userinfo — a
 * password *or* a token placed as the username — and no query or fragment, and its path must be
 * `/<repo>` or `/<repo>.git`, compared case-insensitively the way GitHub compares slugs.
 */
export const resolveForgeUrl = (
  repo: RepoSlug,
  url?: string,
):
  | { readonly ok: true; readonly forge: ForgeUrl }
  | { readonly ok: false; readonly why: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url ?? `${DEFAULT_FORGE_ORIGIN}/${repo}.git`);
  } catch {
    return { ok: false, why: "the URL is not an absolute URL" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0)
    return {
      ok: false,
      why: "the URL carries a credential; remove it, the token is supplied per call",
    };
  const scheme =
    parsed.protocol === "https:"
      ? "https"
      : parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)
        ? "http"
        : undefined;
  if (scheme === undefined)
    return {
      ok: false,
      why: "only https URLs (or http to a loopback host) are given a token",
    };
  if (
    !LOOPBACK_HOSTS.has(parsed.hostname) &&
    parsed.origin !== DEFAULT_FORGE_ORIGIN
  )
    return {
      ok: false,
      why: `only ${DEFAULT_FORGE_ORIGIN} (or a loopback host) is given a token`,
    };
  if (parsed.search.length > 0 || parsed.hash.length > 0)
    return { ok: false, why: "the URL carries a query or a fragment" };
  const path = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (path !== `/${repo}`)
    return { ok: false, why: `the URL does not name ${repo}` };
  return {
    ok: true,
    forge: {
      url: `${parsed.origin}${parsed.pathname}`,
      origin: parsed.origin,
      scheme,
    },
  };
};

/**
 * Carried by every invocation, credentialed or not: run no hook and no fsmonitor, whatever the
 * repository's config says. These are the two ways a read-only-looking git call in an
 * agent-writable checkout executes agent-written code in the control plane.
 */
const NO_CHECKOUT_CODE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

/**
 * The whole configuration of a credentialed call, on top of the empty system/global config: one
 * protocol, no redirect, no submodule, no signing, no automatic gc (the object directory is the
 * checkout's, and a gc that saw only the scratch repo's refs would prune the session's objects),
 * and one helper, answering only for the forge's origin.
 */
const credentialArgs = (forge: ForgeUrl): ReadonlyArray<string> =>
  [
    "credential.helper=",
    `credential.${forge.origin}.helper=${CREDENTIAL_HELPER}`,
    "core.askPass=",
    "protocol.allow=never",
    `protocol.${forge.scheme}.allow=always`,
    "http.followRedirects=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "push.recurseSubmodules=no",
    "push.gpgSign=false",
    "gc.auto=0",
    "maintenance.auto=false",
  ].flatMap((setting) => ["-c", setting]);

type GitRun = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * One `git` process. `env` is added to the inherited environment, after the no-prompt settings.
 * A spawn that fails — git missing, the directory gone — is reported as the exit code `-1` with the
 * platform's message as stderr, so the classification below has one input shape. Interrupting it
 * (a deadline) closes its scope, which kills the process.
 */
const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Effect.Effect<GitRun, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", [...NO_CHECKOUT_CODE, ...args], {
        cwd,
        extendEnv: true,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          ...env,
        },
        stdin: "ignore",
      }),
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
  readonly repo: string;
  readonly ref: string;
};

const subject = (call: RefCall) =>
  `${call.operation} of ${call.ref} for ${call.repo}`;

const refused = (call: RefCall, why: string) =>
  new GitError({
    ...call,
    reason: "refused",
    message: `${subject(call)} refused: ${why}`,
  });

const failure = (
  call: RefCall,
  run: GitRun,
  token?: Redacted.Redacted<string>,
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
          : token === undefined
            ? said
            : scrub(said, token);
  return new GitError({
    ...call,
    reason,
    message: `${subject(call)} failed: ${detail}`,
  });
};

/** The scratch repository a credentialed call runs in, and the environment that attaches it. */
type Scratch = {
  readonly gitDir: string;
  readonly env: Record<string, string>;
};

/**
 * Make the scratch repository for one call: a bare repo in a control-plane temp directory, with
 * the same object format as the checkout and the checkout's object directory attached. The
 * checkout is only *read* here (by uncredentialed, hook-free git); nothing from its config is
 * carried over. `seedRefs` copies the checkout's ref tips as plain refs, so a fetch negotiates
 * from what the checkout already has instead of downloading the whole history again. The
 * directory is removed when the surrounding scope closes.
 */
const makeScratch = (worktree: string, call: RefCall, seedRefs: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const objects = yield* runGit(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    const format = yield* runGit(worktree, [
      "rev-parse",
      "--show-object-format",
    ]);
    const shallow = yield* runGit(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "shallow",
    ]);
    if (
      objects.exitCode !== 0 ||
      format.exitCode !== 0 ||
      shallow.exitCode !== 0
    )
      return yield* refused(call, "the checkout is not a git repository");
    const gitDir = yield* fs.makeTempDirectoryScoped({
      prefix: "factory-git-",
    });
    const env: Record<string, string> = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OBJECT_DIRECTORY: objects.stdout.trim(),
    };
    const init = yield* runGit(
      gitDir,
      [
        "-c",
        "init.defaultRefFormat=files",
        "init",
        "--bare",
        "--quiet",
        "--template=",
        `--object-format=${format.stdout.trim()}`,
        gitDir,
      ],
      { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    );
    if (init.exitCode !== 0) return yield* failure(call, init);
    const shallowFile = shallow.stdout.trim();
    if (yield* fs.exists(shallowFile))
      yield* fs.copyFile(shallowFile, `${gitDir}/shallow`);
    if (seedRefs) {
      const refs = yield* runGit(worktree, [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
      ]);
      if (refs.exitCode !== 0) return yield* failure(call, refs);
      yield* fs.writeFileString(`${gitDir}/packed-refs`, refs.stdout);
    }
    return { gitDir, env } satisfies Scratch;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new GitError({
          ...call,
          reason: "failed",
          message: `${subject(call)} failed: could not prepare the scratch repository (${error.reason._tag})`,
        }),
      ),
    ),
  );

/**
 * The credentialed `git` process: in the scratch repository, with the token in its environment,
 * killed at the deadline. A deadline is a `GitError` with reason `timeout`, not a hang.
 */
const runCredentialed = (
  scratch: Scratch,
  forge: ForgeUrl,
  args: ReadonlyArray<string>,
  token: Redacted.Redacted<string>,
  call: RefCall,
  timeout: Duration.Input,
) =>
  runGit(
    scratch.gitDir,
    [...credentialArgs(forge), "--git-dir", scratch.gitDir, ...args],
    { ...scratch.env, [TOKEN_ENV]: Redacted.value(token) },
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap((run) =>
      run._tag === "Some"
        ? Effect.succeed(run.value)
        : Effect.fail(
            new GitError({
              ...call,
              reason: "timeout",
              message: `${subject(call)} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
            }),
          ),
    ),
  );

/** Validate the forge URL against the repo, before any credential is resolved. */
const forgeFor = (repo: RepoSlug, url: string | undefined, call: RefCall) => {
  const resolved = resolveForgeUrl(repo, url);
  return resolved.ok
    ? Effect.succeed(resolved.forge)
    : Effect.fail(refused(call, resolved.why));
};

export type FetchBranchInput = {
  /** The session's checkout: its worktree, or any directory inside the repository. */
  readonly worktree: string;
  /** The repo the token is resolved for, and the only repo it is sent to. */
  readonly repo: RepoSlug;
  /** The repo's URL. Defaults to `https://github.com/<repo>.git`; see `resolveForgeUrl`. */
  readonly url?: string;
  /** Names the tracking ref the fetch updates. Defaults to `origin`. Its config is never read. */
  readonly remote?: string;
  /** The remote branch to fetch, e.g. the session's base (`main`). */
  readonly branch: string;
  /** How long the network call may run. Defaults to `DEFAULT_GIT_TIMEOUT`. */
  readonly timeout?: Duration.Input;
};

export type FetchedBranch = {
  /** Where the fetched tip now lives locally: `refs/remotes/<remote>/<branch>`. */
  readonly ref: string;
  readonly sha: string;
};

/**
 * Fetch one branch from the repo's forge into the checkout's `refs/remotes/<remote>/<branch>`.
 * The objects land in the checkout's object store; the tracking ref is then set in the checkout
 * by an uncredentialed, hook-free `update-ref`. It is updated even when the remote rewound, the way
 * a default `git fetch` does: it mirrors the remote, and nothing local is lost by it. Tags are not
 * fetched.
 */
export const fetchBranch = (
  input: FetchBranchInput,
): Effect.Effect<
  FetchedBranch,
  GitError | CredentialError,
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const remote = input.remote ?? "origin";
    const call: RefCall = {
      operation: "fetch",
      repo: input.repo,
      ref: `refs/heads/${input.branch}`,
    };
    if (!isSafeBranchName(input.branch))
      return yield* refused(call, "the branch name is not a plain branch");
    if (!REMOTE_NAME.test(remote))
      return yield* refused(call, "the remote is not a plain remote name");
    const forge = yield* forgeFor(input.repo, input.url, call);
    const scratch = yield* makeScratch(input.worktree, call, true);
    const token = yield* (yield* CredentialProvider).tokenFor(input.repo);
    const tracking = `refs/remotes/${remote}/${input.branch}`;
    const run = yield* runCredentialed(
      scratch,
      forge,
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        forge.url,
        `+${call.ref}:${tracking}`,
      ],
      token,
      call,
      input.timeout ?? DEFAULT_GIT_TIMEOUT,
    );
    if (run.exitCode !== 0) return yield* failure(call, run, token);
    const sha = yield* runGit(
      scratch.gitDir,
      ["--git-dir", scratch.gitDir, "rev-parse", "--verify", tracking],
      scratch.env,
    );
    if (sha.exitCode !== 0) return yield* failure(call, sha, token);
    const fetched = sha.stdout.trim();
    const update = yield* runGit(input.worktree, [
      "update-ref",
      "-m",
      `factory: fetch ${call.ref}`,
      tracking,
      fetched,
    ]);
    if (update.exitCode !== 0) return yield* failure(call, update, token);
    return { ref: tracking, sha: fetched };
  }).pipe(Effect.scoped, Effect.withSpan("git.fetchBranch"));

export type PushBranchInput = {
  /** The session's checkout, where the branch was committed. */
  readonly worktree: string;
  /** The repo the token is resolved for, and the only repo it is sent to. */
  readonly repo: RepoSlug;
  /** The repo's URL. Defaults to `https://github.com/<repo>.git`; see `resolveForgeUrl`. */
  readonly url?: string;
  /** The session's branch, under `factory/`. Pushed to the same name on the remote. */
  readonly branch: string;
  /** How long the network call may run. Defaults to `DEFAULT_GIT_TIMEOUT`. */
  readonly timeout?: Duration.Input;
};

export type PushedBranch = {
  /** The remote ref that moved (or already held the commit). */
  readonly ref: string;
  /** The commit pushed: resolved before the push and sent by name, so it is what the remote holds. */
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
 * The branch's commit is resolved first, and that sha — not the branch name — is what is pushed,
 * so a commit the agent makes while the push runs is not half-reported: the returned `sha` is the
 * one the remote received. A remote that moved past it is a `GitError` with reason
 * `non-fast-forward` — git calls the two shapes of it `non-fast-forward` (the checkout knows the
 * remote's commit) and `fetch first` (it does not), and to a caller they are the same answer:
 * fetch, integrate, push again.
 */
export const pushBranch = (
  input: PushBranchInput,
): Effect.Effect<
  PushedBranch,
  GitError | CredentialError,
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const ref = `refs/heads/${input.branch}`;
    const call: RefCall = { operation: "push", repo: input.repo, ref };
    if (!isSafeBranchName(input.branch))
      return yield* refused(call, "the branch name is not a plain branch");
    if (!input.branch.startsWith(SESSION_BRANCH_PREFIX))
      return yield* refused(
        call,
        `only ${SESSION_BRANCH_PREFIX}** branches are pushed unattended`,
      );
    const forge = yield* forgeFor(input.repo, input.url, call);
    const local = yield* runGit(input.worktree, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (local.exitCode !== 0)
      return yield* new GitError({
        ...call,
        reason: "missing-ref",
        message: `${subject(call)} failed: the checkout has no such branch`,
      });
    const sha = local.stdout.trim();
    const scratch = yield* makeScratch(input.worktree, call, false);
    const token = yield* (yield* CredentialProvider).tokenFor(input.repo);
    const run = yield* runCredentialed(
      scratch,
      forge,
      [
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--recurse-submodules=no",
        forge.url,
        `${sha}:${ref}`,
      ],
      token,
      call,
      input.timeout ?? DEFAULT_GIT_TIMEOUT,
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
          ? `${subject(call)} rejected: the remote has commits this branch does not; fetch and integrate them, then push again`
          : `${subject(call)} rejected: ${scrub(line.summary, token)}`,
      });
    }
    if (run.exitCode !== 0 || line === undefined)
      return yield* failure(call, run, token);
    const outcome: PushedBranch["outcome"] =
      line.flag === "*"
        ? "created"
        : line.flag === "="
          ? "up-to-date"
          : "updated";
    return { ref, sha, outcome };
  }).pipe(Effect.scoped, Effect.withSpan("git.pushBranch"));
