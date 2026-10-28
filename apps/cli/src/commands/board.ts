import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import {
  RepoSlug,
  SessionActor,
  SessionBudgetCap,
  SessionError,
  SessionId,
} from "@repo/domain/Session";
import type { SessionSummary } from "@repo/domain/Session";
import {
  BlockReason,
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  MAX_TASK_BODY_CHARS,
  MAX_TASK_REF_CHARS,
  pinnedVersionsNotice,
  runPrompt,
  TaskId,
  TaskPriority,
} from "@repo/domain/Task";
import type {
  AttentionItem,
  RunPromptColumn,
  CreatedBoard,
  CreateTaskInput,
  Task,
  TaskComment,
  TaskExit,
  TaskRun,
  TaskSpec,
} from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { NO_PR } from "./ls";
import { BoardClient } from "../rpc";
import { formatDollars } from "../transcript";
import { boardConfigCommands } from "./boardConfig";
import { boardUpgradeCommands } from "./boardUpgrade";

/**
 * `factory board` — the board over the same RPC client the dashboard uses (D9).
 *
 * The verbs are the ones a person needs to work a card from a terminal: make the board a repository's
 * cards live on (`create`, LOB-208), read the lanes and what sits in them (`ls`), read one card, its
 * spec and its thread (`show`), move it (`move`), answer what a parked run asked (`comment`, LOB-73),
 * start the run that advances it (`start`), put a card on it (`add`, LOB-261), and, for triage (LOB-264), park or free a card (`block`,
 * `unblock`) and fix a card's title or priority (`update`, C11), list what needs a person (`attention`) and list a card's runs (`runs`). Nothing here
 * reads the database, and nothing but `runs` reads a session snapshot (see `runsLines`); every
 * answer is the server's, which is what keeps `factory board ls` and the RPC list in agreement.
 *
 * **Refusals are printed, not swallowed.** The board's refusals are typed values that name what
 * failed — `UndeclaredTransition` names both columns, `StaleRevision` names the revision it found,
 * `HumanGateRequired` names the gate, `RequirementUnmet` the column's exit requirement (LOB-80) — so
 * the command prints the service's own message verbatim
 * (docs/board.md B5: "a refusal names the failing requirement") and exits non-zero. A script that
 * cannot tell a refused move from a successful one is worse than no command.
 */

/**
 * Decode an id flag against the domain's own schema instead of casting it.
 *
 * A branded id is a promise that the server is never handed something that cannot be one:
 * `brd_…`/`tsk_…`, with the right length and alphabet. `as never` would make a typo a server-side
 * decode failure reported as a storage fault; decoding here answers `invalid_input` and sends
 * nothing.
 */
const decodeId = <A>(
  schema: Schema.Codec<A, string>,
  raw: string,
): A | undefined => Option.getOrUndefined(Schema.decodeOption(schema)(raw));

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

/**
 * Who the caller says makes a board write. A declaration: a control plane that authenticates the
 * call (`FACTORY_API_TOKEN`, LOB-20) records the token's actor whatever this says, so the flag only
 * counts against one running with auth off.
 */
const actorFlag = Flag.String("actor").pipe(
  Flag.withDescription(
    "Who makes the move; a session id is a run, anything else is a person. Ignored by a control plane that authenticates (FACTORY_API_TOKEN), which records the token's actor",
  ),
  Flag.withDefault("cli"),
);

/**
 * Who a run started from the terminal is attributed to (LOB-162): `cli`, as a move's actor is — and,
 * like it, overridden by the token's actor on a control plane that authenticates (LOB-20).
 */
const runActorFlag = Flag.String("actor").pipe(
  Flag.withDescription(
    "Who the run's spend is attributed to; ignored by a control plane that authenticates (FACTORY_API_TOKEN)",
  ),
  Flag.withSchema(SessionActor),
  Flag.withDefault("cli"),
);

/**
 * `factory board create` — a board over a repository (B2, LOB-208).
 *
 * The definition defaults to the shipped pipeline and its version to that definition's newest, which
 * is what the server pins when none is named; `--definition-version` is for a board that must run an
 * older pipeline (not `--version`, which is the CLI's own global flag). The repo and the definition
 * id are decoded here against the domain's own schemas, so a malformed one is `invalid_input` and
 * nothing is sent. An unknown definition, or a version of it that does not exist, is the server's
 * `definition_not_found`, printed verbatim; a repository that already has a board is the server's
 * `board_exists`, naming that board (one board per repository).
 */
const createCommand = Command.make(
  "create",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("The repository the board is for (owner/name)"),
    ),
    definition: Flag.String("definition").pipe(
      Flag.withDescription("The board definition the board binds"),
      Flag.withDefault(DEFAULT_DEFINITION_ID),
    ),
    definitionVersion: Flag.Int("definition-version").pipe(
      Flag.withDescription(
        "The definition version to pin (defaults to the newest)",
      ),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ repo, definition, definitionVersion, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const repoSlug = decodeId(RepoSlug, repo);
      if (repoSlug === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--repo "${repo}" is not a repository (owner/name)`,
        );
      }
      const definitionId = decodeId(DefinitionId, definition);
      if (definitionId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--definition "${definition}" is not a definition id`,
        );
      }
      const { client } = yield* BoardClient;
      const board = yield* client.createBoard({
        repo: repoSlug,
        definitionId,
        ...(Option.isSome(definitionVersion)
          ? { definitionVersion: definitionVersion.value }
          : {}),
      });
      for (const line of createdLines(board)) {
        yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Create a board for a repository"),
  Command.withExamples([
    {
      command: "factory board create --repo lobiklukas/factory",
      description: "The default pipeline at its newest version",
    },
    {
      command:
        "factory board create --repo lobiklukas/factory --definition-version 1",
      description: "The default pipeline pinned to version 1",
    },
  ]),
);

/**
 * The server's `warning` on a board or a run's workspace (LOB-263), printed under `label` — none
 * when there is nothing to say, so a board over a checked-out repo prints what it always did.
 */
export const warningLines = (
  warning: string | undefined,
  label: string,
): ReadonlyArray<string> =>
  warning === undefined ? [] : [`${label}${warning}`];

/**
 * What `factory board create` prints: the board, its repo and pinned definition, then the server's
 * warning when the repo has no local checkout (LOB-263) — with the `factory repo add … --path` that
 * fixes it — so the operator learns it here and not when a card's diff check fails.
 */
