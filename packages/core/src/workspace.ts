/* oxlint-disable */
/**
 * What a session's working directory is, and what its repo says about itself
 * (docs/features.md §3 A1).
 *
 * Two things this module deliberately does not do: clone, and guess. It cuts a worktree from a
 * checkout it is handed — the registered local path, or the factory's own mirror of a URL-only repo
 * (`./RepoMirror`, LOB-265), which the caller fetches and this module only cuts from — and the
 * commands come from a `.factory/config` that checkout put there: the local registry path when the
 * repo has one, the session's own directory otherwise. A repo with no config resolves to no commands
 * and says so (`commandsSource: "none"`), rather than failing or inventing a build.
 *
 * The filesystem and path services arrive as values, the way the storage adapter takes its
 * `SqlClient`: that keeps `Effect`'s shape types free of the services this module merely uses.
 */
import { Effect, Option, Schema } from "effect";
// oxlint-disable-next-line node-builtin-import
import { execFileSync, execSync } from "node:child_process";
// oxlint-disable-next-line node-builtin-import
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line node-builtin-import
import { randomUUID } from "node:crypto";
// oxlint-disable-next-line node-builtin-import
import { join } from "node:path";
import type { FileSystem, Path } from "effect";
import type {
  RepoCloneFailed,
  RepoCommands,
  RepoSlug,
  SessionWorkspace,
} from "@repo/domain/Session";

/** Where a repo declares its commands, relative to a checkout root. */
export const CONFIG_FILE = [".factory", "config"] as const;

const RepoCommandsFromJson = Schema.fromJsonString(
  Schema.Struct({
    install: Schema.optional(Schema.String),
    build: Schema.optional(Schema.String),
    test: Schema.optional(Schema.String),
    verify: Schema.optional(Schema.String),
  }),
);

const NO_COMMANDS: RepoCommands = {};

/** The services this module needs, passed in rather than required from the environment. */
export type WorkspaceDeps = {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
};

/**
 * One directory per session, scoped by repo when there is one, so two sessions never share a
 * working tree (D10's one-branch-per-session becomes a worktree here in M6).
 */
export const sessionDirectory = (
  path: Path.Path,
  sessionRoot: string,
  sessionId: string,
  repo?: RepoSlug,
): string =>
  repo === undefined
    ? path.join(sessionRoot, sessionId)
    : path.join(sessionRoot, ...repo.split("/"), sessionId);

export type WorkspaceInput = {
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly repo?: RepoSlug | undefined;
  readonly baseRef?: string | undefined;
  /**
   * The branch to cut the worktree on, when the caller named one (LOB-197). Absent means
   * `factory/<session-id>`, which is D10's default and derives from the id alone; a docs run names
   * `factory/doc-<id>` so the branch says what produced it.
   */
  readonly branch?: string | undefined;
  /** A checkout to read `.factory/config` from, when the session's own directory has none. */
  readonly localPath?: string | undefined;
  /**
   * The factory's bare mirror of the repo, to cut from when it has no `localPath` (LOB-265). `path`
   * is where it lives, cloned or not; `sync` clones or fetches the base ref into it and answers the
   * ref to cut the worktree at. It runs only when a worktree is about to be cut, so a session whose
   * directory is already a workspace — an idle owner reopening — makes no network call.
   */
  readonly mirror?:
    | {
        readonly path: string;
        readonly sync: Effect.Effect<string, RepoCloneFailed>;
      }
    | undefined;
  /**
   * The ref a new branch is cut at instead of `baseRef`, when the caller fetched the base from the
   * repo's forge into the registered checkout (C17): `refs/remotes/factory/<base>`, so the worktree
   * starts at the remote's base rather than at however far behind it the operator's local branch is.
   * Cut untracked. Ignored for a mirror, whose `sync` answers its own start point.
   */
  readonly startPoint?: string | undefined;
  /**
   * Whether a missing worktree is cut (LOB-268). Absent means yes. A session whose workspace was
   * torn down resolves with `false`, so reading it never cuts a fresh worktree on a fresh branch at
   * the base — which is what a read would otherwise do, because the directory is gone.
   */
  readonly cut?: boolean | undefined;
};

