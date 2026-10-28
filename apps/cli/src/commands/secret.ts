import { Console, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { SecretName, type SecretSummary } from "@repo/domain/Secret";
import { RepoSlug } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory secret` — a repository's secrets from a terminal (S-agent-secrets): set one (`set`), list
 * them (`ls`), delete one (`rm`).
 *
 * A secret is write-only. `set` reads the value from stdin or a file — never from an argument, which
 * a shell's history and the process table would keep — and no command prints a value: the server
 * answers none. A run gets a secret only in the commands its repository's `.factory/config` declares
 * it for, at the run's base (`"secrets": {"verify": ["TEST_API_KEY"]}`).
 */

/** What a field with nothing in it prints, matching `factory repo`. */
export const NONE = "none";

/** What separates `factory secret ls`'s columns: a tab, so a script reads them with `cut -f`. */
export const SECRET_LS_SEPARATOR = "\t";

export const SECRET_LS_HEADER = [
  "repo",
  "name",
  "updated-at",
  "updated-by",
].join(SECRET_LS_SEPARATOR);

/** One `factory secret ls` row: never a value, which the summary does not carry. */
export const secretRow = (secret: SecretSummary): string =>
  [
    secret.repo,
    secret.name,
    secret.updatedAt,
    secret.updatedBy === "" ? NONE : secret.updatedBy,
  ].join(SECRET_LS_SEPARATOR);

export const secretLsLines = (
  secrets: ReadonlyArray<SecretSummary>,
): ReadonlyArray<string> =>
  secrets.length === 0
    ? ["no secrets"]
    : [SECRET_LS_HEADER, ...secrets.map(secretRow)];

/** What `set` prints: what was stored, and that the value is not shown. */
export const secretSetLines = (
  secret: SecretSummary,
): ReadonlyArray<string> => [
  `set          ${secret.repo} ${secret.name}`,
  `updated-at   ${secret.updatedAt}`,
  `updated-by   ${secret.updatedBy === "" ? NONE : secret.updatedBy}`,
  "value        not shown: a secret is never answered back",
  `note         a run gets it only in the commands its .factory/config declares it for ("secrets": {"setup"|"verify": ["${secret.name}"]})`,
];

/**
 * The value a file or stdin holds, less the one line ending an `echo` or an editor adds; a value
 * that is only that is empty, which the server refuses.
 */
export const secretValueOf = (text: string): string =>
  text.replace(/\r?\n$/, "");

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

const repoArgument = Argument.String("repo").pipe(
  Argument.withDescription("The registered repo (owner/name)"),
);
const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("The secret's name, as the variable it is read as"),
);

/** The repo and name as the domain spells them, or the refusal to print before anything is sent. */
const parseTarget = (
  repo: string,
  name: string,
):
  | { readonly repo: RepoSlug; readonly name: string }
  | { readonly refused: string } => {
  if (!Schema.is(RepoSlug)(repo)) {
    return { refused: `"${repo}" is not a repo slug (owner/name)` };
  }
  if (!Schema.is(SecretName)(name)) {
    return {
      refused: `"${name}" is not a secret name (uppercase letters, digits and _, not starting with a digit)`,
    };
  }
  return { repo, name };
};

/**
 * `factory secret set <repo> <name> [--file path]` — store a value read from stdin (or the file).
 * A value under eight characters is the server's `invalid_secret`, an unregistered repo
 * `repo_not_found`, a server with no key `secrets_unconfigured`: nothing is stored for any of them.
 */
const setCommand = Command.make(
  "set",
  {
    repo: repoArgument,
    name: nameArgument,
    file: Flag.String("file").pipe(
      Flag.withDescription("Read the value from this file (default: stdin)"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ repo, name, file, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const target = parseTarget(repo, name);
    if ("refused" in target) {
      return yield* reportFailure("invalid_input", target.refused);
    }
    const fs = yield* FileSystem.FileSystem;
    const source = Option.getOrElse(file, () => "-");
    const read = yield* Effect.result(
      fs.readFileString(source === "-" ? "/dev/stdin" : source),
    );
    if (read._tag === "Failure") {
      return yield* reportFailure(
        "invalid_input",
        `the value cannot be read from ${source === "-" ? "stdin" : `"${source}"`}: ${read.failure.message}`,
      );
    }
    const value = Redacted.make(secretValueOf(read.success));
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const set = yield* client.setSecret({ ...target, value });
      for (const line of secretSetLines(set)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Store a repo's secret, read from stdin or a file; it is never printed or answered back",
  ),
  Command.withExamples([
    {
      command:
        'printf %s "$KEY" | factory secret set acme/widgets TEST_API_KEY',
      description: "Store TEST_API_KEY for acme/widgets from stdin",
    },
    {
      command: "factory secret set acme/widgets NPM_TOKEN --file ~/.npm-token",
      description: "Store NPM_TOKEN from a file",
    },
  ]),
);

/** `factory secret ls [--repo …]` — every secret's name, or one repo's. Never a value. */
const lsCommand = Command.make(
  "ls",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Only this repo's secrets"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ repo, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    if (Option.isSome(repo) && !Schema.is(RepoSlug)(repo.value)) {
      return yield* reportFailure(
        "invalid_input",
        `"${repo.value}" is not a repo slug (owner/name)`,
      );
    }
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const secrets = yield* client.listSecrets(
        Option.isSome(repo) && Schema.is(RepoSlug)(repo.value)
          ? { repo: repo.value }
          : {},
      );
      for (const line of secretLsLines(secrets)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "List the secrets the factory stores: repo, name, and who set each when",
  ),
);

/** `factory secret rm <repo> <name>` — delete one; no later command gets it. */
const rmCommand = Command.make(
  "rm",
  { repo: repoArgument, name: nameArgument, api: apiFlag },
  Effect.fnUntraced(function* ({ repo, name, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const target = parseTarget(repo, name);
    if ("refused" in target) {
      return yield* reportFailure("invalid_input", target.refused);
    }
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const removed = yield* client.deleteSecret(target);
      yield* Console.log(`removed      ${removed.repo} ${removed.name}`);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(Command.withDescription("Delete a repo's secret"));

export const secretCommand = Command.make("secret").pipe(
  Command.withDescription(
    "Store a repo's secrets for the commands its config declares them for; values are write-only",
  ),
  Command.withSubcommands([setCommand, lsCommand, rmCommand]),
);