export const createdLines = (
  board: Pick<
    CreatedBoard,
    "id" | "repo" | "definitionId" | "definitionVersion" | "warning"
  >,
): ReadonlyArray<string> => [
  `board       ${board.id}`,
  `repo        ${board.repo}`,
  `definition  ${board.definitionId} v${board.definitionVersion}`,
  ...warningLines(board.warning, "warning     "),
];

/** A lane's cards, indented under the lane's own line so the lane stays readable at a glance. */
const laneCard = (task: Task): string =>
  ["", task.id, task.priority, task.title].join("  ");

/**
 * What `factory board ls` prints under the board's line: one line per column of the board's version
 * with that lane's cards under it, then — for a board upgraded without migrating its cards (D5) —
 * the cards in a column that version does not declare, each with the version it pins, so a card
 * left on a renamed or dropped column is listed rather than missing from every lane (as the
 * dashboard's strays are, `boardLanes`).
 */
export const laneLines = (
  columns: ReadonlyArray<{ readonly name: string; readonly kind: string }>,
  cards: ReadonlyArray<Task>,
): ReadonlyArray<string> => {
  const declared = new Set(columns.map((column) => column.name));
  const strays = cards.filter((card) => !declared.has(card.column));
  return [
    ...columns.flatMap((column) => {
      const lane = cards.filter((card) => card.column === column.name);
      return [
        [column.name, column.kind, String(lane.length)].join("  "),
        ...lane.map(laneCard),
      ];
    }),
    ...(strays.length === 0
      ? []
      : [
          `elsewhere  ${strays.length} in a column the board's version does not declare`,
          ...strays.map((card) =>
            [laneCard(card), card.column, `v${card.definitionVersion}`].join(
              "  ",
            ),
          ),
        ]),
  ];
};

/**
 * `factory board ls` — one line per column, in the order the pinned definition declares them, with
 * that lane's cards under it.
 *
 * The lane line is printed even when the lane is empty: an empty column and a column that does not
 * exist look the same in a list that skips them, and showing that the lane is there is half of
 * what reading the definition buys.
 */
const lsCommand = Command.make(
  "ls",
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
      const view = yield* client.getBoard({ boardId });
      const cards = yield* client.listTasks({ boardId });

      yield* Console.log(
        `${view.definition.name}  ${view.instance.repo}  v${view.definition.version}`,
      );
      for (const line of warningLines(view.warning, "warning  ")) {
        yield* Console.log(line);
      }
      // A board upgraded without migrating its cards (D5): its lanes are the new version's, and the
      // cards still on an older one move by that one's moves.
      const mixed = pinnedVersionsNotice(view.definition.version, cards);
      if (mixed !== null) yield* Console.log(`pinned   ${mixed}`);
      for (const line of laneLines(view.definition.columns, cards)) {
        yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("List a board's columns and the cards in each lane"),
  Command.withExamples([
    {
      command: "factory board ls --board brd_0123456789abcdefghjkmnpqrs",
      description: "Every lane in definition order",
    },
  ]),
);

/**
 * The slice of the RPC client `factory board add` needs, so what the command validates and prints is
 * a function of a client a test can fake — as `BlockClient` is for `block`.
 */
export interface AddClient<E> {
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<Task, E>;
}

/** What the flags of `factory board add` carry, before any of them is checked. */
export interface AddCardFlags {
  readonly boardId: BoardInstanceId;
  readonly title: string;
  readonly repo: RepoSlug | undefined;
  readonly priority: TaskPriority | undefined;
  readonly body: string | undefined;
  readonly baseRef: string | undefined;
  readonly actor: string;
}

const invalidInput = (message: string) =>
  new SessionError({ code: "invalid_input", message });

/**
 * The `createTask` input a card made at the terminal sends, or `invalid_input` and no request.
 *
 * The same input the dashboard's 'New card' form sends (LOB-275): the one `createTask` takes, with
 * each field present only when it was given, so the server's defaults (the board's repo, `normal`,
 * no body) are the same whichever door the card came through. The title is trimmed — a title is a
 * label, and one with stray shell whitespace is never the one meant — and a blank one is refused,
 * since a card with no name cannot be told from another on a lane. The body is sent as typed, its
 * lines and trailing newline untouched: the server owns what an empty body means. A body or a base
 * ref over the card's limit is refused here with the limit named, rather than as a payload that
 * fails to encode.
 */
export const addCardInput = (
  flags: AddCardFlags,
): Effect.Effect<CreateTaskInput, SessionError> =>
  Effect.gen(function* () {
    const title = flags.title.trim();
    if (title === "") {
      return yield* invalidInput("--title is empty: a card needs a title");
    }
    if (flags.body !== undefined && flags.body.length > MAX_TASK_BODY_CHARS) {
      return yield* invalidInput(
        `the body is ${flags.body.length} characters; a card takes at most ${MAX_TASK_BODY_CHARS} (a longer spec belongs in a file in the repository)`,
      );
    }
    if (
      flags.baseRef !== undefined &&
      flags.baseRef.length > MAX_TASK_REF_CHARS
    ) {
      return yield* invalidInput(
        `--base-ref takes at most ${MAX_TASK_REF_CHARS} characters`,
      );
    }
    return {
      boardId: flags.boardId,
      title,
      ...(flags.repo === undefined ? {} : { repo: flags.repo }),
      ...(flags.priority === undefined ? {} : { priority: flags.priority }),
      ...(flags.body === undefined ? {} : { body: flags.body }),
      ...(flags.baseRef === undefined ? {} : { baseRef: flags.baseRef }),
      actor: flags.actor,
    };
  });

/**
 * Put a card on a board (B3) and say what the board made of it: its id, its revision and the column
 * it opened in — the three things the next command (`board show`, `board move --expect-revision`)
 * needs. A refusal (`BoardNotFound`, `BoardRepoMismatch`, `InvalidTaskInput`) is the server's, and
 * stays typed for `reportFailures` to print verbatim.
 */
export const addCard = Effect.fnUntraced(function* <E>(
  client: AddClient<E>,
  flags: AddCardFlags,
) {
  const input = yield* addCardInput(flags);
  const card = yield* client.createTask(input);
  return [`task ${card.id} revision ${card.revision} column ${card.column}`];
});

/** What `factory board add` was typed with, before any flag is decoded. */
export interface AddRawFlags {
  readonly board: string;
  readonly title: string;
  readonly body: string | undefined;
  readonly bodyFile: string | undefined;
  readonly repo: string | undefined;
  readonly priority: TaskPriority | undefined;
  readonly baseRef: string | undefined;
  readonly actor: string;
}

/**
 * Decode the typed flags of `board add`, or `invalid_input` and no request: a board id or repo that
 * cannot be one, `--body` and `--body-file` both named (two ways to write the same field), and a
 * `--body-file` that cannot be read (`-` is stdin). `readFile` is the one effect, injected so a test
 * feeds it without a disk.
 */
export const addFlagsToCard = <R>(
  raw: AddRawFlags,
  readFile: (path: string) => Effect.Effect<string, SessionError, R>,
): Effect.Effect<AddCardFlags, SessionError, R> =>
  Effect.gen(function* () {
    const boardId = decodeId(BoardInstanceId, raw.board);
    if (boardId === undefined) {
      return yield* invalidInput(
        `--board "${raw.board}" is not a board id (brd_…)`,
      );
    }
    const repo =
      raw.repo === undefined ? undefined : decodeId(RepoSlug, raw.repo);
    if (raw.repo !== undefined && repo === undefined) {
      return yield* invalidInput(
        `--repo "${raw.repo}" is not a repository (owner/name)`,
      );
    }
    if (raw.body !== undefined && raw.bodyFile !== undefined) {
      return yield* invalidInput(
        "--body and --body-file are two ways to write the body: name one",
      );
    }
    const body =
      raw.bodyFile === undefined ? raw.body : yield* readFile(raw.bodyFile);
    return {
      boardId,
      title: raw.title,
      repo,
      priority: raw.priority,
      body,
      baseRef: raw.baseRef,
      actor: raw.actor,
    };
  });

/**
 * Read a body from a file, or from stdin for `-`: a spec is a document, and a shell argument is the
 * wrong place for one. Unreadable is `invalid_input` naming the path, and nothing is sent.
 */
const readBodyFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path === "-" ? "/dev/stdin" : path);
  }).pipe(
    Effect.mapError((cause) =>
      invalidInput(`--body-file "${path}" cannot be read: ${cause.message}`),
    ),
  );

