import { Console, Effect, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RepoNotFound, RepoSlug } from "@repo/domain/Session";
import type { RegisterRepoInput, RepoSummary } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * `factory repo` — the repo registry over the session RPC group (LOB-253): bind the factory to a
 * checkout (`add`), read every row (`ls`), read one (`show`).
 *
 * A repo is runnable when it has a local checkout inside a git work tree, or a clone URL the factory
 * has cloned into its own cache (LOB-265): that is what a session's worktree is cut from
 * (`@repo/core`'s `workspace.ts`), and without one a session opens in an empty directory whose
 * changes nothing can measure. A row that is not runnable — most often the one `createSession` writes
 * the first time a session names a slug, with no clone URL and no checkout — says so in words and
 * prints the command that fixes it, so the operator does not have to know the schema to read the
 * registry.
 *
 * Every answer is the server's: the checkout facts (`localPathIsGit`, `workTree`, `hasFactoryConfig`)
 * are read by the API from its own disk, which is the disk the worktree is cut on. `work-tree` names
 * the repository sessions are cut from, which for a path inside a checkout is the enclosing one.
 */

/** What a cell says when the row has no value, matching `factory ls`'s rule of no empty cell. */
export const NONE = "none";

/** The command that gives a repo the checkout it lacks. */
export const repoRemedy = (repo: string): string =>
  `factory repo add ${repo} --path <dir>`;

/**
 * Whether a session on this repo can cut a worktree, in words: `ready`, or what is missing. The
 * auto-registered row (no URL, no checkout) is named as both, because both are what the operator
 * has to supply.
 */
export const repoState = (repo: RepoSummary): string => {
  if (repo.localPath === undefined) {
    if (repo.url === "") return "no clone URL / no local checkout";
    // A URL with no checkout is cloned by the factory: runnable once it has been.
    return repo.mirrorPath === undefined ? "not cloned yet" : "ready";
  }
  return repo.localPathIsGit
    ? "ready"
    : "local checkout is not a git work tree";
};

const isReady = (repo: RepoSummary): boolean => repoState(repo) === "ready";

/**
 * The command that makes this row runnable: clone it when it has a URL (LOB-265), register a
 * checkout otherwise.
 */
export const remedyFor = (repo: RepoSummary): string =>
  repo.localPath === undefined && repo.url !== ""
    ? `factory repo sync ${repo.repo}`
    : repoRemedy(repo.repo);

/** What the `config` facts say, as `add` and `show` print it. */
const configLine = (repo: RepoSummary): string =>
  repo.hasFactoryConfig ? ".factory/config found" : "no .factory/config";

/**
 * The checkout's agent-readiness score as a cell (LOB-29, S-env-setup): `3/4`, or `none` when the
 * server scored nothing because the repo has no checkout that is a git work tree.
 */
export const readinessCell = (repo: RepoSummary): string =>
  repo.readiness === undefined
    ? NONE
    : `${repo.readiness.score}/${repo.readiness.max}`;

/** What `add` and `show` say about readiness: the score, then every failed check's reason. */
const readinessLine = (repo: RepoSummary): string => {
  const missing =
    repo.readiness?.checks
      .filter((check) => !check.passed)
      .map((check) => check.reason) ?? [];
  return missing.length === 0
    ? readinessCell(repo)
    : `${readinessCell(repo)} (${missing.join("; ")})`;
};

/** `factory repo add` and `show`: one labelled line per field, then the remedy when there is one. */
export const repoLines = (repo: RepoSummary): readonly string[] => [
  `repo        ${repo.repo}`,
  `path        ${repo.localPath ?? NONE}`,
  // The factory's own clone of `url`, when it has one: what a URL-only repo's sessions are cut from.
  `cache       ${repo.mirrorPath ?? NONE}`,
  // The repository sessions are cut from: the path itself, or the work tree it sits inside.
  `work-tree   ${repo.workTree ?? NONE}`,
  `base-ref    ${repo.defaultBaseRef}`,
  `url         ${repo.url === "" ? NONE : repo.url}`,
  `config      ${configLine(repo)}`,
  `readiness   ${readinessLine(repo)}`,
  `registered  ${repo.registeredAt}`,
  `state       ${repoState(repo)}`,
  ...(isReady(repo) ? [] : [`remedy      ${remedyFor(repo)}`]),
];

/** What separates `factory repo ls`'s columns: a tab, so no path or URL with a space splits one. */
export const REPO_LS_SEPARATOR = "\t";

/** The header `factory repo ls` prints: one name per column, in row order. */
export const REPO_LS_HEADER = [
  "repo",
  "path",
  "base-ref",
  "registered-at",
  "config",
  "readiness",
  "url",
  "state",
].join(REPO_LS_SEPARATOR);

/**
 * One `factory repo ls` row, its columns tab-separated, so a script reads the path with `cut -f2`
 * (or `awk -F'\t' '{ print $2 }'`) whatever the path contains. A row that is not ready carries its
 * remedy after the state, in the last column.
 */
export const repoRow = (repo: RepoSummary): string =>
  [
    repo.repo,
    repo.localPath ?? NONE,
    repo.defaultBaseRef,
    repo.registeredAt,
    repo.hasFactoryConfig ? "yes" : "no",
    readinessCell(repo),
    repo.url === "" ? NONE : repo.url,
    isReady(repo) ? "ready" : `${repoState(repo)} (${remedyFor(repo)})`,
  ].join(REPO_LS_SEPARATOR);

/**
 * Decode the positional slug against the domain's own schema, so a malformed one is `invalid_input`
 * and no request is sent (the same rule as `factory board create --repo`).
 */
const decodeSlug = (raw: string): RepoSlug | undefined =>
  Option.getOrUndefined(Schema.decodeOption(RepoSlug)(raw));

const badSlug = (raw: string) =>
  reportFailure("invalid_input", `"${raw}" is not a repository (owner/name)`);

const repoArgument = Argument.String("repo").pipe(
  Argument.withDescription("The repository, as owner/name (lowercase)"),
);

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

/**
 * `factory repo add owner/name --path <dir> [--base-ref main] [--url …]` — register a repo, or
 * update one.
 *
 * The path is resolved against the directory the command runs in, so `--path .` names this
 * checkout, and the server refuses one that is not a git work tree with `invalid_input` naming it.
 * A field left out keeps the row's value: a second `add` with only `--base-ref` keeps the path. So
 * `--path` may be left out when the repo already has a checkout, or when a `--url` is given (or was
 * registered): the server then clones the URL into the factory's cache before it answers (LOB-265),
 * and a clone that fails is `repo_clone_failed`, naming the repo and the reason. A registration with
 * neither is one no session can cut a worktree from, and the command refuses it instead of writing it.
 */
const addCommand = Command.make(
  "add",
  {
    repo: repoArgument,
    path: Flag.String("path").pipe(
      Flag.withDescription(
        "The repository's local checkout (required unless the repo already has one or a --url)",
      ),
      Flag.optional,
    ),
    baseRef: Flag.String("base-ref").pipe(
      Flag.withDescription(
        "The ref sessions start from (keeps the registered one, else the repo's default branch)",
      ),
      Flag.optional,
    ),
    url: Flag.String("url").pipe(
      Flag.withDescription(
        "The repository's forge URL: cloned from into the factory's cache with no --path, else fetched from and pushed to (default: the checkout's origin, when it is https://github.com/<repo>)",
      ),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ repo, path, baseRef, url, api }) {
    const slug = decodeSlug(repo);
    if (slug === undefined) return yield* badSlug(repo);
    const apiUrl = yield* resolveApiUrl(api);
    const paths = yield* Path.Path;

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      if (Option.isNone(path) && Option.isNone(url)) {
        // An unknown slug has no checkout either: the same refusal, not `repo_not_found`.
        const existing = Option.getOrUndefined(
          yield* client.getRepo({ repo: slug }).pipe(
            Effect.asSome,
            Effect.catchIf(Schema.is(RepoNotFound), () => Effect.succeedNone),
          ),
        );
        if (existing?.localPath === undefined && (existing?.url ?? "") === "") {
          return yield* reportFailure(
            "invalid_input",
            `--path or --url is required: ${slug} has no local checkout or clone URL registered`,
          );
        }
      }
      const input: RegisterRepoInput = {
        repo: slug,
        ...(Option.isSome(path)
          ? { localPath: paths.resolve(path.value) }
          : {}),
        ...(Option.isSome(baseRef) ? { defaultBaseRef: baseRef.value } : {}),
        ...(Option.isSome(url) ? { url: url.value } : {}),
      };
      const registered = yield* client.registerRepo(input);
      for (const line of repoLines(registered)) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Register a repository, or update a registered one"),
  Command.withExamples([
    {
      command: "factory repo add lobiklukas/factory --path . --base-ref main",
      description: "Bind the factory to this checkout",
    },
    {
      command:
        "factory repo add lobiklukas/factory --url https://github.com/lobiklukas/factory.git",
      description: "Have the factory clone it into its own cache (no checkout)",
    },
    {
      command: "factory repo add lobiklukas/factory --base-ref trunk",
      description: "Change the base ref and keep the registered checkout",
    },
  ]),
);

/** `factory repo ls` — every registered repo, by slug. */
const lsCommand = Command.make(
  "ls",
  { api: apiFlag },
  Effect.fnUntraced(function* ({ api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const { repos } = yield* client.listRepos({});
      if (repos.length === 0) {
        yield* Console.log("no repos");
        return;
      }
      yield* Console.log(REPO_LS_HEADER);
      for (const repo of repos) yield* Console.log(repoRow(repo));
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(Command.withDescription("List the registered repositories"));

/** `factory repo show owner/name` — one row; an unknown slug is `repo_not_found`, non-zero. */
const showCommand = Command.make(
  "show",
  { repo: repoArgument, api: apiFlag },
  Effect.fnUntraced(function* ({ repo, api }) {
    const slug = decodeSlug(repo);
    if (slug === undefined) return yield* badSlug(repo);
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const found = yield* client.getRepo({ repo: slug });
      for (const line of repoLines(found)) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(Command.withDescription("Show one registered repository"));

/**
 * `factory repo sync owner/name` — clone the repo into the factory's cache now, or fetch its base ref
 * when it is there (LOB-265). A repo with a checkout or with no URL has nothing to clone and is
 * answered as it is; a clone that fails is `repo_clone_failed`, non-zero.
 */
const syncCommand = Command.make(
  "sync",
  { repo: repoArgument, api: apiFlag },
  Effect.fnUntraced(function* ({ repo, api }) {
    const slug = decodeSlug(repo);
    if (slug === undefined) return yield* badSlug(repo);
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const synced = yield* client.syncRepo({ repo: slug });
      for (const line of repoLines(synced)) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Clone a repository into the factory's cache, or fetch its base ref",
  ),
);

export const repoCommand = Command.make("repo").pipe(
  Command.withDescription(
    "Register, list and inspect the repositories sessions run on",
  ),
  Command.withSubcommands([addCommand, lsCommand, showCommand, syncCommand]),
);