/**
 * Why a repo-bound session or board that has no local checkout cannot produce a diff, and the
 * command that fixes it (LOB-263). One text for every surface that names it — the session's
 * workspace, a board's creation and read, the boot log of a trigger rule — so the operator reads the
 * same sentence wherever they meet it. `factory repo add` is the CLI's own spelling of `registerRepo`.
 */
export const noCheckoutWarning = (repo: string): string =>
  `repo ${repo} has no local checkout registered, so a run on it gets an empty directory instead of a worktree and can produce no diff: register one with \`factory repo add ${repo} --path <dir>\``;

/**
 * Where `checkout` sits inside its git work tree, as `git rev-parse --show-prefix` prints it with no
 * trailing slash: `""` for the work tree's root — any directory holding its own `.git`, which is
 * answered without running git — or for a path git cannot answer for.
 */
export const workTreePrefix = (
  checkout: string,
  deps: WorkspaceDeps,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const atRoot = yield* deps.fs
      .exists(deps.path.join(checkout, ".git"))
      .pipe(Effect.orElseSucceed(() => true));
    if (atRoot) return "";
    return yield* Effect.try({
      try: () =>
        execFileSync("git", ["rev-parse", "--show-prefix"], {
          cwd: checkout,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .replace(/\/+$/, ""),
      // oxlint-disable-next-line global-error-in-effect-catch
      catch: () => new Error(`not a work tree: ${checkout}`),
    }).pipe(Effect.orElseSucceed(() => ""));
  });

/** Read the declared commands from one directory, tolerating a missing or undecodable file. */
const commandsIn = (
  directory: string,
  deps: WorkspaceDeps,
): Effect.Effect<Option.Option<RepoCommands>> =>
  Effect.gen(function* () {
    const file = deps.path.join(directory, ...CONFIG_FILE);
    const exists = yield* deps.fs
      .exists(file)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<RepoCommands>();
    const text = yield* deps.fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) {
      yield* Effect.logWarning(
        `could not read ${file}; opening with no commands`,
      );
      return Option.none<RepoCommands>();
    }
    const decoded = Schema.decodeOption(RepoCommandsFromJson)(text.value);
    if (Option.isNone(decoded)) {
      // Defensive, like the projection: a repo whose config we cannot understand still opens.
      yield* Effect.logWarning(
        `${file} is not a commands document; opening with no commands`,
      );
      return Option.none<RepoCommands>();
    }
    return decoded;
  });

/**
 * Git options every call below passes: no hook and no fsmonitor runs on the control plane's behalf,
 * whatever a config the agent can write says (as `./git.ts` does for a push).
 */
const QUIET_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

/**
 * Hand `branch` over to the worktree about to be cut for it (C19): when another session's worktree —
 * one under the session root — has it checked out, that worktree's HEAD is detached at the commit it
 * is on, so git lets the new one check the branch out. A card's runs share one branch
 * (`./cardBranch`), git checks a branch out in one worktree at a time, and the newest run is the one
 * working on it; the earlier run's files, uncommitted edits included, stay exactly as they were.
 *
 * A worktree outside the session root — the operator's own checkout, a worktree they made — is never
 * touched: the cut then fails on git's own refusal, as it did before.
 *
 * The HEAD is written through the worktree's administrative directory in the registered checkout
 * (`<common>/worktrees/<name>`, the one whose `gitdir` names it), never by running git inside the
 * agent's directory. Best effort: anything that fails here leaves the cut to fail on its own terms.
 */
