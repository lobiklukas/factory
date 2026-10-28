import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  BoardInstanceId,
  DefinitionId,
  DefinitionSource,
  InvalidDefinition,
  LIST_BOARDS_LIMIT,
  type BoardInstance,
  type ColumnConfig,
  type ColumnPushScope,
  type ColumnWriteScope,
  type DefinedBoard,
  type DefinitionConfig,
  type DefinitionSummary,
  type DefinitionVocabulary,
} from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * The board's configuration, read from a terminal (LOB-270): which boards and definitions exist, and
 * what one definition version — or the one a board pins — does, column by column. And the one write
 * (D4): `board define --file`, a new version of a definition from a JSON file, validated by the
 * server before anything is written.
 *
 * Every answer is the server's: the exits and human gates are the tables a move is refused by, a
 * requirement's `checked` is whether a move is refused over it today, and the model is the one this
 * deployment's role table resolves a run's role to. The lines are built by the pure functions below,
 * so the layout is a table in a test and the commands only fetch and print.
 */

/** What a field with nothing in it prints: one glyph, so "none" never reads as a value. */
const NONE = "—";

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

/** Decode an id against the domain's own schema; a malformed one is the CLI's `invalid_input`. */
const decodeId = <A>(
  schema: Schema.Codec<A, string>,
  raw: string,
): A | undefined => Option.getOrUndefined(Schema.decodeOption(schema)(raw));

/** One board of `factory board list`: its id, its repository and the definition version it pins. */
export const boardLine = (board: BoardInstance): string =>
  [
    board.id,
    board.repo,
    `${board.definitionId} v${board.definitionVersion}`,
    board.createdAt,
  ].join("  ");

/**
 * `factory board list`, whole: one line per board, or `no boards`. `listBoards` answers at most
 * `LIST_BOARDS_LIMIT` boards, so a full page ends with a line saying the list may be cut short —
 * a person never reads a capped list as every board.
 */
export const boardListLines = (
  boards: ReadonlyArray<BoardInstance>,
): ReadonlyArray<string> =>
  boards.length === 0
    ? ["no boards"]
    : [
        ...boards.map(boardLine),
        ...(boards.length >= LIST_BOARDS_LIMIT
          ? [
              `(showing the newest ${LIST_BOARDS_LIMIT} boards; older boards may exist)`,
            ]
          : []),
      ];

/**
 * `factory board definitions`: one line per definition version, oldest first within each id. A
 * version someone wrote names them last (`by <actor>`, F7); a seeded one ends at its time.
 */
export const definitionsLines = (
  definitions: ReadonlyArray<DefinitionSummary>,
): ReadonlyArray<string> =>
  definitions.flatMap((definition) =>
    definition.versions.map((version) =>
      [
        definition.id,
        `v${version.version}`,
        version.name,
        version.createdAt,
        ...(version.author === undefined ? [] : [`by ${version.author}`]),
      ].join("  "),
    ),
  );

/**
 * One column, as `definition show` and `config` print it: a header naming the column and its kind,
 * then one labelled field per line. A requirement says whether the board checks it (`checked`) or
 * only declares it (`unchecked`); an exit across a human gate names the gate, since only a person can
 * make that move.
 */
export const columnLines = (column: ColumnConfig): ReadonlyArray<string> => {
  const field = (label: string, value: string) =>
    `  ${label.padEnd(9)} ${value}`;
  const requires = column.requires.map(
    (requirement) =>
      `${requirement.key} (${requirement.checked ? "checked" : "unchecked"}): ${requirement.description}`,
  );
  const exits = column.exits.map((exit) =>
    exit.humanGate === undefined
      ? exit.to
      : `${exit.to} [human gate: ${exit.humanGate}]`,
  );
  return [
    `${column.name}  ${column.kind}`,
    field("role", column.role ?? NONE),
    field("model", `${column.model.model} (${column.model.source})`),
    field(
      "skills",
      column.skills.length === 0 ? NONE : column.skills.join(", "),
    ),
    ...(requires.length === 0
      ? [field("requires", NONE)]
      : requires.map((line, index) =>
          index === 0 ? field("requires", line) : field("", line),
        )),
    field("exits", exits.length === 0 ? NONE : exits.join(", ")),
    ...(column.wipLimit === undefined
      ? []
      : [
          field(
            "wip",
            `at most ${column.wipLimit} run${column.wipLimit === 1 ? "" : "s"} in flight`,
          ),
        ]),
    ...autonomyLines(column.autonomy, field),
  ];
};

