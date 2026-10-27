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
 * A repo is runnable when it has a local checkout inside a git work tree: that is what a session's
 * worktree is cut from (`@repo/core`'s `workspace.ts`), and without one a session opens in an empty
 * directory whose changes nothing can measure. A row that is not runnable — most often the one
 * `createSession` writes the first time a session names a slug, with no clone URL and no checkout —
 * says so in words and prints the command that fixes it, so the operator does not have to know the
 * schema to read the registry.
 *
 * Every answer is the server's: the two checkout facts (`localPathIsGit`, `hasFactoryConfig`) are
 * read by the API from its own disk, which is the disk the worktree is cut on.
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
    return repo.url === ""
      ? "no clone URL / no local checkout"
      : "no local checkout";
  }
  return repo.localPathIsGit
    ? "ready"
    : "local checkout is not a git work tree";
};

const isReady = (repo: RepoSummary): boolean => repoState(repo) === "ready";

/** What the `config` facts say, as `add` and `show` print it. */
const configLine = (repo: RepoSummary): string =>
  repo.hasFactoryConfig ? ".factory/config found" : "no .factory/config";

/** `factory repo add` and `show`: one labelled line per field, then the remedy when there is one. */
export const repoLines = (repo: RepoSummary): readonly string[] => [
  `repo        ${repo.repo}`,
  `path        ${repo.localPath ?? NONE}`,
  `base-ref    ${repo.defaultBaseRef}`,
  `url         ${repo.url === "" ? NONE : repo.url}`,
  `config      ${configLine(repo)}`,
  `registered  ${repo.registeredAt}`,
  `state       ${repoState(repo)}`,
  ...(isReady(repo) ? [] : [`remedy      ${repoRemedy(repo.repo)}`]),
];

/** The header `factory repo ls` prints: one name per column, in row order. */
export const REPO_LS_HEADER =
  "repo  path  base-ref  registered-at  config  url  state";

/**
 * One `factory repo ls` row. The state is last because it is the only field with spaces, so a script
 * can split the line on whitespace and read the path as the second field; a row that is not ready
 * carries its remedy after the state.
 */
export const repoRow = (repo: RepoSummary): string =>
  [
    repo.repo,
    repo.localPath ?? NONE,
    repo.defaultBaseRef,
    repo.registeredAt,
    repo.hasFactoryConfig ? "yes" : "no",
    repo.url === "" ? NONE : repo.url,
    isReady(repo) ? "ready" : `${repoState(repo)} (${repoRemedy(repo.repo)})`,
  ].join("  ");

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
 * `--path` may be left out only when the repo already has a checkout — until LOB-265 clones a
 * URL-only repo into a factory cache, a registration with no checkout is one no session can cut a
 * worktree from, and the command refuses it instead of writing it.
 */
const addCommand = Command.make(
  "add",
  {
    repo: repoArgument,
    path: Flag.String("path").pipe(
      Flag.withDescription(
        "The repository's local checkout (required unless the repo already has one)",
      ),
      Flag.optional,
    ),
    baseRef: Flag.String("base-ref").pipe(
      Flag.withDescription(
        "The ref sessions start from (keeps the registered one, else main)",
      ),
      Flag.optional,
    ),
    url: Flag.String("url").pipe(
      Flag.withDescription("The URL the repository is cloned from"),
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
      if (Option.isNone(path)) {
        // An unknown slug has no checkout either: the same refusal, not `repo_not_found`.
        const existing = yield* client.getRepo({ repo: slug }).pipe(
          Effect.asSome,
          Effect.catchIf(Schema.is(RepoNotFound), () => Effect.succeedNone),
        );
        if (Option.getOrUndefined(existing)?.localPath === undefined) {
          return yield* reportFailure(
            "invalid_input",
            `--path is required: ${slug} has no local checkout registered`,
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

export const repoCommand = Command.make("repo").pipe(
  Command.withDescription(
    "Register, list and inspect the repositories sessions run on",
  ),
  Command.withSubcommands([addCommand, lsCommand, showCommand]),
);
