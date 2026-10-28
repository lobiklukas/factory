import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  BoardInstanceId,
  DefineBoardInput,
  DefinitionId,
  InvalidDefinition,
  LIST_BOARDS_LIMIT,
  type BoardInstance,
  type ColumnConfig,
  type DefinedBoard,
  type DefinitionConfig,
  type DefinitionSummary,
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

/** `factory board definitions`: one line per definition version, oldest first within each id. */
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
  ];
};

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
 * A definition version described: its id, version and name, the column a new card starts in
 * (LOB-267), its run caps when it declares any (LOB-71), then every column in order.
 */
export const definitionLines = (
  definition: DefinitionConfig,
): ReadonlyArray<string> => [
  `definition  ${definition.id} v${definition.version}  ${definition.name}`,
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
 * `factory board definition show <id> [--version N]` — one definition version, column by column. The
 * version defaults to the newest, the one `board create` pins. An unknown id or version is the
 * server's `definition_not_found`, printed verbatim, and a non-zero exit.
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
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ id, version, api }) {
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
      const definition = yield* client.getDefinition({
        definitionId,
        ...(Option.isSome(version) ? { version: version.value } : {}),
      });
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
  ]),
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
 * The file `board define` reads (D4): `defineBoard`'s payload less `dryRun`, which is the flag's. A
 * key the schema does not name is refused rather than dropped — a misspelt `wipLimit` or `gate`
 * would otherwise be a version that quietly lacks it.
 */
const { dryRun: _dryRun, ...definitionFileFields } = DefineBoardInput.fields;
const DefinitionFile = Schema.fromJsonString(
  Schema.Struct(definitionFileFields),
);

/**
 * A definition file decoded, or why it cannot be: not JSON, or not a definition (a missing field, a
 * column kind that is not one, an unknown key). Pure, so what is refused before anything is sent is
 * a table in a test. The rules a version is held to beyond its shape are the server's.
 */
export const decodeDefinitionFile = (
  text: string,
):
  | { readonly file: Omit<DefineBoardInput, "dryRun"> }
  | { readonly refused: string } => {
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
    "Define a new version of a board definition from a JSON file; boards created after it pin it",
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
  configCommand,
  defineCommand,
] as const;