/** How a write scope reads (C22): where a run in the column may write. */
const WRITE_SCOPE_LABELS: Readonly<Record<ColumnWriteScope, string>> = {
  worktree: "its worktree",
  docs: "documentation only",
  none: "nothing (read-only)",
};

/** How a push scope reads (C22): which ref a run in the column may push itself. */
const PUSH_SCOPE_LABELS: Readonly<Record<ColumnPushScope, string>> = {
  branch: "its own branch",
  none: "nothing",
};

/**
 * A column's effective autonomy (C22), three lines: the commands a run asks a person before running,
 * each marked as the deployment's or the column's, and where it may write and push. None for a
 * server that does not describe autonomy.
 */
const autonomyLines = (
  autonomy: ColumnConfig["autonomy"],
  field: (label: string, value: string) => string,
): ReadonlyArray<string> =>
  autonomy === undefined
    ? []
    : [
        field(
          "asks",
          autonomy.approvalRequired.length === 0
            ? NONE
            : autonomy.approvalRequired
                .map((gate) => `${gate.command} (${gate.source})`)
                .join(", "),
        ),
        field("writes", WRITE_SCOPE_LABELS[autonomy.write]),
        field("pushes", PUSH_SCOPE_LABELS[autonomy.push]),
      ];

/**
 * A definition version's run caps (B9, LOB-71), one line, or none for a version that declares none:
 * `caps        board 2 · task 1 · repo 2`, each kind it does not cap left out.
 */
const capsLines = (caps: DefinitionConfig["caps"]): ReadonlyArray<string> => {
  if (caps === undefined) return [];
  const declared = (["board", "task", "repo"] as const).flatMap((kind) =>
    caps[kind] === undefined ? [] : [`${kind} ${caps[kind]}`],
  );
  return declared.length === 0
    ? []
    : [`caps        ${declared.join(" · ")} runs in flight`];
};

/**
 * A definition version described: its id, version and name, who wrote it when someone did (F7), the
 * column a new card starts in
 * (LOB-267), its run caps when it declares any (LOB-71), then every column in order.
 */
export const definitionLines = (
  definition: DefinitionConfig,
): ReadonlyArray<string> => [
  `definition  ${definition.id} v${definition.version}  ${definition.name}`,
  ...(definition.author === undefined
    ? []
    : [`author      ${definition.author}`]),
  `initial     ${definition.initialColumn ?? NONE}`,
  ...capsLines(definition.caps),
  ...definition.columns.flatMap(columnLines),
];

/**
 * `factory board list` — the boards (LOB-75's `listBoards`, newest first, at most `LIST_BOARDS_LIMIT`),
 * with their repository and pinned definition version: how a person finds the `brd_…` id every other
 * board command takes. A capped answer says so on its last line.
 */