/**
 * `factory board add` — a card on a board, from the terminal (B3, LOB-261).
 *
 * `--repo` defaults to the board's (LOB-255) and may only name it; the server answers
 * `board_repo_mismatch` for another. `--body` and `--body-file` are two ways to write the same field,
 * so naming both is `invalid_input`. The actor defaults to a person (`cli`), as `move`'s does. The
 * flags are decoded here, so a malformed id, repo or priority is `invalid_input` and nothing is sent;
 * an unknown board is the server's `board_not_found`, printed verbatim with a non-zero exit.
 */
const addCommand = Command.make(
  "add",
  {
    board: Flag.String("board").pipe(
      Flag.withDescription("Board instance id (brd_…)"),
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription("The card's title (one line)"),
    ),
    body: Flag.String("body").pipe(
      Flag.withDescription("What the card asks for, in markdown"),
      Flag.optional,
    ),
    bodyFile: Flag.String("body-file").pipe(
      Flag.withDescription("Read the body from a file (- for stdin)"),
      Flag.optional,
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("The card's repository (defaults to the board's)"),
      Flag.optional,
    ),
    priority: Flag.Literals("priority", TaskPriority.literals).pipe(
      Flag.withDescription(
        `The card's priority: ${TaskPriority.literals.join(", ")} (defaults to normal)`,
      ),
      Flag.optional,
    ),
    baseRef: Flag.String("base-ref").pipe(
      Flag.withDescription(
        "The ref its runs cut their worktree from (defaults to the repository's)",
      ),
      Flag.optional,
    ),
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({
    board,
    title,
    body,
    bodyFile,
    repo,
    priority,
    baseRef,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const decoded = yield* addFlagsToCard(
        {
          board,
          title,
          body: Option.getOrUndefined(body),
          bodyFile: Option.getOrUndefined(bodyFile),
          repo: Option.getOrUndefined(repo),
          priority: Option.getOrUndefined(priority),
          baseRef: Option.getOrUndefined(baseRef),
          actor,
        },
        readBodyFile,
      );
      const { client } = yield* BoardClient;
      const lines = yield* addCard(client, decoded);
      for (const line of lines) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Put a card on a board"),
  Command.withExamples([
    {
      command:
        'factory board add --board brd_… --title "Pin the Postgres major" --body "Compose names one major."',
      description: "A card in the board's initial column, on the board's repo",
    },
    {
      command:
        "factory board add --board brd_… --title Release --body-file spec.md --priority urgent --base-ref release",
      description: "A body from a file, urgent, cut from the release branch",
    },
  ]),
);

/**
 * One comment of a card's thread: a header naming what it is and who wrote it, then the body with
 * every line indented under it — the body's own lines, unwrapped, so what is printed is what was typed.
 */
export const threadLines = (comment: TaskComment): ReadonlyArray<string> => [
  `  [${comment.kind}] ${comment.actor} (revision ${comment.revision})`,
  ...comment.body.split("\n").map((line) => `    ${line}`),
];

/** One list of a spec: its name and count, then each item under it; `none` when it is empty. */
const specList = (
  name: string,
  items: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  items.length === 0
    ? [`  ${name}: none`]
    : [`  ${name}: ${items.length}`, ...items.map((item) => `    - ${item}`)];

/**
 * The card's spec (LOB-238): the run that declared it, the column and revision it was declared at,
 * then its goal and its three lists. An empty list prints `none` — a spec that declares no gaps says
 * so — and a card no run has specified prints `spec      -`, so "never specified" and "specified,
 * no gaps" read as two answers.
 */
export const specLines = (spec: TaskSpec | null): ReadonlyArray<string> =>
  spec === null
    ? ["spec      -"]
    : [
        `spec      ${spec.sessionId} from ${spec.column} (revision ${spec.revision})`,
        `  goal: ${spec.goal}`,
        ...specList("acceptance", spec.acceptance),
        ...specList("gaps", spec.gaps),
        ...specList("open questions", spec.openQuestions),
      ];

/**
 * What the card needs to leave its column (D9): a `leaves <column> when` header, then each of the
 * column's requirements — `met`, `unmet` with the reason the move would be refused with, or `not
 * checked` for a key nothing checks — in declaration order. A column that declares none says so.
 */
export const exitLines = (exit: TaskExit): ReadonlyArray<string> => [
  `leaves    ${exit.column} when${exit.requirements.length === 0 ? " (no requirements)" : ""}`,
  ...exit.requirements.flatMap((requirement) => [
    `  ${requirement.key}: ${requirement.status === "unchecked" ? "not checked" : requirement.status} (${requirement.description})`,
    ...(requirement.reason === undefined ? [] : [`    ${requirement.reason}`]),
  ]),
];

/**
 * What the card says and where its runs start (LOB-260): its base ref and external ref, `-` when it
 * has none, then its body — `body      -` for a card with none, or the line count and each line of
 * the markdown indented, exactly as it was filed, the way a thread comment's body is printed. Its
 * trailing newlines are neither counted nor printed: `"a\n"` is one line.
 */
export const bodyLines = (card: Task): ReadonlyArray<string> => {
  // Trailing newlines end the last line; they are not lines of their own to count or print.
  const lines =
    card.body === undefined
      ? undefined
      : card.body.replace(/\n+$/, "").split("\n");
  return [
    `base      ${card.baseRef ?? "-"}`,
    `external  ${card.externalRef ?? "-"}`,
    // The issue's own link, when the card carries one (LOB-254): only then, so a card with none
    // prints exactly what it did.
    ...(card.externalUrl === undefined
      ? []
      : [`link      ${card.externalUrl}`]),
    ...(lines === undefined
      ? ["body      -"]
      : [
          `body      ${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
          ...lines.map((line) => `    ${line}`),
        ]),
  ];
};

/**
 * `factory board show <task>` — one card, as the server has it, its spec (LOB-238), and its thread
 * (B7): the question a parked run asked and the answer a person gave are read here, on the task, not
 * in a transcript.
 */
const showCommand = Command.make(
  "show",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      const { client } = yield* BoardClient;
      const card = yield* client.getTask({ taskId });
      const thread = yield* client.listTaskComments({ taskId });
      const spec = yield* client.getTaskSpec({ taskId });
      const exit = yield* client.getTaskExit({ taskId });

      yield* Console.log(`id        ${card.id}`);
      yield* Console.log(`board     ${card.boardId}`);
      yield* Console.log(`column    ${card.column}`);
      yield* Console.log(`revision  ${card.revision}`);
      // The version whose moves and exits the card meets (B2): the board's, unless the board was
      // upgraded after the card was made and the card was not migrated with it (D5).
      yield* Console.log(`pinned    v${card.definitionVersion}`);
      yield* Console.log(`priority  ${card.priority}`);
      yield* Console.log(`repo      ${card.repo ?? "-"}`);
      yield* Console.log(
        `blocked   ${
          card.blocked === undefined
            ? "-"
            : `${card.blocked.reason} from ${card.blocked.column} since ${card.blocked.since}`
        }`,
      );
      // What the block says it waits on (a run parked `setup_failed` names the step and its
      // output's last lines, S-env-setup), indented under it. A question is the thread's to print.
      if (
        card.blocked?.note !== undefined &&
        card.blocked.reason !== "needs_input"
      ) {
        for (const line of card.blocked.note.split("\n"))
          yield* Console.log(`          ${line}`);
      }
      yield* Console.log(`title     ${card.title}`);
      for (const line of bodyLines(card)) yield* Console.log(line);
      for (const line of specLines(spec)) yield* Console.log(line);
      for (const line of exitLines(exit)) yield* Console.log(line);
      yield* Console.log(`thread    ${thread.length}`);
      for (const comment of thread) {
        for (const line of threadLines(comment)) yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(Command.withDescription("Show one card"));

/**
 * `factory board move` — a declared transition, at the revision the caller last read.
 *
 * `--expect-revision` is required and has no default: the optimistic-concurrency token is the whole
 * protection against two people clobbering each other (B3), and a default would silently pick one
 * of them. The actor defaults to a person (`cli`), because a run's actor is its session id and a
 * run cannot cross either human gate.
 */
const moveCommand = Command.make(
  "move",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    to: Flag.String("to").pipe(
      Flag.withDescription("The column to move the card to"),
    ),
    expectRevision: Flag.Int("expect-revision").pipe(
      Flag.withDescription("The revision this move expects"),
    ),
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, to, expectRevision, actor, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      const { client } = yield* BoardClient;
      const moved = yield* client.moveTask({
        taskId,
        expectedRevision: expectRevision,
        to,
        actor,
      });
      yield* Console.log(
        `moved ${moved.id} to ${moved.column} (revision ${moved.revision})`,
      );
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Move a card along a declared transition"),
  Command.withExamples([
    {
      command:
        "factory board move --task tsk_… --to specifying --expect-revision 1",
      description: "The intake → specifying step at revision 1",
    },
  ]),
);

/**
 * What `factory board start` needs of the client, as slices a test can fake: the card, the definition
 * version the card pinned (for the column's instruction), the session it opens and the message it sends.
 */
export interface StartClient<B, S> {
  readonly getTask: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<Task, B>;
  readonly getBoard: (input: {
    readonly boardId: BoardInstanceId;
  }) => Effect.Effect<
    {
      readonly instance: { readonly definitionId: DefinitionId };
      readonly definition: {
        readonly version: number;
        readonly columns: ReadonlyArray<RunPromptColumn>;
      };
    },
    B
  >;
  readonly getDefinition: (input: {
    readonly definitionId: DefinitionId;
    readonly version: number;
  }) => Effect.Effect<{ readonly columns: ReadonlyArray<RunPromptColumn> }, B>;
  readonly createSession: (input: {
    readonly title: string;
    readonly taskId: TaskId;
    readonly taskColumn: string;
    readonly actor: string;
    readonly repo?: RepoSlug;
    readonly budget?: number;
  }) => Effect.Effect<{ readonly id: SessionId }, S>;
  readonly getSession: (input: {
    readonly sessionId: SessionId;
  }) => Effect.Effect<
    { readonly workspace: { readonly warning?: string | undefined } },
    S
  >;
  readonly sendMessage: (input: {
    readonly sessionId: SessionId;
    readonly content: string;
  }) => Effect.Effect<unknown, S>;
}

/**
 * The column's instruction for a card's run (C6): the column of the definition version the card
 * pinned (B2) that the run starts in, as `runPrompt` reads it — or `undefined` when that version
 * cannot be read or does not name the column, so a definition that is not there costs the default
 * prompt its instruction line and never the run its start.
 */
const runColumn = <B, S>(
  client: Pick<StartClient<B, S>, "getBoard" | "getDefinition">,
  card: Task,
  column: string,
): Effect.Effect<RunPromptColumn | undefined> =>
  Effect.gen(function* () {
    const view = yield* client.getBoard({ boardId: card.boardId });
    const columns =
      view.definition.version === card.definitionVersion
        ? view.definition.columns
        : (yield* client.getDefinition({
            definitionId: view.instance.definitionId,
            version: card.definitionVersion,
          })).columns;
    return columns.find((candidate) => candidate.name === column);
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Open the run that advances a card, and send it its first message, printing what happened.
 *
 * A run is exactly one Pi Durable session (B1), so starting one is `createSession` with the card
 * named: the session carries the `factory.task` document, the run row is written against the card,
 * and the column the run started in is the column whose `requires[]` it must satisfy on exit. The
 * card is not moved here — the lane a run works in is where the card already sits.
 *
 * The first message is `prompt` when one was given, and otherwise `runPrompt`'s — the same text the
 * card pane's Start run pre-fills (C6), built from the card and the column the run starts in — so a
 * run started with no words is put to work, not left idle. `idle` opts out: the run opens and waits.
 *
 * Each line is handed to `emit` the moment it is known, not returned at the end: the session id is
 * what names an open run, so a first message the server refuses must not take it with it — the
 * operator is told which run is open and bound to the card before the refusal is reported.
 */
export const startCard = Effect.fnUntraced(function* <B, S>(
  client: StartClient<B, S>,
  input: {
    readonly taskId: TaskId;
    readonly column: string | undefined;
    readonly prompt: string | undefined;
    readonly idle: boolean;
    readonly actor: string;
    /** The run's spend ceiling in US dollars (C23); absent: the server's default cap, if any. */
    readonly budget?: number | undefined;
  },
  emit: (line: string) => Effect.Effect<void>,
) {
  const card = yield* client.getTask({ taskId: input.taskId });
  const taskColumn = input.column ?? card.column;
  const session = yield* client.createSession({
    title: card.title,
    taskId: card.id,
    taskColumn,
    actor: input.actor,
    ...(card.repo === undefined ? {} : { repo: card.repo }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
  });
  yield* emit(`session ${session.id}`);
  yield* emit(`task    ${card.id} in ${taskColumn}`);
  if (input.budget !== undefined) {
    yield* emit(`budget  ${formatDollars(input.budget)}`);
  }
  // The repo's checkout is the server's to read (LOB-263): the run's workspace says whether it
  // got a worktree, so a card on a repo with none is told so now, not when `non_empty_diff` fails.
  // Advisory: the run has started, so a failed read skips the warning and never fails the command.
  const opened = yield* client
    .getSession({ sessionId: session.id })
    .pipe(Effect.option);
  for (const line of warningLines(
    Option.isSome(opened) ? opened.value.workspace.warning : undefined,
    "warning ",
  )) {
    yield* emit(line);
  }
  if (input.idle) {
    return;
  }
  const content =
    input.prompt ?? runPrompt(card, yield* runColumn(client, card, taskColumn));
  // Sent, not followed: the run is headless (B7), so the command returns as soon as the turn is
  // accepted, and the card — not this terminal — is where the run's outcome is read.
  yield* client.sendMessage({ sessionId: session.id, content });
  // The words typed are echoed as typed; the default's are a card's whole body, so only its title.
  yield* emit(
    input.prompt === undefined
      ? `sent    ${card.title} (the card's default prompt)`
      : `sent    ${input.prompt}`,
  );
});

const startCommand = Command.make(
  "start",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    column: Flag.String("column").pipe(
      Flag.withDescription(
        "The column the run starts from (defaults to the card's)",
      ),
      Flag.optional,
    ),
    prompt: Flag.String("prompt").pipe(
      Flag.withDescription(
        "The first message the run is sent; without it the run is sent the card's default prompt: its title, its body and the column's instruction",
      ),
      Flag.optional,
    ),
    idle: Flag.Boolean("idle").pipe(
      Flag.withDescription(
        "Open the run and send it nothing: it waits for a message from the dashboard or `factory send`",
      ),
      Flag.withDefault(false),
    ),
    budget: Flag.Finite("budget").pipe(
      Flag.withDescription(
        "Spend ceiling for the run, in US dollars: it stops before a model request once the session's spend reaches it (raise it with `factory budget`)",
      ),
      Flag.withSchema(SessionBudgetCap),
      Flag.optional,
    ),
    actor: runActorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({
    task,
    column,
    prompt,
    idle,
    budget,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      if (idle && Option.isSome(prompt)) {
        return yield* reportFailure(
          "invalid_input",
          "--idle sends nothing, so it cannot be given a --prompt",
        );
      }
      const { client } = yield* BoardClient;
      yield* startCard(
        client,
        {
          taskId,
          column: Option.getOrUndefined(column),
          prompt: Option.getOrUndefined(prompt),
          idle,
          budget: Option.getOrUndefined(budget),
          actor,
        },
        Console.log,
      );
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Start a run against a card"),
  Command.withExamples([
    {
      command: "factory board start --task tsk_…",
      description:
        "A session bound to the card, in the card's own column, sent the card's default prompt",
    },
    {
      command: "factory board start --task tsk_… --budget 2.50",
      description: "The same run, capped at $2.50 of spend",
    },
    {
      command: "factory board start --task tsk_… --idle",
      description: "The same session, opened and left waiting",
    },
  ]),
);

/**
 * `--start` on a card that is not waiting for an answer: there is no answer to start a run for, so
 * nothing is written. Reported as `error: start_needs_answer`.
 */
export class StartNeedsAnswer extends Schema.TaggedError<StartNeedsAnswer>()(
  "StartNeedsAnswer",
  { taskId: Schema.String, message: Schema.String },
) {}

/**
 * `--start` on a comment that landed but answered nothing: the card is still blocked, so no run is
 * waiting on it and none was opened. Reported as `error: start_not_started` with a non-zero exit, so
 * a script that asked for a run can tell that it got none; the comment itself is already written.
 */
export class StartNotStarted extends Schema.TaggedError<StartNotStarted>()(
  "StartNotStarted",
  { taskId: Schema.String, message: Schema.String },
) {}

/** What `factory board comment` needs of the client: the card, and the write of a comment to it. */
export interface CommentClient<E> {
  readonly getTask: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<Task, E>;
  readonly commentTask: (input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly body: string;
    readonly actor: string;
  }) => Effect.Effect<Task, E>;
}

/**
 * Add a comment to a card and say what it did; when it answered a question and `start` names the run's
 * actor (C24), open the next run on the card.
 *
 * The run is `startCard` with nothing but the card: its column, the default prompt (C6). The answer is
 * not pasted into that prompt — every run on the card is told the whole thread, the answer included
 * (B7, the `task_thread` prompt section) — so what is started is the run that reads it. `--start` on a
 * card that is not blocked `needs_input` is refused before the comment is written: a comment that is
 * only a note has no run waiting on it, and starting one anyway would be the surprise. If the
 * comment lands and the card is nevertheless still blocked, no run is started and the command fails
 * (`StartNotStarted`, exit 1) after saying so. A run's actor is refused up front like a card that is not blocked.
 */
export const commentCard = Effect.fnUntraced(function* <B, S>(
  client: CommentClient<B> & StartClient<B, S>,
  input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly body: string;
    readonly actor: string;
    /** The actor the next run is attributed to; `undefined` for a comment that starts nothing. */
    readonly start: string | undefined;
  },
  emit: (line: string) => Effect.Effect<void>,
) {
  const before = yield* client.getTask({ taskId: input.taskId });
  if (input.start !== undefined && before.blocked?.reason !== "needs_input") {
    return yield* new StartNeedsAnswer({
      taskId: input.taskId,
      message: `--start follows an answer, and ${before.id} is not blocked needs_input (${
        before.blocked === undefined
          ? "it is not blocked"
          : `it is blocked ${before.blocked.reason}`
      }): nothing was commented`,
    });
  }
  // Only a person answers: a run's comment on its own parked card is a note and leaves the block.
  if (input.start !== undefined && Schema.is(SessionId)(input.actor)) {
    return yield* new StartNeedsAnswer({
      taskId: input.taskId,
      message: `--start follows an answer, and --actor ${input.actor} is a run: a run's comment is a note and does not lift the block: nothing was commented`,
    });
  }
  const after = yield* client.commentTask({
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    body: input.body,
    actor: input.actor,
  });
  yield* emit(`commented on ${after.id} (revision ${after.revision})`);
  const lifted = after.blocked === undefined ? before.blocked : undefined;
  if (lifted !== undefined) {
    yield* emit(
      `answered: ${after.id} is no longer blocked (${lifted.reason} from ${lifted.column})`,
    );
  }
  if (input.start === undefined) return;
  if (lifted === undefined) {
    const message = `${after.id} is still blocked, so no run is waiting on this comment`;
    yield* emit(`not started: ${message}`);
    return yield* new StartNotStarted({ taskId: input.taskId, message });
  }
  yield* startCard(
    client,
    {
      taskId: input.taskId,
      column: undefined,
      prompt: undefined,
      idle: false,
      actor: input.start,
    },
    emit,
  );
});

/**
 * `factory board comment` — add to a card's thread (B7, LOB-73).
 *
 * From a person on a card blocked `needs_input`, the comment is the answer: it lifts the block in the
 * same transaction, and the next run started on the card reads it in its prompt. Anywhere else it is
 * a note. `--expect-revision` is required for the reason it is on `move`: an answer typed against a
 * card someone else already answered must be refused, not silently appended.
 *
 * `--start` is the next step of an answer (C24): it opens that run, as `board start` with no flags
 * does, so an answered card is not left with an answer and no run to read it.
 */
const commentCommand = Command.make(
  "comment",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    body: Flag.String("body").pipe(
      Flag.withDescription("The comment, verbatim — the answer to a question"),
    ),
    expectRevision: Flag.Int("expect-revision").pipe(
      Flag.withDescription("The revision this comment expects"),
    ),
    start: Flag.Boolean("start").pipe(
      Flag.withDescription(
        "After an answer lifts the block, start the next run on the card (its default prompt; the run reads the answer in the card's thread). Refused, before anything is written, on a card that is not blocked needs_input",
      ),
      Flag.withDefault(false),
    ),
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({
    task,
    body,
    expectRevision,
    start,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      const runActor = start
        ? Option.getOrUndefined(Schema.decodeOption(SessionActor)(actor))
        : undefined;
      if (start && runActor === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--actor "${actor}" cannot own a run: --start attributes the run to the one who answered`,
        );
      }
      const { client } = yield* BoardClient;
      yield* commentCard(
        client,
        {
          taskId,
          expectedRevision: expectRevision,
          body,
          actor,
          start: runActor,
        },
        Console.log,
      );
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Comment on a card; on a card blocked needs_input, the answer",
  ),
  Command.withExamples([
    {
      command:
        'factory board comment --task tsk_… --expect-revision 3 --body "Target Postgres 16."',
      description: "Answer the question a parked run asked",
    },
    {
      command:
        'factory board comment --task tsk_… --expect-revision 3 --body "Target Postgres 16." --start',
      description: "Answer it and start the next run, which reads the answer",
    },
  ]),
);

/**
 * `factory board block` / `unblock` talk to the board through these two slices of the client, so the
 * logic that is not a flag — which revision a write expects, what is printed — is a function of a
 * client a test can fake, not a command only a terminal can run.
 */
export interface BlockClient<E> {
  readonly getTask: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<Task, E>;
  readonly blockTask: (input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly reason: BlockReason;
    readonly note?: string;
    readonly actor: string;
  }) => Effect.Effect<Task, E>;
  readonly unblockTask: (input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly actor: string;
  }) => Effect.Effect<Task, E>;
}

/**
 * The revision a block or unblock expects: the one named, or — when none was — the card's own as the
 * server has it right now.
 *
 * `move` has no such default because a move is a decision about where a card goes, taken from a read
 * the person made. Parking a card and lifting that park are corrections of the card's state, and the
 * issue's own examples type neither with a revision; the default is the read the command makes anyway.
 * A revision that is named is sent as named, so the server's `StaleRevision` is the answer to a
 * person who read an older card.
 */
const expectedRevision = <E>(
  client: Pick<BlockClient<E>, "getTask">,
  taskId: TaskId,
  named: number | undefined,
): Effect.Effect<number, E> =>
  named !== undefined
    ? Effect.succeed(named)
    : Effect.map(client.getTask({ taskId }), (card) => card.revision);

/** Park a card (B4) and say what it is blocked for and from which column. */
export const blockCard = Effect.fnUntraced(function* <E>(
  client: BlockClient<E>,
  input: {
    readonly taskId: TaskId;
    readonly reason: BlockReason;
    readonly note: string | undefined;
    readonly actor: string;
    readonly expectedRevision: number | undefined;
  },
) {
  const revision = yield* expectedRevision(
    client,
    input.taskId,
    input.expectedRevision,
  );
  const after = yield* client.blockTask({
    taskId: input.taskId,
    expectedRevision: revision,
    reason: input.reason,
    ...(input.note === undefined ? {} : { note: input.note }),
    actor: input.actor,
  });
  return [
    `blocked ${after.id} (revision ${after.revision}): ${input.reason} in ${after.column}`,
    ...(input.note === undefined ? [] : [`note    ${input.note}`]),
  ];
});

/** Lift a card's block: it is back in the column it blocked from, and says what the block was. */
export const unblockCard = Effect.fnUntraced(function* <E>(
  client: BlockClient<E>,
  input: {
    readonly taskId: TaskId;
    readonly actor: string;
    readonly expectedRevision: number | undefined;
  },
) {
  const before = yield* client.getTask({ taskId: input.taskId });
  const after = yield* client.unblockTask({
    taskId: input.taskId,
    expectedRevision: input.expectedRevision ?? before.revision,
    actor: input.actor,
  });
  return [
    `unblocked ${after.id} (revision ${after.revision}): back in ${after.column}` +
      (before.blocked === undefined
        ? ""
        : ` (was ${before.blocked.reason} since ${before.blocked.since})`),
  ];
});

const reasonFlag = Flag.Literals("reason", BlockReason.literals).pipe(
  Flag.withDescription(
    `Why the card is blocked: ${BlockReason.literals.join(", ")}`,
  ),
);

const optionalRevisionFlag = (what: string) =>
  Flag.Int("expect-revision").pipe(
    Flag.withDescription(
      `The revision this ${what} expects (defaults to the card's current one)`,
    ),
    Flag.optional,
  );

/**
 * `factory board block` — park a card for a reason (B4).
 *
 * The actor defaults to a person (`cli`), as `move`'s does. A card that is already blocked is the
 * server's `already_blocked`, a stale `--expect-revision` its `stale_revision`; both are printed
 * verbatim with a non-zero exit, like every refusal of the board.
 */
const blockCommand = Command.make(
  "block",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    reason: reasonFlag,
    note: Flag.String("note").pipe(
      Flag.withDescription("What the card is waiting on"),
      Flag.optional,
    ),
    expectRevision: optionalRevisionFlag("block"),
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({
    task,
    reason,
    note,
    expectRevision,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      const { client } = yield* BoardClient;
      const lines = yield* blockCard(client, {
        taskId,
        reason,
        note: Option.getOrUndefined(note),
        actor,
        expectedRevision: Option.getOrUndefined(expectRevision),
      });
      for (const line of lines) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Block a card for a reason"),
  Command.withExamples([
    {
      command:
        'factory board block --task tsk_… --reason dependency --note "waiting on the schema PR"',
      description: "Park the card at its current revision",
    },
  ]),
);

/** `factory board unblock` — lift a card's block; the card is back in the column it blocked from. */
const unblockCommand = Command.make(
  "unblock",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    expectRevision: optionalRevisionFlag("unblock"),
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, expectRevision, actor, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      const { client } = yield* BoardClient;
      const lines = yield* unblockCard(client, {
        taskId,
        actor,
        expectedRevision: Option.getOrUndefined(expectRevision),
      });
      for (const line of lines) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Lift a card's block"),
  Command.withExamples([
    {
      command: "factory board unblock --task tsk_…",
      description: "The card is back where it blocked from",
    },
  ]),
);

/**
 * `factory board update` talks to the board through this slice of the client, as `block` does: which
 * revision the write expects and what is printed are a function of a client a test can fake.
 */
export interface UpdateClient<E> {
  readonly getTask: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<Task, E>;
  readonly updateTask: (input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly title?: string;
    readonly priority?: TaskPriority;
    readonly actor: string;
  }) => Effect.Effect<Task, E>;
}

/**
 * Fix a card's title and/or priority (C11). The revision is the one named or the card's own right
 * now (as `block`'s), and the answer says what the card now reads, or that nothing changed when the
 * values were already the card's.
 */
export const updateCard = Effect.fnUntraced(function* <E>(
  client: UpdateClient<E>,
  input: {
    readonly taskId: TaskId;
    readonly title: string | undefined;
    readonly priority: TaskPriority | undefined;
    readonly actor: string;
    readonly expectedRevision: number | undefined;
  },
) {
  const before = yield* client.getTask({ taskId: input.taskId });
  const sent = input.expectedRevision ?? before.revision;
  const after = yield* client.updateTask({
    taskId: input.taskId,
    expectedRevision: sent,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    actor: input.actor,
  });
  return [
    after.revision === sent
      ? `unchanged ${after.id} (revision ${after.revision})`
      : `updated ${after.id} (revision ${after.revision})`,
    `title     ${after.title}`,
    `priority  ${after.priority}`,
  ];
});

/**
 * `factory board update` — fix a card's title and/or priority (C11). A blank title is the server's
 * `invalid_task_input`, a stale `--expect-revision` its `stale_revision`; both are printed verbatim
 * with a non-zero exit, like every refusal of the board.
 */
const updateCommand = Command.make(
  "update",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    title: Flag.String("title").pipe(
      Flag.withDescription("The card's new title"),
      Flag.optional,
    ),
    priority: Flag.Literals("priority", TaskPriority.literals).pipe(
      Flag.withDescription(
        `The card's new priority: ${TaskPriority.literals.join(", ")}`,
      ),
      Flag.optional,
    ),
    expectRevision: optionalRevisionFlag("update"),
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({
    task,
    title,
    priority,
    expectRevision,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      if (Option.isNone(title) && Option.isNone(priority)) {
        return yield* reportFailure(
          "invalid_input",
          "name what to change: --title, --priority or both",
        );
      }
      const { client } = yield* BoardClient;
      const lines = yield* updateCard(client, {
        taskId,
        title: Option.getOrUndefined(title),
        priority: Option.getOrUndefined(priority),
        actor,
        expectedRevision: Option.getOrUndefined(expectRevision),
      });
      for (const line of lines) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Fix a card's title or priority"),
  Command.withExamples([
    {
      command: "factory board update --task tsk_… --priority urgent",
      description: "Flag the card urgent: it reads first in its lane",
    },
    {
      command: 'factory board update --task tsk_… --title "Ship the release"',
      description: "Retitle the card",
    },
  ]),
);

/** One value on one line: a question or a note may span several, and a row must not. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * One row of the attention view (LOB-77), in the order `listAttention` answered: the reason, then
 * the card id, its repository, its column and its title, with the reason's own facts on an indented
 * line under it — the session that holds the approval and what it asks, the question, or the gate
 * the card waits at. The card id is the second field of every row, so a script can feed it to
 * `board show` or `board comment` whatever the reason.
 */
export const attentionLines = (item: AttentionItem): ReadonlyArray<string> => {
  const { task, reason } = item;
  // A card-less approval (LOB-271) belongs to a session no card owns: there is no card id, column
  // or revision, so those fields read `-` and the session's title stands where the card's would.
  const head = [
    reason._tag,
    task?.id ?? "-",
    item.repo ?? "-",
    task?.column ?? "-",
    task === undefined ? "-" : `r${task.revision}`,
    oneLine(task?.title ?? item.sessionTitle ?? ""),
  ].join("  ");
  switch (reason._tag) {
    case "approval":
      return [
        head,
        `  ${reason.sessionId} asks ${reason.action} (request ${reason.requestId}, since ${reason.requestedAt})` +
          (reason.detail === "" ? "" : `: ${oneLine(reason.detail)}`),
      ];
    case "question":
      return [
        head,
        `  blocked needs_input since ${reason.since}` +
          (reason.question === undefined
            ? ""
            : `: ${oneLine(reason.question)}`),
      ];
    case "gate":
      return [
        head,
        `  ${reason.gate}: ${reason.sessionId} is idle; ${task?.column ?? "-"} → ${reason.to} is a person's`,
      ];
  }
};

/** What `factory board attention` prints for nothing: an empty answer must not be a blank screen. */
export const NOTHING_NEEDS_A_PERSON = "nothing needs a person";

/**
 * `factory board attention` — what needs a person (LOB-77), on one board or on every board.
 *
 * Printed in the order the server answered — approvals, then questions, then gates — because the
 * order is the service's priority and the terminal must not re-rank it.
 */
const attentionCommand = Command.make(
  "attention",
  {
    board: Flag.String("board").pipe(
      Flag.withDescription("Only this board (brd_…); default every board"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ board, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const boardId = Option.isSome(board)
        ? decodeId(BoardInstanceId, board.value)
        : undefined;
      if (Option.isSome(board) && boardId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--board "${board.value}" is not a board id (brd_…)`,
        );
      }
      const { client } = yield* BoardClient;
      const items = yield* client.listAttention(
        boardId === undefined ? {} : { boardId },
      );
      if (items.length === 0) {
        yield* Console.log(NOTHING_NEEDS_A_PERSON);
        return;
      }
      for (const item of items) {
        for (const line of attentionLines(item)) yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "List what needs a person: approvals, questions and gates",
  ),
  Command.withExamples([
    {
      command: "factory board attention",
      description: "Every card that waits on a person, on every board",
    },
  ]),
);

/** The header `factory board runs` prints above its rows: one name per column, in row order. */
export const RUNS_HEADER = "session  column  status  pr  started";

/** What a run's `status` column says when its session is gone: not `idle`, which is a claim. */
export const MISSING_SESSION = "missing";

/** One run's row: its session, the column it started from, that session's status and its PR link. */
export const runRow = (
  run: TaskRun,
  session: Option.Option<Pick<SessionSummary, "status" | "prUrl">>,
): string =>
  [
    run.sessionId,
    run.column,
    Option.match(session, {
      onNone: () => MISSING_SESSION,
      onSome: (found) => found.status,
    }),
    Option.flatMapNullishOr(session, (found) => found.prUrl).pipe(
      Option.getOrElse(() => NO_PR),
    ),
    run.startedAt,
  ].join("  ");

/**
 * The slice of the client `board runs` reads: the card's runs, and each run's session for the two
 * columns a run row does not carry (the index has the session's id, not its status or its PR).
 */
export interface RunsClient<EList, ESession> {
  readonly listTaskRuns: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<ReadonlyArray<TaskRun>, EList>;
  readonly getSession: (input: {
    readonly sessionId: SessionId;
  }) => Effect.Effect<
    { readonly session: Pick<SessionSummary, "status" | "prUrl"> },
    ESession
  >;
}

/**
 * A card's runs, newest first as the server answered, each with its session's status and PR.
 *
 * It reads one full session snapshot per run (`getSession`), only for `status` and `prUrl`: the run
 * index does not carry them yet, so the cost is one historical read per run and a live run's
 * last-used time is touched (LOB-264 Follow-up: carry both on `listTaskRuns`).
 *
 * Only a session the server says does not exist reads as `missing`; any other failure — the server
 * stopped answering, say — fails the command, because a status invented for a read that failed is
 * the wrong answer to "is the run still going".
 */
export const runsLines = Effect.fnUntraced(function* <EList, ESession>(
  client: RunsClient<EList, ESession>,
  taskId: TaskId,
) {
  const runs = yield* client.listTaskRuns({ taskId });
  if (runs.length === 0) return ["no runs"];
  const sessions = yield* Effect.forEach(
    runs,
    (run) =>
      client.getSession({ sessionId: run.sessionId }).pipe(
        Effect.map((snapshot) => Option.some(snapshot.session)),
        Effect.catchIf(
          (error) =>
            Schema.is(SessionError)(error) && error.code === "not_found",
          () => Effect.succeed(Option.none()),
        ),
      ),
    { concurrency: 4 },
  );
  return [
    RUNS_HEADER,
    ...runs.map((run, i) => runRow(run, sessions[i] ?? Option.none())),
  ];
});

/** `factory board runs` — every run of a card: the session, its column, status and PR. */
const runsCommand = Command.make(
  "runs",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const taskId = decodeId(TaskId, task);
      if (taskId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `--task "${task}" is not a task id (tsk_…)`,
        );
      }
      const { client } = yield* BoardClient;
      for (const line of yield* runsLines(client, taskId)) {
        yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("List a card's runs: session, column, status, PR"),
  Command.withExamples([
    {
      command: "factory board runs --task tsk_…",
      description: "Newest run first, each with its session id and PR link",
    },
  ]),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription(
    "Create a board, read its configuration, upgrade it to a newer definition version, add cards, then read and move them: lanes, one card, a move, a comment, a run, a block, what needs a person",
  ),
  Command.withSubcommands([
    createCommand,
    addCommand,
    lsCommand,
    showCommand,
    moveCommand,
    commentCommand,
    startCommand,
    // Read-only: which boards and definitions exist, and what each does (LOB-270).
    ...boardConfigCommands,
    // The one write that moves a board's pin, and its cards' with it when asked (D5).
    ...boardUpgradeCommands,
    blockCommand,
    unblockCommand,
    updateCommand,
    attentionCommand,
    runsCommand,
  ]),
);
