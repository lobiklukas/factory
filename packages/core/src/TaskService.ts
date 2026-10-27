/**
 * Tasks: create, read, list, move, block and unblock cards on a board (docs/board.md B1–B5, B7, B9),
 * and the thread on each card — a run's question, a person's answer, a note (B7, LOB-73).
 *
 * Cards are rows (B3). Every mutation runs in one transaction that locks the task row, checks the
 * caller's expected `revision`, checks the declared transition and any human gate, writes the task
 * row, and appends exactly one `task_events` row. A refusal fails the transaction before anything is
 * written, so a refused move leaves no event behind.
 *
 * Refusals are typed values (`TaskRefusal`-family, below), each naming what failed. They are not
 * booleans, and a caller branches on `_tag`.
 *
 * Two rules are checked here that the board decisions name but the definition does not carry yet
 * (`BoardColumn` has no transitions field). Their tables live in `@repo/domain/Task`, because the
 * dashboard's card pane offers exactly what this service accepts (LOB-76):
 *
 * - **Declared transitions** (`DECLARED_TRANSITIONS`) are the forward pipeline of the default
 *   definition, plus `canceled` from any non-terminal column. Anything else is an undeclared
 *   transition.
 * - **Human gates** (`HUMAN_GATES`) are `planning → building` (plan approval) and `review → done`
 *   (merge). A run is one Pi Durable session, so a run's actor is its session id; any actor that is
 *   a session id is a run and cannot cross a gate. Every other actor is a person.
 *
 * **Exit requirements (B5, B8; LOB-80).** A move out of a column checks the column's `requires[]`
 * under the card's pinned definition version, after the transition and the gate, and a requirement
 * that is not met refuses the move with `RequirementUnmet`, naming it. Which keys are checked, and
 * against what, is `./requirements`; `verified` reads the `verify` records in the logs of the card's
 * runs. The logs are read *before* the card is locked, not inside the transaction: a log fold is
 * unbounded work on other connections, and holding the row lock (and a pool connection) across it
 * would let a long log stall every other move of the card. The transaction then refuses the move as
 * stale if the card left the column the evidence was judged for while the logs were read.
 *
 * **The thread is `task_events`, not a table of its own (LOB-73).** A comment is a `commented` event:
 * B3 makes a card rows plus an append-only history, and a comment is exactly that — input a person
 * (or a run) wrote against the card, with an actor and the revision it was written at. The ask is a
 * comment *and* a `needs_input` block, and the answer is a comment *and* the unblock, so each pair is
 * one transaction over one table; a `task_comments` table would split one mutation's history across
 * two orderings and duplicate the actor/revision/time columns `task_events` already carries. A
 * session's log is ruled out for the reason B3 rules it out for cards: the answer is typed by a person
 * and has no log to replay it from, and the next run is a *different* session that must read it.
 *
 * Postgres only: the tests run against the real schema from `0007_create_tasks.ts`.
 */
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  BoardColumn,
  BoardInstance,
  BoardInstanceId,
  BoardView,
  LIST_BOARDS_LIMIT,
  humanGate,
  isDeclaredTransition,
  Task,
  TaskEvent,
  TaskId,
  TaskRun,
} from "@repo/domain/Task";
import { TaskComment } from "@repo/domain/Task";
import type {
  Actor,
  BlockReason as BlockReasonType,
  CommentKind,
  TaskPriority as TaskPriorityType,
} from "@repo/domain/Task";
import { SessionId } from "@repo/domain/Session";
import { readVerifyRecords } from "@repo/harness";
import { PostgresStorage } from "@repo/storage-postgres";
import { mintTaskId } from "./ids";
import {
  exitRequirements,
  requirementVerdict,
  type RunEvidence,
} from "./requirements";

/** Every new card starts in the default definition's first column (B4). */
export const INITIAL_COLUMN = "intake";

/** A run's actor is its session id (B1: a run is exactly one session). Any other actor is a person. */
export const isRunActor = (actor: Actor): boolean =>
  Schema.is(SessionId)(actor);

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { taskId: Schema.String, message: Schema.String },
) {}

