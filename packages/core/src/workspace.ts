/* oxlint-disable */
/**
 * What a session's working directory is, and what its repo says about itself
 * (docs/features.md §3 A1).
 *
 * Two things this module deliberately does not do: clone, and guess. Until M6 a session's
 * directory is an empty one under `SESSION_ROOT`, and the commands come from a `.factory/config`
 * that a checkout put there — the local registry path when the repo has one, the session's own
 * directory otherwise. A repo with no config resolves to no commands and says so
 * (`commandsSource: "none"`), rather than failing or inventing a build.
 *
 * The filesystem and path services arrive as values, the way the storage adapter takes its
 * `SqlClient`: that keeps `Effect`'s shape types free of the services this module merely uses.
 */
import { Effect, Option, Schema } from "effect";
// oxlint-disable-next-line node-builtin-import
import { execSync } from "node:child_process";
import type { FileSystem, Path } from "effect";
import type {
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
};

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
 * The session's directory, its repo binding, and the commands its repo declares. Never fails: a
 * session always has a workspace, even if the repo says nothing about itself.
 */
export const resolveWorkspace = (
  input: WorkspaceInput,
  deps: WorkspaceDeps,
): Effect.Effect<SessionWorkspace, Error> =>
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
    // M6: cut a linked worktree at the base ref off the registered repo's local_path.
    if (input.repo !== undefined && input.localPath !== undefined) {
      const isGit = yield* Effect.try({
        try: () =>
          execSync("git rev-parse --is-inside-work-tree", {
            cwd: input.localPath,
            stdio: "ignore",
          }),
        // oxlint-disable-next-line global-error-in-effect-catch
        catch: () =>
          new Error(
            `repo ${input.repo} local_path is not a git repository: ${input.localPath}`,
          ),
      });
      void isGit;
      const baseRef = input.baseRef ?? "main";
      const exists = yield* deps.fs
        .exists(directory)
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        yield* Effect.try({
          try: () => {
            const parent = deps.path.dirname(directory);
            execSync(`mkdir -p ${JSON.stringify(parent)}`);
            // Reuse an existing branch if a previous attempt left one (crash recovery),
            // otherwise create it at the base ref.
            let created = false;
            try {
              execSync(
                `git worktree add ${JSON.stringify(directory)} ${JSON.stringify(branch)}`,
                { cwd: input.localPath, stdio: "ignore" },
              );
              created = true;
            } catch {
              // branch may not exist yet
            }
            if (!created) {
              execSync(
                `git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(directory)} ${JSON.stringify(baseRef)}`,
                { cwd: input.localPath, stdio: "ignore" },
              );
            }
          },
          // oxlint-disable-next-line global-error-in-effect-catch
          catch: (e) =>
            new Error(
              `repo ${input.repo}: failed to create worktree at ${baseRef}: ${String(e)}`,
            ),
        });
      }
    }
    const fromSession = yield* commandsIn(directory, deps);
    const fromRepo =
      Option.isSome(fromSession) || input.localPath === undefined
        ? Option.none<RepoCommands>()
        : yield* commandsIn(input.localPath, deps);
    const found = Option.isSome(fromSession) ? fromSession : fromRepo;
    return {
      path: directory,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.repo === undefined || input.baseRef === undefined
        ? {}
        : { baseRef: input.baseRef }),
      ...(input.repo === undefined ? {} : { branch }),
      commands: Option.getOrElse(found, () => NO_COMMANDS),
      commandsSource: Option.isSome(found) ? "repo" : "none",
    };
  });