const listCommand = Command.make(
  "list",
  { api: apiFlag },
  Effect.fnUntraced(function* ({ api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const boards = yield* client.listBoards({});
      for (const line of boardListLines(boards)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    `List the boards, newest first (at most ${LIST_BOARDS_LIMIT}), with their repository and pinned definition version`,
  ),
);

/**
 * `factory board definitions` — every definition id and version the server holds: what
 * `factory board create --definition … --definition-version …` can name.
 */
const definitionsCommand = Command.make(
  "definitions",
  { api: apiFlag },
  Effect.fnUntraced(function* ({ api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const definitions = yield* client.listDefinitions({});
      if (definitions.length === 0) {
        yield* Console.log("no definitions");
        return;
      }
      for (const line of definitionsLines(definitions))
        yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(Command.withDescription("List every board definition and its versions"));

/**
 * A definition version as the file `board define` accepts (F8): `DefinitionSource` encoded, two-space
 * indented. Encoded rather than stringified, so a field the schema does not
 * name — a `version`, an `author` — can never reach the file, and `define` (which refuses unknown
 * keys) takes it back as it is.
 */
export const definitionFileText = (source: DefinitionSource): string =>
  JSON.stringify(Schema.encodeSync(DefinitionSource)(source), null, 2);

/**
 * What the definition vocabulary prints (F5): one line per requirement key a column may declare —
 * `checked` when a move out of the column is refused over it today, `unchecked` when it is only
 * declared, and `[human gate]` for a key that labels a person's gate — then one line per role.
 */
export const vocabularyLines = (
  vocabulary: DefinitionVocabulary,
): ReadonlyArray<string> => [
  ...vocabulary.requirements.map((requirement) =>
    [
      "requirement",
      requirement.key,
      requirement.checked ? "checked" : "unchecked",
      ...(requirement.humanGate ? ["[human gate]"] : []),
      requirement.description,
    ].join("  "),
  ),
  ...vocabulary.roles.map((role) => `role  ${role}`),
];

/**
 * `factory board definition show <id> [--version N] [--json]` — one definition version, column by
 * column. The version defaults to the newest, the one `board create` pins. `--json` prints the file
 * `board define` accepts instead (F8), moves and initial column spelled out. An unknown id or version
 * is the server's `definition_not_found`, printed verbatim, and a non-zero exit.
 */
const definitionShowCommand = Command.make(
  "show",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("The definition id (e.g. default)"),
    ),
    version: Flag.Int("version").pipe(
      Flag.withDescription("The version to show (defaults to the newest)"),
      Flag.optional,
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "Print the definition as a file `factory board define --file` accepts",
      ),
      Flag.withDefault(false),
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ id, version, json, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const definitionId = decodeId(DefinitionId, id);
      if (definitionId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `"${id}" is not a definition id`,
        );
      }
      const { client } = yield* BoardClient;
      const query = {
        definitionId,
        ...(Option.isSome(version) ? { version: version.value } : {}),
      };
      if (json) {
        const source = yield* client.getDefinitionSource(query);
        yield* Console.log(definitionFileText(source));
        return;
      }
      const definition = yield* client.getDefinition(query);
      for (const line of definitionLines(definition)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Show a definition version: each column's role, model, skills, requirements and exits",
  ),
  Command.withExamples([
    {
      command: "factory board definition show default --version 3",
      description: "The default pipeline at version 3",
    },
    {
      command: "factory board definition show default --json > def.json",
      description: "The newest version as a file `factory board define` takes",
    },
  ]),
);

/**
 * `factory board vocabulary` (F5) — what a definition file may name: the requirement keys, marked
 * checked or human gate, and the roles `defineBoard` accepts, as the server answers them. Skills are
 * `factory skill ls`'. Read-only.
 */
const vocabularyCommand = Command.make(
  "vocabulary",
  { api: apiFlag },
  Effect.fnUntraced(function* ({ api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const vocabulary = yield* client.getDefinitionVocabulary({});
      for (const line of vocabularyLines(vocabulary)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "List the requirement keys and roles a board definition file may name, for `factory board define`",
  ),
);

const definitionCommand = Command.make("definition").pipe(
  Command.withDescription("Read one board definition"),
  Command.withSubcommands([definitionShowCommand]),
);

/**
 * `factory board config --board …` — a board's full configuration: the board, its repository, and
 * the definition version it pins, described as `definition show` describes one.
 */
const configCommand = Command.make(
  "config",
  {
    board: Flag.String("board").pipe(
      Flag.withDescription("Board instance id (brd_…)"),
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ board, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const boardId = decodeId(BoardInstanceId, board);
      if (boardId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--board "${board}" is not a board id (brd_…)`,
        );
      }
      const { client } = yield* BoardClient;
      const config = yield* client.getBoardConfig({ boardId });
      yield* Console.log(`board       ${config.instance.id}`);
      yield* Console.log(`repo        ${config.instance.repo}`);
      for (const line of definitionLines(config.definition)) {
        yield* Console.log(line);
      }
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Show a board's configuration: its repo and pinned definition, column by column",
  ),
);

/**
 * The file `board define` reads (D4): `defineBoard`'s payload less `dryRun`, which is the flag's, and
 * the `actor`, which the credential's is (`DefinitionSource`). A
 * key the schema does not name is refused rather than dropped — a misspelt `wipLimit` or `gate`
 * would otherwise be a version that quietly lacks it.
 */
const DefinitionFile = Schema.fromJsonString(DefinitionSource);

/**
 * A definition file decoded, or why it cannot be: not JSON, or not a definition (a missing field, a
 * column kind that is not one, an unknown key). Pure, so what is refused before anything is sent is
 * a table in a test. The rules a version is held to beyond its shape are the server's.
 */
export const decodeDefinitionFile = (
  text: string,
): { readonly file: DefinitionSource } | { readonly refused: string } => {
  const decoded = Schema.decodeResult(DefinitionFile)(text, {
    onExcessProperty: "error",
    errors: "all",
  });
  return decoded._tag === "Success"
    ? { file: decoded.success }
    : {
        refused: `not a board definition: ${decoded.failure.message.replace(/\n\s+at /g, " at ").replaceAll("\n", "; ")}`,
      };
};

/**
 * What `board define` prints for an answer: what happened — the version written, the version that
 * already holds this content, or the version a dry run would write — then that version described as
 * `definition show` describes one.
 */
export const definedLines = (defined: DefinedBoard): ReadonlyArray<string> => {
  const { id, version } = defined.definition;
  const head =
    defined.outcome === "created"
      ? `defined     ${id} v${version}`
      : defined.outcome === "unchanged"
        ? `unchanged   ${id} v${version} already holds this definition; nothing written`
        : `valid       ${id} would be written as v${version}; nothing written (--dry-run)`;
  return [head, ...definitionLines(defined.definition)];
};

/**
 * A refused version, as stderr prints it: the refusal line every command prints, naming the first
 * field at fault, then every fault on its own line, so an author fixes the file in one pass.
 */
export const invalidDefinitionLines = (
  refusal: InvalidDefinition,
): ReadonlyArray<string> => [
  `error: invalid_definition: ${refusal.message}`,
  ...refusal.problems.map((fault) => `  ${fault.field}: ${fault.message}`),
];

/**
 * `factory board define --file def.json [--dry-run]` — a new version of the definition the file
 * names (D4): the server writes it as the id's newest version + 1, never over one that exists, and a
 * board created after it pins it. A file whose content the newest version already holds writes
 * nothing (`unchanged`). `--dry-run` validates against everything a write is checked against — the
 * skill library and the role table included — and writes nothing. An unreadable or malformed file is
 * `invalid_input` and nothing is sent; a version the server refuses is `invalid_definition`, every
 * fault listed by field.
 */
const defineCommand = Command.make(
  "define",
  {
    file: Flag.String("file").pipe(
      Flag.withDescription("The definition, as JSON (- for stdin)"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Validate the definition and write nothing"),
      Flag.withDefault(false),
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ file, dryRun, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const fs = yield* FileSystem.FileSystem;
    const read = yield* Effect.result(
      fs.readFileString(file === "-" ? "/dev/stdin" : file),
    );
    if (read._tag === "Failure") {
      return yield* reportFailure(
        "invalid_input",
        `--file "${file}" cannot be read: ${read.failure.message}`,
      );
    }
    const decoded = decodeDefinitionFile(read.success);
    if ("refused" in decoded) {
      return yield* reportFailure(
        "invalid_input",
        `--file "${file}": ${decoded.refused}`,
      );
    }
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const defined = yield* client.defineBoard({ ...decoded.file, dryRun });
      for (const line of definedLines(defined)) yield* Console.log(line);
    }).pipe(
      Effect.catchIf(Schema.is(InvalidDefinition), (refusal) =>
        Effect.gen(function* () {
          for (const line of invalidDefinitionLines(refusal))
            yield* Console.error(line);
          return yield* Effect.sync(() => process.exit(1));
        }),
      ),
    );
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Define a new version of a board definition from a JSON file; boards created after it pin it. `factory board vocabulary` lists the requirement keys and roles a file may name; `factory board definition show <id> --json` prints a file to start from",
  ),
  Command.withExamples([
    {
      command: "factory board define --file pipeline.json --dry-run",
      description: "Validate a definition and write nothing",
    },
    {
      command: "factory board define --file pipeline.json",
      description: "Write it as the definition's next version",
    },
  ]),
);

/** The configuration verbs, mounted under `factory board` beside the card verbs. */
export const boardConfigCommands = [
  listCommand,
  definitionsCommand,
  definitionCommand,
  vocabularyCommand,
  configCommand,
  defineCommand,
] as const;
