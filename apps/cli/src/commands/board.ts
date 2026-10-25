import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { SessionError } from "@repo/domain/Session";
import type { Task } from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailure } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory board` — the board over the same RPC client the dashboard uses (D9).
 *
 * The four verbs are the ones a person needs to work a card from a terminal: read the lanes and
 * what sits in them (`ls`), read one card (`show`), move it (`move`), and start the run that
 * advances it (`start`). Nothing here folds a log or reads the database; every answer is the
 * server's, which is what keeps `factory board ls` and the RPC list in agreement.
 *
 * **Refusals are printed, not swallowed.** The board's refusals are typed values that name what
 * failed — `UndeclaredTransition` names both columns, `StaleRevision` names the revision it found,
 * `HumanGateRequired` names the gate — so the command prints the service's own message verbatim
 * (docs/board.md B5: "a refusal names the failing requirement") and exits non-zero. A script that
 * cannot tell a refused move from a successful one is worse than no command.
 */

/** The service's tag as the snake_case word a script branches on, matching `SessionError.code`. */
const refusalCode = (tag: string): string =>
  tag.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const hasMessage = (error: unknown): error is { message: string } =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof (error as { message: unknown }).message === "string";

/**
 * Report a board failure the way the rest of the CLI does: `error: <code>: <message>` on stderr and
 * a non-zero exit. A `SessionError` keeps its code; a typed task refusal becomes the snake_case form
 * of its tag; anything else is `error`.
 */
const reportBoardFailures = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, never, R> =>
  effect.pipe(
    Effect.catch((error) =>
      Schema.is(SessionError)(error)
        ? reportFailure(error.code, error.message)
        : typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            hasMessage(error)
          ? reportFailure(
              refusalCode(String((error as { _tag: unknown })._tag)),
              error.message,
            )
          : reportFailure("error", String(error)),
    ),
  );

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
      const { client } = yield* BoardClient;
      const view = yield* client.getBoard({ boardId: board as never });
      const cards = yield* client.listTasks({ boardId: board as never });

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

    yield* reportBoardFailures(
      Effect.provide(program, BoardClient.layer(apiUrl)),
    );
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

/** `factory board show <task>` — one card, as the server has it. */
const showCommand = Command.make(
  "show",
  {
    task: Flag.String("task").pipe(Flag.withDescription("Task id (tsk_…)")),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const card = yield* client.getTask({ taskId: task as never });

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
            : `${card.blocked.reason} since ${card.blocked.since}`
        }`,
      );
      yield* Console.log(`title     ${card.title}`);
    });

    yield* reportBoardFailures(
      Effect.provide(program, BoardClient.layer(apiUrl)),
    );
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
      const { client } = yield* BoardClient;
      const moved = yield* client.moveTask({
        taskId: task as never,
        expectedRevision: expectRevision,
        to,
        actor,
      });
      yield* Console.log(
        `moved ${moved.id} to ${moved.column} (revision ${moved.revision})`,
      );
    });

    yield* reportBoardFailures(
      Effect.provide(program, BoardClient.layer(apiUrl)),
    );
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
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, column, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const card = yield* client.getTask({ taskId: task as never });
      const taskColumn = Option.isSome(column) ? column.value : card.column;
      const session = yield* client.createSession({
        title: card.title,
        taskId: card.id,
        taskColumn,
        ...(card.repo === undefined ? {} : { repo: card.repo }),
      });
      yield* Console.log(`session ${session.id}`);
      yield* Console.log(`task    ${card.id} in ${taskColumn}`);
    });

    yield* reportBoardFailures(
      Effect.provide(program, BoardClient.layer(apiUrl)),
    );
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
    "Read and move cards on a board: lanes, one card, a move, a run",
  ),
  Command.withSubcommands([lsCommand, showCommand, moveCommand, startCommand]),
);