const takeBranchOver = (
  checkout: string,
  branch: string,
  sessionRoot: string,
): void => {
  try {
    const listing = execFileSync(
      "git",
      ["-C", checkout, ...QUIET_GIT, "worktree", "list", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const holders = listing
      .split(/\n\n+/)
      .map((block) => {
        const lines = block.split("\n");
        const field = (name: string) =>
          lines
            .find((line) => line.startsWith(`${name} `))
            ?.slice(name.length + 1);
        return {
          path: field("worktree"),
          head: field("HEAD"),
          branch: field("branch"),
        };
      })
      .filter(
        (holder) =>
          holder.branch === `refs/heads/${branch}` &&
          holder.path !== undefined &&
          holder.head !== undefined &&
          holder.path.startsWith(`${sessionRoot}/`),
      );
    if (holders.length === 0) return;
    const common = execFileSync(
      "git",
      [
        "-C",
        checkout,
        ...QUIET_GIT,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const admin = join(common, "worktrees");
    for (const name of readdirSync(admin)) {
      let gitdir: string;
      try {
        gitdir = readFileSync(join(admin, name, "gitdir"), "utf8").trim();
      } catch {
        continue;
      }
      const holder = holders.find(
        (candidate) => `${candidate.path}/.git` === gitdir,
      );
      if (holder?.head === undefined) continue;
      execFileSync(
        "git",
        [
          `--git-dir=${join(admin, name)}`,
          ...QUIET_GIT,
          "update-ref",
          "--no-deref",
          "-m",
          `factory: ${branch} continues in another session's worktree`,
          "HEAD",
          holder.head,
        ],
        { stdio: "ignore" },
      );
    }
  } catch {
    // Left to the cut: `worktree add` names what is in the way.
  }
};

/** The file in a worktree's administrative directory that names the cut that made it. */
const CUT_FILE = "factory-cut";

/**
 * Name the worktree just cut at `directory` (F23): a fresh id in its administrative directory
 * (`<common>/worktrees/<name>`), which `git worktree remove` takes with the worktree, so a worktree
 * cut again at the same path is a different cut. Out of the worktree itself, so it is no untracked
 * file in the agent's status. Best effort: a worktree with no id is read as one nobody can tell
 * apart from before (`readWorktreeCut`), and its setup is not run again on a guess.
 */
const stampCut = (directory: string): void => {
  try {
    const gitdir = execFileSync(
      "git",
      [
        "-C",
        directory,
        ...QUIET_GIT,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    writeFileSync(join(gitdir, CUT_FILE), `${randomUUID()}\n`);
  } catch {
    // Unstamped: see above.
  }
};

/**
 * The id of the cut that made the worktree at `directory` (F23), or `undefined` when it has none: a
 * plain directory, a worktree cut before cuts were named, or one whose administrative directory is
 * unreadable. Read through the worktree's `.git` pointer rather than by running git in the agent's
 * directory, as `takeBranchOver` writes through it.
 */
export const readWorktreeCut = (
  directory: string,
  deps: WorkspaceDeps,
): Effect.Effect<string | undefined> =>
  deps.fs.readFileString(join(directory, ".git")).pipe(
    Effect.map((pointer) => /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim()),
    Effect.flatMap((gitdir) =>
      gitdir === undefined
        ? Effect.undefined
        : deps.fs.readFileString(
            deps.path.resolve(directory, gitdir, CUT_FILE),
          ),
    ),
    Effect.map((id) =>
      id === undefined || id.trim() === "" ? undefined : id.trim(),
    ),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The session's directory, its repo binding, and the commands its repo declares. Never fails: a
 * session always has a workspace, even if the repo says nothing about itself.
 */
export const resolveWorkspace = (
  input: WorkspaceInput,
  deps: WorkspaceDeps,
): Effect.Effect<SessionWorkspace, Error | RepoCloneFailed> =>
  Effect.gen(function* () {
    const directory = sessionDirectory(
      deps.path,
      input.sessionRoot,
      input.sessionId,
      input.repo,
    );
    const branch =
      input.repo === undefined
        ? undefined
        : (input.branch ?? `factory/${input.sessionId}`);
    // M6: cut a linked worktree at the base ref off the registered repo's local_path, or off the
    // factory's mirror of it when the repo has only a URL (LOB-265).
    const baseRef = input.baseRef ?? "main";
    let mirrorUsed = false;
    if (
      input.repo !== undefined &&
      (input.localPath !== undefined || input.mirror !== undefined) &&
      input.cut !== false
    ) {
      // An empty directory is not a workspace yet (LOB-263): a session opened while its repo had no
      // checkout holds one (the owner makes the directory), and the worktree is cut into it once a
      // path is registered, so the fix the warning names reaches the sessions it was raised for.
      // `git worktree add` takes an existing empty directory; one with anything in it is the
      // agent's, and is left as it is.
      const occupied = yield* deps.fs.readDirectory(directory).pipe(
        Effect.map((entries) => entries.length > 0),
        Effect.orElseSucceed(() => false),
      );
      // Only a worktree about to be cut needs the mirror's tip: fetching it for one that exists
      // would put the network under every reopened session.
      const mirror = input.localPath === undefined ? input.mirror : undefined;
      let startPoint =
        mirror === undefined ? (input.startPoint ?? baseRef) : baseRef;
      if (mirror !== undefined && !occupied) {
        startPoint = yield* mirror.sync;
        mirrorUsed = true;
      }
      const checkout = input.localPath ?? input.mirror?.path;
      if (checkout !== undefined && (mirror === undefined || !occupied)) {
        yield* Effect.try({
          try: () =>
            execSync("git rev-parse --is-inside-work-tree", {
              cwd: checkout,
              stdio: "ignore",
            }),
          // oxlint-disable-next-line global-error-in-effect-catch
          catch: () =>
            new Error(
              `repo ${input.repo} ${mirror === undefined ? "local_path" : "mirror"} is not a git repository: ${checkout}`,
            ),
        });
      }
      // Set whenever there is a repo (above); narrowed here so it can be an argv entry.
      const worktreeBranch = branch ?? `factory/${input.sessionId}`;
      // As git spells the worktrees it lists (it resolves symlinks), so `takeBranchOver` can tell
      // a session's worktree from one of the operator's.
      const sessionRoot =
        !occupied && checkout !== undefined
          ? yield* deps.fs
              .realPath(input.sessionRoot)
              .pipe(Effect.orElseSucceed(() => input.sessionRoot))
          : input.sessionRoot;
      if (!occupied && checkout !== undefined) {
        yield* Effect.try({
          try: () => {
            const parent = deps.path.dirname(directory);
            // Every call here takes an argv, never a shell line: the base ref is a card's or a
            // create's (LOB-260), and a shell would expand `$(...)` inside JSON.stringify's quotes.
            execFileSync("mkdir", ["-p", parent]);
            // A worktree whose directory went missing is still registered, and git refuses to
            // check its branch out a second time until that registration is cleared. Only this
            // path's is: a bare `git worktree prune` would clear every stale registration in the
            // operator's checkout, theirs included (a worktree on an unmounted volume, say).
            try {
              execFileSync(
                "git",
                ["worktree", "remove", "--force", directory],
                { cwd: checkout, stdio: "ignore" },
              );
            } catch {
              // not registered: nothing to clear
            }
            // Reuse the session's branch when it exists — the idle sweep and a restart leave it,
            // with the run's commits on it (LOB-268), and a card's earlier run leaves the card's
            // (C19), checked out in its worktree until this one takes it over — otherwise create it
            // at the base ref.
            takeBranchOver(checkout, worktreeBranch, sessionRoot);
            let created = false;
            try {
              execFileSync(
                "git",
                ["worktree", "add", directory, worktreeBranch],
                {
                  cwd: checkout,
                  stdio: "ignore",
                },
              );
              created = true;
            } catch {
              // branch may not exist yet
            }
            if (!created) {
              execFileSync(
                "git",
                [
                  "worktree",
                  "add",
                  // The mirror's start point, and a fetched base's, is a remote-tracking ref of a
                  // remote the checkout has not configured: tracking it would write an upstream
                  // into its config for nothing.
                  ...(mirror === undefined && input.startPoint === undefined
                    ? []
                    : ["--no-track"]),
                  "-b",
                  worktreeBranch,
                  directory,
                  startPoint,
                ],
                { cwd: checkout, stdio: "ignore" },
              );
            }
            stampCut(directory);
          },
          // oxlint-disable-next-line global-error-in-effect-catch
          catch: (e) =>
            new Error(
              `repo ${input.repo}: failed to create worktree at ${baseRef}: ${String(e)}`,
            ),
        });
      }
    }
    // A checkout registered at a subdirectory of its work tree (a verify skill's fixture inside the
    // factory's own monorepo) is that subdirectory's repo: its config in the session's worktree is
    // at the same place, not at the work tree's root, which is the enclosing repo's (S-env-setup).
    const prefix =
      input.localPath === undefined
        ? ""
        : yield* workTreePrefix(input.localPath, deps);
    const fromSession = yield* commandsIn(
      prefix === "" ? directory : deps.path.join(directory, prefix),
      deps,
    );
    const fromRepo =
      Option.isSome(fromSession) || input.localPath === undefined
        ? Option.none<RepoCommands>()
        : yield* commandsIn(input.localPath, deps);
    const found = Option.isSome(fromSession) ? fromSession : fromRepo;
    // A mirror that is not cloned yet is no checkout: a read of such a session warns as before.
    const hasCheckout =
      input.localPath !== undefined ||
      mirrorUsed ||
      (input.mirror !== undefined &&
        (yield* deps.fs
          .exists(deps.path.join(input.mirror.path, "HEAD"))
          .pipe(Effect.orElseSucceed(() => false))));
    return {
      path: directory,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.repo === undefined || input.baseRef === undefined
        ? {}
        : { baseRef: input.baseRef }),
      ...(input.repo === undefined ? {} : { branch }),
      commands: Option.getOrElse(found, () => NO_COMMANDS),
      commandsSource: Option.isSome(found) ? "repo" : "none",
      ...(input.repo !== undefined && !hasCheckout
        ? { warning: noCheckoutWarning(input.repo) }
        : {}),
    };
  });

export type RemoveWorkspaceInput = {
  /** The session's directory: the linked worktree under a repo, a plain directory otherwise. */
  readonly directory: string;
  /** The branch the worktree is cut on; absent for a session with no repo. */
  readonly branch?: string | undefined;
  /** The registered checkout the worktree was cut from, when the repo has one. */
  readonly localPath?: string | undefined;
};

/**
 * Tear a session's worktree and branch down (LOB-268): the only place either is removed, and only
 * a terminal event calls it — never the idle sweep or a shutdown, which keep the work for the next
 * run.
 *
 * Idempotent and best-effort, step by step, so a repeat (or a retry after a crash halfway) finishes
 * what the first call left: each step tolerates what an earlier one already removed. The order is
 * the one git needs — a branch checked out in a linked worktree cannot be deleted, so the worktree
 * goes first, then its registration, then the branch.
 *
 * Every git call runs in the registered checkout, never in the session's directory: the worktree is
 * the agent's (D10), and its `.git` file, its hooks and its config are agent-writable, so the
 * control plane reads none of it (as `./git.ts` does for a push).
 */
export const removeWorkspace = (
  input: RemoveWorkspaceInput,
  deps: WorkspaceDeps,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const checkout = input.localPath;
    const git = (repo: string, ...args: ReadonlyArray<string>) =>
      Effect.try({
        try: () =>
          execFileSync(
            "git",
            [
              "-C",
              repo,
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.fsmonitor=false",
              ...args,
            ],
            { stdio: "ignore" },
          ),
        // oxlint-disable-next-line global-error-in-effect-catch
        catch: (cause) => new Error(String(cause)),
      }).pipe(Effect.ignore);
    if (checkout !== undefined) {
      yield* git(checkout, "worktree", "remove", "--force", input.directory);
    }
    // What `worktree remove` left — an untracked build directory, or a plain session directory.
    yield* deps.fs
      .remove(input.directory, { recursive: true, force: true })
      .pipe(Effect.ignore);
    if (checkout !== undefined) {
      // The registration `worktree remove` left when the directory was already gone, or when it
      // failed: removed by path, never by a bare `worktree prune`, which would clear every stale
      // registration in the operator's checkout and not only this session's.
      yield* git(checkout, "worktree", "remove", "--force", input.directory);
      if (input.branch !== undefined) {
        yield* git(checkout, "branch", "-D", input.branch);
      }
    }
  });
