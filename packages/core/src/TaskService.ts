/**
 * Tasks: create, read, list, move, block and unblock cards on a board (docs/board.md B1–B5, B7, B9).
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
import type {
  Actor,
  BlockReason as BlockReasonType,
  TaskPriority as TaskPriorityType,
} from "@repo/domain/Task";
import { SessionId } from "@repo/domain/Session";
import { mintTaskId } from "./ids";

/** Every new card starts in the default definition's first column (B4). */
export const INITIAL_COLUMN = "intake";

/** Re-exported for the callers that read the rule from the service that enforces it. */
export { isDeclaredTransition };

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

export type TaskError =
  | TaskNotFound
  | BoardNotFound
  | StaleRevision
  | UndeclaredTransition
  | HumanGateRequired
  | AlreadyBlocked
  | NotBlocked
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

    const move = (input: MoveTaskInput): Effect.Effect<Task, TaskError> =>
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
      listRuns,
    } satisfies TaskServiceShape;
  }),
);