export class BoardNotFound extends Schema.TaggedError<BoardNotFound>()(
  "BoardNotFound",
  { boardId: Schema.String, message: Schema.String },
) {}

/** The expected revision was not the card's current one; `actual` is what it is now. */
export class StaleRevision extends Schema.TaggedError<StaleRevision>()(
  "StaleRevision",
  {
    taskId: Schema.String,
    expected: Schema.Int,
    actual: Schema.Int,
    message: Schema.String,
  },
) {}

/** The move is not in the declared transitions of its column. Names both columns. */
export class UndeclaredTransition extends Schema.TaggedError<UndeclaredTransition>()(
  "UndeclaredTransition",
  { from: Schema.String, to: Schema.String, message: Schema.String },
) {}

/** A run tried to cross a human gate. Names the gate. */
export class HumanGateRequired extends Schema.TaggedError<HumanGateRequired>()(
  "HumanGateRequired",
  {
    gate: Schema.String,
    from: Schema.String,
    to: Schema.String,
    actor: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * A move out of a column whose checked `requires[]` the card has not met (B5, B8; LOB-80). Names the
 * requirement by key, and the message says what is missing (`./requirements`).
 */
export class RequirementUnmet extends Schema.TaggedError<RequirementUnmet>()(
  "RequirementUnmet",
  {
    taskId: Schema.String,
    column: Schema.String,
    to: Schema.String,
    requirement: Schema.String,
    message: Schema.String,
  },
) {}

export class AlreadyBlocked extends Schema.TaggedError<AlreadyBlocked>()(
  "AlreadyBlocked",
  { taskId: Schema.String, message: Schema.String },
) {}

export class NotBlocked extends Schema.TaggedError<NotBlocked>()("NotBlocked", {
  taskId: Schema.String,
  message: Schema.String,
}) {}

export class TaskStorageError extends Schema.TaggedError<TaskStorageError>()(
  "TaskStorageError",
  { message: Schema.String },
) {}

/** A comment, question or answer with nothing in it: a thread entry has to say something (LOB-73). */
export class EmptyComment extends Schema.TaggedError<EmptyComment>()(
  "EmptyComment",
  { taskId: Schema.String, message: Schema.String },
) {}

export type TaskError =
  | TaskNotFound
  | BoardNotFound
  | StaleRevision
  | UndeclaredTransition
  | HumanGateRequired
  | RequirementUnmet
  | AlreadyBlocked
  | NotBlocked
  | EmptyComment
  | TaskStorageError;

export type CreateTaskInput = {
  readonly boardId: string;
  readonly title: string;
  readonly repo?: string;
  readonly priority?: TaskPriorityType;
  readonly actor: Actor;
};

export type MoveTaskInput = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly to: string;
  readonly actor: Actor;
};

export type BlockTaskInput = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly reason: BlockReasonType;
  readonly note?: string;
  readonly actor: Actor;
};

export type UnblockTaskInput = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly actor: Actor;
};

export type ListTasksInput = {
  readonly boardId: string;
  readonly column?: string;
};

/**
 * A run's question (B7, LOB-73): the comment it ends parked on, and the `needs_input` block.
 *
 * No expected revision: the asker is the run working the card, not a person who read it, so there is
 * no stale read to refuse — the card is locked and the ask lands on whatever revision it is at.
 * `askId` makes the ask idempotent: a second ask with the same id records nothing and answers the
 * card as it is, which is what lets the `ask` tool replay safely after a crash.
 */
export type AskTaskInput = {
  readonly taskId: string;
  readonly question: string;
  readonly actor: Actor;
  readonly askId?: string;
};

export type CommentTaskInput = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly body: string;
  readonly actor: Actor;
};

