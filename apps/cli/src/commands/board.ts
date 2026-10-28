import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import {
  RepoSlug,
  SessionActor,
  SessionError,
  SessionId,
} from "@repo/domain/Session";
import type { SessionSummary } from "@repo/domain/Session";
import {
  BlockReason,
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  TaskId,
} from "@repo/domain/Task";
import type {
  AttentionItem,
  Task,
  TaskComment,
  TaskRun,
  TaskSpec,
} from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { NO_PR } from "./ls";
import { BoardClient } from "../rpc";

/**
 * `factory board` — the board over the same RPC client the dashboard uses (D9).
 *
 * The verbs are the ones a person needs to work a card from a terminal: make the board a repository's
 * cards live on (`create`, LOB-208), read the lanes and what sits in them (`ls`), read one card, its
 * spec and its thread (`show`), move it (`move`), answer what a parked run asked (`comment`, LOB-73),
 * start the run that advances it (`start`), and, for triage (LOB-264), park or free a card (`block`,
 * `unblock`), list what needs a person (`attention`) and list a card's runs (`runs`). Nothing here
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
      for (const line of specLines(spec)) yield* Console.log(line);
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
  const head = [
    reason._tag,
    task.id,
    item.repo,
    task.column,
    `r${task.revision}`,
    oneLine(task.title),
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
        `  ${reason.gate}: ${reason.sessionId} is idle; ${task.column} → ${reason.to} is a person's`,
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
    "Create a board, then read and move its cards: lanes, one card, a move, a comment, a run, a block, what needs a person",
  ),
  Command.withSubcommands([
    createCommand,
    lsCommand,
    showCommand,
    moveCommand,
    commentCommand,
    startCommand,
    blockCommand,
    unblockCommand,
    attentionCommand,
    runsCommand,
  ]),
);
