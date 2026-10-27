import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { RepoSlug, SessionActor } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  TaskId,
} from "@repo/domain/Task";
import type { Task, TaskComment } from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory board` — the board over the same RPC client the dashboard uses (D9).
 *
 * The verbs are the ones a person needs to work a card from a terminal: make the board a repository's
 * cards live on (`create`, LOB-208), read the lanes and what sits in them (`ls`), read one card and
 * its thread (`show`), move it (`move`), answer what a parked run asked (`comment`, LOB-73), and
 * start the run that advances it (`start`). Nothing here folds a log or reads the database; every
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

const actorFlag = Flag.String("actor").pipe(
  Flag.withDescription(
    "Who makes the move; a session id is a run, anything else is a person",
  ),
  Flag.withDefault("cli"),
);

/** Who a run started from the terminal is attributed to (LOB-162): `cli`, as a move's actor is. */
const runActorFlag = Flag.String("actor").pipe(
  Flag.withDescription("Who the run's spend is attributed to"),
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
      yield* Console.log(`board       ${board.id}`);
      yield* Console.log(`repo        ${board.repo}`);
      yield* Console.log(
        `definition  ${board.definitionId} v${board.definitionVersion}`,
      );
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

/** A lane's cards, indented under the lane's own line so the lane stays readable at a glance. */
const laneCard = (task: Task): string =>
  ["", task.id, task.priority, task.title].join("  ");

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
      for (const column of view.definition.columns) {
        const lane = cards.filter((card) => card.column === column.name);
        yield* Console.log(
          [column.name, column.kind, String(lane.length)].join("  "),
        );
        for (const card of lane) {
          yield* Console.log(laneCard(card));
        }
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
 * One comment of a card's thread: a header naming what it is and who wrote it, then the body with
 * every line indented under it — the body's own lines, unwrapped, so what is printed is what was typed.
 */
export const threadLines = (comment: TaskComment): ReadonlyArray<string> => [
  `  [${comment.kind}] ${comment.actor} (revision ${comment.revision})`,
  ...comment.body.split("\n").map((line) => `    ${line}`),
];

/**
 * `factory board show <task>` — one card, as the server has it, and its thread (B7): the question a
 * parked run asked and the answer a person gave are read here, on the task, not in a transcript.
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

      yield* Console.log(`id        ${card.id}`);
      yield* Console.log(`board     ${card.boardId}`);
      yield* Console.log(`column    ${card.column}`);
      yield* Console.log(`revision  ${card.revision}`);
      yield* Console.log(`priority  ${card.priority}`);
      yield* Console.log(`repo      ${card.repo ?? "-"}`);
      yield* Console.log(
        `blocked   ${
          card.blocked === undefined
            ? "-"
            : `${card.blocked.reason} from ${card.blocked.column} since ${card.blocked.since}`
        }`,
      );
      yield* Console.log(`title     ${card.title}`);
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
 * `factory board comment` — add to a card's thread (B7, LOB-73).
 *
 * From a person on a card blocked `needs_input`, the comment is the answer: it lifts the block in the
 * same transaction, and the next run started on the card reads it in its prompt. Anywhere else it is
 * a note. `--expect-revision` is required for the reason it is on `move`: an answer typed against a
 * card someone else already answered must be refused, not silently appended.
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
    actor: actorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, body, expectRevision, actor, api }) {
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
      const before = yield* client.getTask({ taskId });
      const after = yield* client.commentTask({
        taskId,
        expectedRevision: expectRevision,
        body,
        actor,
      });
      yield* Console.log(
        `commented on ${after.id} (revision ${after.revision})`,
      );
      if (before.blocked !== undefined && after.blocked === undefined) {
        yield* Console.log(
          `answered: ${after.id} is no longer blocked (${before.blocked.reason} from ${before.blocked.column})`,
        );
      }
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
  ]),
);

/**
 * `factory board start` — open the run that advances a card.
 *
 * A run is exactly one Pi Durable session (B1), so starting one is `createSession` with the card
 * named: the session carries the `factory.task` document, the run row is written against the card,
 * and the column the run started in is the column whose `requires[]` it must satisfy on exit. The
 * card is not moved here — the lane a run works in is where the card already sits.
 */
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
        "The first message the run is sent; without it the run opens and waits",
      ),
      Flag.optional,
    ),
    actor: runActorFlag,
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, column, prompt, actor, api }) {
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
      const taskColumn = Option.isSome(column) ? column.value : card.column;
      const session = yield* client.createSession({
        title: card.title,
        taskId: card.id,
        taskColumn,
        actor,
        ...(card.repo === undefined ? {} : { repo: card.repo }),
      });
      yield* Console.log(`session ${session.id}`);
      yield* Console.log(`task    ${card.id} in ${taskColumn}`);
      if (Option.isSome(prompt)) {
        // Sent, not followed: the run is headless (B7), so the command returns as soon as the turn
        // is accepted, and the card — not this terminal — is where the run's outcome is read.
        yield* client.sendMessage({
          sessionId: session.id,
          content: prompt.value,
        });
        yield* Console.log(`sent    ${prompt.value}`);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Start a run against a card"),
  Command.withExamples([
    {
      command: "factory board start --task tsk_…",
      description: "A session bound to the card, in the card's own column",
    },
  ]),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription(
    "Create a board, then read and move its cards: lanes, one card, a move, a comment, a run",
  ),
  Command.withSubcommands([
    createCommand,
    lsCommand,
    showCommand,
    moveCommand,
    commentCommand,
    startCommand,
  ]),
);