export type TaskServiceShape = {
  /** The board and the definition version it binds (B2), in one read: lanes and cards agree. */
  readonly getBoard: (boardId: string) => Effect.Effect<BoardView, TaskError>;
  /** Every board instance, newest first, capped at `LIST_BOARDS_LIMIT` (LOB-75). */
  readonly listBoards: Effect.Effect<ReadonlyArray<BoardInstance>, TaskError>;
  readonly create: (input: CreateTaskInput) => Effect.Effect<Task, TaskError>;
  readonly get: (taskId: string) => Effect.Effect<Task, TaskError>;
  readonly list: (
    input: ListTasksInput,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskError>;
  readonly move: (input: MoveTaskInput) => Effect.Effect<Task, TaskError>;
  readonly block: (input: BlockTaskInput) => Effect.Effect<Task, TaskError>;
  readonly unblock: (input: UnblockTaskInput) => Effect.Effect<Task, TaskError>;
  /** A run's question: a `question` comment and a `needs_input` block from the card's column. */
  readonly ask: (input: AskTaskInput) => Effect.Effect<Task, TaskError>;
  /** A comment; from a person on a card blocked `needs_input`, the answer that lifts the block. */
  readonly comment: (input: CommentTaskInput) => Effect.Effect<Task, TaskError>;
  /** The card's thread, oldest first: every `commented` event, verbatim. */
  readonly comments: (
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<TaskComment>, TaskError>;
  /** A card's runs, newest first (LOB-76). An unknown card is `TaskNotFound`, not an empty list. */
  readonly listRuns: (
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<TaskRun>, TaskError>;
};

export class TaskService extends Context.Service<
  TaskService,
  TaskServiceShape
>()("@repo/core/TaskService") {}

/** One `tasks` row as the driver returns it (snake_case columns become camelCase). */
type TaskRow = {
  readonly id: string;
  readonly boardId: string;
  readonly title: string;
  readonly column: string;
  readonly repo: string | null;
  readonly definitionVersion: number;
  readonly revision: number;
  readonly priority: string;
  readonly blockedReason: string | null;
  readonly blockedColumn: string | null;
  readonly blockedNote: string | null;
  readonly blockedSince: Date | string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

/** The column list, spelled out once so every read returns the same shape. */
const TASK_COLUMNS = [
  "id",
  "board_id",
  "title",
  `"column"`,
  "repo",
  "definition_version",
  "revision",
  "priority",
  "blocked_reason",
  "blocked_column",
  "blocked_note",
  "blocked_since",
  "created_at",
  "updated_at",
].join(", ");

/** What `move` judged about the card's exit before locking it: the column, and the first unmet requirement. */
type ExitJudgement = {
  readonly from: string | undefined;
  readonly unmet: RequirementUnmet | undefined;
};

const iso = (value: Date | string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

export const TaskServiceLive = Layer.effect(
  TaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const decodeTask = Schema.decodeUnknownEffect(Task);
    const decodeBoard = Schema.decodeUnknownEffect(BoardView);
    const decodeInstance = Schema.decodeUnknownEffect(BoardInstance);
    const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(TaskEvent));

    const toTask = (row: TaskRow): Effect.Effect<Task, TaskStorageError> =>
      decodeTask({
        id: row.id,
        boardId: row.boardId,
        title: row.title,
        column: row.column,
        definitionVersion: row.definitionVersion,
        revision: row.revision,
        priority: row.priority,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        ...(row.repo === null ? {} : { repo: row.repo }),
        ...(row.blockedReason === null ||
        row.blockedColumn === null ||
        row.blockedSince === null
          ? {}
          : {
              blocked: {
                reason: row.blockedReason,
                column: row.blockedColumn,
                since: iso(row.blockedSince),
                ...(row.blockedNote === null ? {} : { note: row.blockedNote }),
              },
            }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TaskStorageError({
              message: `the tasks table holds an invalid row ${row.id}: ${String(cause)}`,
            }),
        ),
      );

    /** Appends one event in the caller's transaction. The schema encodes it first, so it is valid by construction. */
    const appendEvent = (event: TaskEvent) =>
      Effect.gen(function* () {
        const encoded = yield* encodeEvent(event).pipe(
          Effect.mapError(
            (cause) =>
              new TaskStorageError({
                message: `a ${event._tag} event does not encode: ${String(cause)}`,
              }),
          ),
        );
        yield* sql`
          INSERT INTO task_events (task_id, kind, actor, revision, payload)
          VALUES (${event.taskId}, ${event._tag}, ${event.actor}, ${event.revision}, ${encoded}::jsonb)
        `;
      });

    /** Locks the card for the rest of the transaction, so a concurrent mutation waits and then reads the new revision. */
    const lockTask = (taskId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks WHERE id = ${taskId} FOR UPDATE
        `;
        return rows[0] === undefined
          ? Option.none<TaskRow>()
          : Option.some(rows[0]);
      });

    /** Shared head of every mutation of an existing card: found, and at the expected revision. */
    const lockExpected = (taskId: string, expected: number) =>
      Effect.gen(function* () {
        const found = yield* lockTask(taskId);
        if (Option.isNone(found)) {
          return yield* new TaskNotFound({
            taskId,
            message: `no task ${taskId}`,
          });
        }
        const row = found.value;
        if (row.revision !== expected) {
          return yield* new StaleRevision({
            taskId,
            expected,
            actual: row.revision,
            message: `task ${taskId} is at revision ${row.revision}, not ${expected}: someone moved it first`,
          });
        }
        return row;
      });

    const withStorage = <A>(
      effect: Effect.Effect<A, TaskError | SqlError>,
    ): Effect.Effect<A, TaskError> =>
      effect.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new TaskStorageError({ message: String(cause) })),
        ),
      );

    /**
     * The board and the definition version it binds (B2), in one statement so the two halves cannot
     * disagree: a board instance names `(definition_id, definition_version)` and the join is on the
     * pair, so `default` v2 never answers for a card pinned to v1.
     *
     * A missing instance is `BoardNotFound`; a missing definition row is impossible while 0007's
     * foreign key holds, so it is reported as the storage fault it would be rather than as a truth
     * about the caller's argument.
     */
    const getBoard = (boardId: string): Effect.Effect<BoardView, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const rows = yield* sql<{
            repo: string;
            definitionId: string;
            definitionVersion: number;
            createdAt: Date | string;
            name: string;
            columns: string;
          }>`
            SELECT bi.repo,
                   bi.definition_id AS "definitionId",
                   bi.definition_version AS "definitionVersion",
                   bi.created_at AS "createdAt",
                   bd.name,
                   bd.columns::text AS columns
            FROM board_instances bi
            JOIN board_definitions bd
              ON bd.id = bi.definition_id AND bd.version = bi.definition_version
            WHERE bi.id = ${boardId}
          `;
          const row = rows[0];
          if (row === undefined) {
            return yield* new BoardNotFound({
              boardId,
              message: `no board ${boardId}`,
            });
          }
          const columns = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Array(BoardColumn)),
          )(row.columns).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `board ${boardId} holds an invalid column set: ${String(cause)}`,
                }),
            ),
          );
          return yield* decodeBoard({
            instance: {
              id: boardId,
              repo: row.repo,
              definitionId: row.definitionId,
              definitionVersion: row.definitionVersion,
              createdAt: iso(row.createdAt),
            },
            definition: {
              id: row.definitionId,
              version: row.definitionVersion,
              name: row.name,
              columns,
            },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `board ${boardId} does not decode: ${String(cause)}`,
                }),
            ),
          );
        }),
      );

    /**
     * Which boards exist, newest first (LOB-75). The id breaks a tie on `created_at`, so two
     * instances made in the same transaction still list in one stable order.
     */
    const listBoards: Effect.Effect<
      ReadonlyArray<BoardInstance>,
      TaskError
    > = withStorage(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          repo: string;
          definitionId: string;
          definitionVersion: number;
          createdAt: Date | string;
        }>`
            SELECT id, repo,
                   definition_id AS "definitionId",
                   definition_version AS "definitionVersion",
                   created_at AS "createdAt"
            FROM board_instances
            ORDER BY created_at DESC, id DESC
            LIMIT ${LIST_BOARDS_LIMIT}
          `;
        return yield* Effect.forEach(rows, (row) =>
          decodeInstance({ ...row, createdAt: iso(row.createdAt) }).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `board ${row.id} does not decode: ${String(cause)}`,
                }),
            ),
          ),
        );
      }),
    );

    const get = (taskId: string): Effect.Effect<Task, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const rows = yield* sql<TaskRow>`
            SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks WHERE id = ${taskId}
          `;
          if (rows[0] === undefined) {
            return yield* new TaskNotFound({
              taskId,
              message: `no task ${taskId}`,
            });
          }
          return yield* toTask(rows[0]);
        }),
      );

    const create = (input: CreateTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const boards = yield* sql<{
              id: string;
              definitionVersion: number;
            }>`
              SELECT id, definition_version FROM board_instances WHERE id = ${input.boardId}
            `;
            const board = boards[0];
            if (board === undefined) {
              return yield* new BoardNotFound({
                boardId: input.boardId,
                message: `no board ${input.boardId}`,
              });
            }
            const id = yield* mintTaskId;
            const priority = input.priority ?? "normal";
            const rows = yield* sql<TaskRow>`
              INSERT INTO tasks (
                id, board_id, title, "column", repo, definition_version,
                revision, priority, created_at, updated_at
              )
              VALUES (
                ${id}, ${board.id}, ${input.title}, ${INITIAL_COLUMN}, ${input.repo ?? null},
                ${board.definitionVersion}, 1, ${priority}, now(), now()
              )
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            yield* appendEvent({
              _tag: "created",
              taskId: id,
              boardId: BoardInstanceId.make(board.id),
              title: input.title,
              column: INITIAL_COLUMN,
              actor: input.actor,
              revision: 1,
            });
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const list = (
      input: ListTasksInput,
    ): Effect.Effect<ReadonlyArray<Task>, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          // Urgent first (B9), then FIFO by creation, then id, which is time-sortable.
          const rows =
            input.column === undefined
              ? yield* sql<TaskRow>`
                  SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
                  WHERE board_id = ${input.boardId}
                  ORDER BY (priority = 'urgent') DESC, created_at, id
                `
              : yield* sql<TaskRow>`
                  SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
                  WHERE board_id = ${input.boardId} AND "column" = ${input.column}
                  ORDER BY (priority = 'urgent') DESC, created_at, id
                `;
          return yield* Effect.forEach(rows, toTask);
        }),
      );

    const decodeColumns = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(BoardColumn)),
    );

    /**
     * The column a card sits in, by name and as the definition version it pinned declares it (B2):
     * `undefined` for a card that is gone, and `declared` absent for a column its definition does
     * not name.
     */
    const pinnedColumn = (taskId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ column: string; columns: string }>`
          SELECT t."column", bd.columns::text AS columns
          FROM tasks t
          JOIN board_instances bi ON bi.id = t.board_id
          JOIN board_definitions bd
            ON bd.id = bi.definition_id AND bd.version = t.definition_version
          WHERE t.id = ${taskId}
        `;
        const row = rows[0];
        if (row === undefined) return undefined;
        const columns = yield* decodeColumns(row.columns).pipe(
          Effect.mapError(
            (cause) =>
              new TaskStorageError({
                message: `task ${taskId}'s definition holds an invalid column set: ${String(cause)}`,
              }),
          ),
        );
        return {
          name: row.column,
          declared: columns.find((candidate) => candidate.name === row.column),
        };
      });

    /**
     * What the card's runs recorded, oldest run first (B1: a run is one session, and its log is the
     * truth for what it did). One batched read folds every run's log; none is opened as an owner.
     */
    const runEvidence = (taskId: string) =>
      Effect.gen(function* () {
        const runs = yield* sql<{ sessionId: string }>`
          SELECT session_id FROM task_runs
          WHERE task_id = ${taskId}
          ORDER BY started_at, id
        `;
        const ids = runs.map((run) => run.sessionId);
        const logs = yield* Effect.tryPromise({
          try: () => PostgresStorage.readers(sql, ids),
          catch: (cause) =>
            new TaskStorageError({
              message: `task ${taskId}: could not read its runs' logs: ${String(cause)}`,
            }),
        });
        return yield* Effect.forEach(
          ids,
          (sessionId): Effect.Effect<RunEvidence, TaskStorageError> => {
            const storage = logs.get(sessionId);
            return storage === undefined
              ? Effect.succeed({ sessionId, records: [] })
              : readVerifyRecords(storage).pipe(
                  Effect.map((records) => ({ sessionId, records })),
                  Effect.mapError(
                    (cause) =>
                      new TaskStorageError({
                        message: `task ${taskId}: run ${sessionId}'s verify records do not read: ${cause.message}`,
                      }),
                  ),
                );
          },
        );
      });

    /**
     * The first exit requirement leaving the card's current column for `to` does not meet, judged
     * before the card is locked (module doc). `from` is the column it was judged for, which the
     * transaction holds the locked card to; it is absent for a card the read did not find, which the
     * transaction then refuses as `TaskNotFound`.
     */
    const judgeExit = (
      input: MoveTaskInput,
    ): Effect.Effect<ExitJudgement, TaskError | SqlError> =>
      Effect.gen(function* () {
        const pinned = yield* pinnedColumn(input.taskId);
        if (pinned === undefined) return { from: undefined, unmet: undefined };
        const column = pinned.declared;
        const requirements = exitRequirements(column, input.to);
        if (column === undefined || requirements.length === 0)
          return { from: pinned.name, unmet: undefined };
        const runs = yield* runEvidence(input.taskId);
        for (const requirement of requirements) {
          const verdict = requirementVerdict(requirement, runs);
          if (!verdict.met) {
            return {
              from: column.name,
              unmet: new RequirementUnmet({
                taskId: input.taskId,
                column: column.name,
                to: input.to,
                requirement: requirement.key,
                message: `the move ${column.name} → ${input.to} needs "${requirement.key}" (${requirement.description}), which is not met: ${verdict.reason}`,
              }),
            };
          }
        }
        return { from: column.name, unmet: undefined };
      });

    const move = (input: MoveTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const exit = yield* judgeExit(input);
          return yield* moveLocked(input, exit);
        }),
      );

    const moveLocked = (
      input: MoveTaskInput,
      exit: ExitJudgement,
    ): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockExpected(
              input.taskId,
              input.expectedRevision,
            );
            const from = row.column;
            if (!isDeclaredTransition(from, input.to)) {
              return yield* new UndeclaredTransition({
                from,
                to: input.to,
                message: `column "${from}" declares no transition to "${input.to}"`,
              });
            }
            const gate = humanGate(from, input.to);
            if (gate !== undefined && isRunActor(input.actor)) {
              return yield* new HumanGateRequired({
                gate,
                from,
                to: input.to,
                actor: input.actor,
                message: `the move ${from} → ${input.to} crosses the ${gate} gate, which only a person can make`,
              });
            }
            if (exit.from !== undefined && exit.from !== from) {
              return yield* new StaleRevision({
                taskId: input.taskId,
                expected: input.expectedRevision,
                actual: row.revision,
                message: `task ${input.taskId} moved to "${from}" while the evidence for leaving "${exit.from}" was read`,
              });
            }
            if (exit.unmet !== undefined) return yield* exit.unmet;
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET "column" = ${input.to}, revision = revision + 1, updated_at = now()
              WHERE id = ${input.taskId} AND revision = ${input.expectedRevision}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            if (rows[0] === undefined) {
              return yield* new StaleRevision({
                taskId: input.taskId,
                expected: input.expectedRevision,
                actual: row.revision,
                message: `task ${input.taskId} moved while this move waited`,
              });
            }
            yield* appendEvent({
              _tag: "moved",
              taskId: TaskId.make(input.taskId),
              from,
              to: input.to,
              actor: input.actor,
              revision: input.expectedRevision,
            });
            return yield* toTask(rows[0]);
          }),
        ),
      );

    const block = (input: BlockTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockExpected(
              input.taskId,
              input.expectedRevision,
            );
            if (row.blockedReason !== null) {
              return yield* new AlreadyBlocked({
                taskId: input.taskId,
                message: `task ${input.taskId} is already blocked (${row.blockedReason})`,
              });
            }
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET blocked_reason = ${input.reason}, blocked_column = ${row.column},
                  blocked_note = ${input.note ?? null}, blocked_since = now(),
                  revision = revision + 1, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            yield* appendEvent({
              _tag: "blocked",
              taskId: TaskId.make(input.taskId),
              reason: input.reason,
              column: row.column,
              actor: input.actor,
              revision: input.expectedRevision,
            });
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const unblock = (input: UnblockTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockExpected(
              input.taskId,
              input.expectedRevision,
            );
            if (row.blockedReason === null) {
              return yield* new NotBlocked({
                taskId: input.taskId,
                message: `task ${input.taskId} is not blocked`,
              });
            }
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET blocked_reason = NULL, blocked_column = NULL, blocked_note = NULL,
                  blocked_since = NULL, revision = revision + 1, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            yield* appendEvent({
              _tag: "unblocked",
              taskId: TaskId.make(input.taskId),
              actor: input.actor,
              revision: input.expectedRevision,
            });
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    /** A thread entry that says nothing is refused before anything is written. */
    const refuseEmpty = (taskId: string, body: string, what: string) =>
      body.trim().length === 0
        ? Effect.fail(
            new EmptyComment({
              taskId,
              message: `${what} on task ${taskId} is empty: a thread entry has to say something`,
            }),
          )
        : Effect.void;

    const ask = (input: AskTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const found = yield* lockTask(input.taskId);
            if (Option.isNone(found)) {
              return yield* new TaskNotFound({
                taskId: input.taskId,
                message: `no task ${input.taskId}`,
              });
            }
            const row = found.value;
            if (input.askId !== undefined) {
              // Read under the card's lock, so two replays of one ask cannot both miss each other.
              const asked = yield* sql<{ n: number }>`
                SELECT count(*)::int AS n FROM task_events
                WHERE task_id = ${input.taskId} AND kind = 'commented'
                  AND payload->>'askId' = ${input.askId}
              `;
              if ((asked[0]?.n ?? 0) > 0) return yield* toTask(row);
            }
            yield* refuseEmpty(input.taskId, input.question, "the question");
            // A card blocked for another reason is waiting on something else; parking a question on
            // it would hide that block behind one an answer could lift. Already `needs_input` is a
            // second question on the same wait, so it joins the thread and the block stays.
            if (
              row.blockedReason !== null &&
              row.blockedReason !== "needs_input"
            ) {
              return yield* new AlreadyBlocked({
                taskId: input.taskId,
                message: `task ${input.taskId} is already blocked (${row.blockedReason}); a question cannot park it`,
              });
            }
            yield* appendEvent({
              _tag: "commented",
              taskId: TaskId.make(input.taskId),
              actor: input.actor,
              body: input.question,
              kind: "question",
              revision: row.revision,
              ...(input.askId === undefined ? {} : { askId: input.askId }),
            });
            if (row.blockedReason !== null) {
              const rows = yield* sql<TaskRow>`
                UPDATE tasks SET revision = revision + 1, updated_at = now()
                WHERE id = ${input.taskId}
                RETURNING ${sql.literal(TASK_COLUMNS)}
              `;
              return yield* toTask(rows[0] as TaskRow);
            }
            // The block names the column the card blocked from (B4), and carries the question as its
            // note so a reader of the card alone sees what it is waiting on.
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET blocked_reason = 'needs_input', blocked_column = ${row.column},
                  blocked_note = ${input.question}, blocked_since = now(),
                  revision = revision + 2, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            yield* appendEvent({
              _tag: "blocked",
              taskId: TaskId.make(input.taskId),
              reason: "needs_input",
              column: row.column,
              actor: input.actor,
              revision: row.revision + 1,
            });
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const comment = (input: CommentTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockExpected(
              input.taskId,
              input.expectedRevision,
            );
            yield* refuseEmpty(input.taskId, input.body, "the comment");
            // Only a person answers (B7): a run that comments on its own parked card is adding to
            // the question, not closing it.
            const answers =
              row.blockedReason === "needs_input" && !isRunActor(input.actor);
            const kind: CommentKind = answers ? "answer" : "note";
            yield* appendEvent({
              _tag: "commented",
              taskId: TaskId.make(input.taskId),
              actor: input.actor,
              body: input.body,
              kind,
              revision: input.expectedRevision,
            });
            if (!answers) {
              const rows = yield* sql<TaskRow>`
                UPDATE tasks SET revision = revision + 1, updated_at = now()
                WHERE id = ${input.taskId}
                RETURNING ${sql.literal(TASK_COLUMNS)}
              `;
              return yield* toTask(rows[0] as TaskRow);
            }
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET blocked_reason = NULL, blocked_column = NULL, blocked_note = NULL,
                  blocked_since = NULL, revision = revision + 2, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            yield* appendEvent({
              _tag: "unblocked",
              taskId: TaskId.make(input.taskId),
              actor: input.actor,
              revision: input.expectedRevision + 1,
            });
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const decodeEvent = Schema.decodeUnknownEffect(
      Schema.fromJsonString(TaskEvent),
    );
    const decodeComment = Schema.decodeUnknownEffect(TaskComment);

    const comments = (
      taskId: string,
    ): Effect.Effect<ReadonlyArray<TaskComment>, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const exists = yield* sql<{ id: string }>`
            SELECT id FROM tasks WHERE id = ${taskId}
          `;
          if (exists[0] === undefined) {
            return yield* new TaskNotFound({
              taskId,
              message: `no task ${taskId}`,
            });
          }
          // Event order is write order (`id` is an identity), which is the thread's order: a question
          // and the answer to it are never reordered by a clock that ticked twice in one millisecond.
          // Ordered by the column, not the `id` text alias, which would sort "100" before "99".
          const rows = yield* sql<{
            id: string;
            payload: string;
            createdAt: Date | string;
          }>`
            SELECT id::text AS id, payload::text AS payload, created_at
            FROM task_events
            WHERE task_id = ${taskId} AND kind = 'commented'
            ORDER BY task_events.id
          `;
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const event = yield* decodeEvent(row.payload);
              if (event._tag !== "commented") {
                return yield* Effect.fail(
                  `event ${row.id} is stored as commented but is ${event._tag}`,
                );
              }
              return yield* decodeComment({
                taskId: event.taskId,
                kind: event.kind ?? "note",
                actor: event.actor,
                body: event.body,
                revision: event.revision,
                createdAt: iso(row.createdAt),
              });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new TaskStorageError({
                    message: `task ${taskId} holds an unreadable comment ${row.id}: ${String(cause)}`,
                  }),
              ),
            ),
          );
        }),
      );

    const decodeRun = Schema.decodeUnknownEffect(TaskRun);

    /**
     * A card's runs, newest first (LOB-76). The card is looked up first so an unknown id is a
     * refusal naming it: an empty list is the true answer for a card no run was started against,
     * and the two must not look the same. The id breaks a tie on `started_at`, as `listBoards` does.
     */
    const listRuns = (
      taskId: string,
    ): Effect.Effect<ReadonlyArray<TaskRun>, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const found = yield* sql<{ id: string }>`
            SELECT id FROM tasks WHERE id = ${taskId}
          `;
          if (found[0] === undefined) {
            return yield* new TaskNotFound({
              taskId,
              message: `no task ${taskId}`,
            });
          }
          const rows = yield* sql<{
            id: string;
            taskId: string;
            sessionId: string;
            column: string;
            startedAt: Date | string;
            finishedAt: Date | string | null;
          }>`
            SELECT id, task_id, session_id, "column", started_at, finished_at
            FROM task_runs
            WHERE task_id = ${taskId}
            ORDER BY started_at DESC, id DESC
          `;
          return yield* Effect.forEach(rows, (row) =>
            decodeRun({
              id: row.id,
              taskId: row.taskId,
              sessionId: row.sessionId,
              column: row.column,
              startedAt: iso(row.startedAt),
              ...(row.finishedAt === null
                ? {}
                : { finishedAt: iso(row.finishedAt) }),
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new TaskStorageError({
                    message: `the task_runs table holds an invalid row ${row.id}: ${String(cause)}`,
                  }),
              ),
            ),
          );
        }),
      );

    return {
      getBoard,
      listBoards,
      create,
      get,
      list,
      move,
      block,
      unblock,
      ask,
      comment,
      comments,
      listRuns,
    } satisfies TaskServiceShape;
  }),
);
