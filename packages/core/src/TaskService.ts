/**
 * Cards on a board: create, read, list, move, block and unblock (docs/board.md B3, B4, B5, B7, B9).
 *
 * A card is a row in `tasks` and its history is `task_events`; every mutation writes both in one
 * transaction (B3). Nothing here knows about runs, sessions or the tracker: LOB-60 adds the run
 * events, and LOB-80 checks a column's `requires[]` before a move leaves it.
 *
 * Two rules carry the whole file:
 *
 * - **Compare-and-set on `revision`.** A mutation names the revision it expected. It refuses before
 *   writing when that is not the card's revision, and the `UPDATE` itself repeats the check
 *   (`AND revision = …`) and must touch exactly one row. Two moves racing on one card therefore
 *   leave one standing: the loser's `UPDATE` waits on the winner's row lock, then matches nothing,
 *   and its transaction rolls back with no event written.
 * - **Refusals are decided before anything is written.** A refused call returns a `TaskError` whose
 *   message names the failing requirement, and it never reaches the `INSERT` into `task_events`.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  BoardColumn,
  Task,
  TaskError,
  TaskEvent,
  type BlockReason,
  type BoardInstanceId,
  type ColumnRequirement,
  type TaskErrorCode,
  type TaskId,
  type TaskPriority,
} from "@repo/domain/Task";
import { mintTaskId } from "./ids";

/**
 * Who is acting. A person may cross any gate; a run may not cross a human gate (B5).
 *
 * LOB-20 owns the real actor (identity, the per-session actor). Until it lands, an actor is recorded
 * as the string `person:<id>` or `run:<runId>` in `task_events.actor`, so a history reads the same
 * way a typed one would.
 */
export type Principal =
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "run"; readonly runId: string };

/** The column a card may be canceled into from any column that is not terminal (B4's `canceled`). */
const CANCELED = "canceled";

export type CreateTaskInput = {
  readonly boardId: BoardInstanceId;
  readonly title: string;
  readonly priority?: TaskPriority;
  readonly by: Principal;
};

export type ListTasksInput = {
  readonly boardId: BoardInstanceId;
  readonly column?: string;
};

export type MoveTaskInput = {
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly to: string;
  readonly by: Principal;
};

export type BlockTaskInput = {
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly reason: BlockReason;
  /** Optional metadata kept on the card. It is not an event field: B7's question is a comment (LOB-73). */
  readonly note?: string;
  readonly by: Principal;
};

export type UnblockTaskInput = {
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly by: Principal;
};

export type TaskServiceShape = {
  readonly create: (input: CreateTaskInput) => Effect.Effect<Task, TaskError>;
  readonly get: (taskId: TaskId) => Effect.Effect<Task, TaskError>;
  /** Ordered as B9 orders a column: urgent first, then first in first out. */
  readonly list: (
    input: ListTasksInput,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskError>;
  readonly move: (input: MoveTaskInput) => Effect.Effect<Task, TaskError>;
  readonly block: (input: BlockTaskInput) => Effect.Effect<Task, TaskError>;
  readonly unblock: (input: UnblockTaskInput) => Effect.Effect<Task, TaskError>;
};

export class TaskService extends Context.Service<
  TaskService,
  TaskServiceShape
>()("@repo/core/TaskService") {}

/** One row of `tasks`, as `PostgresLive`'s snake-to-camel transform names it. */
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
  readonly blockedSince: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type BoardRow = {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
};

const storage = (message: string) =>
  new TaskError({ code: "storage", message });

const refuse = (code: TaskErrorCode, message: string) =>
  new TaskError({ code, message });

const actorOf = (by: Principal): string =>
  by.kind === "person" ? `person:${by.id}` : `run:${by.runId}`;

const isHumanGate = (requirement: ColumnRequirement): boolean =>
  requirement.key.startsWith("human_");

/**
 * The columns a card may move to from `columns[fromIndex]`, by B4's pipeline order.
 *
 * B4 declares the pipeline's order and no explicit transitions, and the definition carries none, so
 * the transitions are derived here: a non-terminal column moves to the next column in order, and to
 * `canceled` from anywhere that is not already terminal. Storing transitions on the definition is a
 * follow-up that would change `BoardColumn`; until then this function is the only place the rule lives.
 */
const declaredTargets = (
  columns: ReadonlyArray<BoardColumn>,
  fromIndex: number,
): ReadonlyArray<string> => {
  const from = columns[fromIndex];
  if (from === undefined || from.kind === "terminal") return [];
  const targets: string[] = [];
  const next = columns[fromIndex + 1];
  if (next !== undefined) targets.push(next.name);
  if (
    from.name !== CANCELED &&
    columns.some((column) => column.name === CANCELED) &&
    !targets.includes(CANCELED)
  ) {
    targets.push(CANCELED);
  }
  return targets;
};

export const TaskServiceLive = Layer.effect(
  TaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    // Not a shared constant: a `Statement` is bound to the client it was built from.
    const selectTask = sql`
      SELECT id, board_id, title, "column", repo, definition_version, revision,
        priority, blocked_reason, blocked_column, blocked_note,
        to_char(blocked_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS blocked_since,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM tasks
    `;

    /** Any `SqlError` becomes a typed `storage` refusal: a caller branches on the code, not the driver. */
    const storageFailure = (cause: SqlError) =>
      Effect.fail(storage(`the database failed: ${cause.message}`));

    /** One mutation, in one transaction: its refusals pass through, a driver failure becomes `storage`. */
    const transact = <A>(
      effect: Effect.Effect<A, TaskError | SqlError>,
    ): Effect.Effect<A, TaskError> =>
      sql
        .withTransaction(effect)
        .pipe(Effect.catchTag("SqlError", storageFailure));

    const decodeTask = Schema.decodeUnknownEffect(Task);
    const decodeColumns = Schema.decodeUnknownEffect(Schema.Array(BoardColumn));
    const encodeEvent = Schema.encodeEffect(TaskEvent);

    const toTask = (row: TaskRow): Effect.Effect<Task, TaskError> =>
      decodeTask({
        id: row.id,
        boardId: row.boardId,
        title: row.title,
        column: row.column,
        ...(row.repo === null ? {} : { repo: row.repo }),
        definitionVersion: row.definitionVersion,
        revision: row.revision,
        priority: row.priority,
        ...(row.blockedReason === null ||
        row.blockedColumn === null ||
        row.blockedSince === null
          ? {}
          : {
              blocked: {
                reason: row.blockedReason,
                column: row.blockedColumn,
                since: row.blockedSince,
                ...(row.blockedNote === null ? {} : { note: row.blockedNote }),
              },
            }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }).pipe(
        Effect.mapError(() =>
          storage(`the tasks table holds a row ${row.id} the contract rejects`),
        ),
      );

    const readTask = (taskId: TaskId) =>
      sql<TaskRow>`${selectTask} WHERE id = ${taskId}`.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row === undefined
            ? Effect.fail(refuse("not_found", `no task ${taskId}`))
            : toTask(row);
        }),
      );

    const loadBoard = (boardId: string) =>
      sql<BoardRow>`
        SELECT id, definition_id, definition_version
        FROM board_instances WHERE id = ${boardId}
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row === undefined
            ? Effect.fail(refuse("not_found", `no board ${boardId}`))
            : Effect.succeed(row);
        }),
      );

    /** The columns a card pinned to `version` of `definitionId` moves through. */
    const columnsOf = (definitionId: string, version: number) =>
      sql<{ columns: unknown }>`
        SELECT columns FROM board_definitions
        WHERE id = ${definitionId} AND version = ${version}
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row === undefined
            ? Effect.fail(
                storage(
                  `no definition ${definitionId} version ${version} for a card pinned to it`,
                ),
              )
            : decodeColumns(row.columns).pipe(
                Effect.mapError(() =>
                  storage(
                    `definition ${definitionId} version ${version} holds columns the contract rejects`,
                  ),
                ),
              );
        }),
      );

    const appendEvent = (event: TaskEvent) =>
      encodeEvent(event).pipe(
        Effect.mapError(() => storage("a task event failed to encode")),
        Effect.flatMap(
          (encoded) =>
            sql`
            INSERT INTO task_events (task_id, kind, actor, revision, payload)
            VALUES (${event.taskId}, ${event._tag}, ${event.actor}, ${event.revision},
              ${JSON.stringify(encoded)}::jsonb)
          `,
        ),
      );

    /** The compare-and-set every mutation ends with: exactly one row, or a lost race. */
    const claimRevision = (
      taskId: TaskId,
      expectedRevision: number,
      rows: ReadonlyArray<unknown>,
    ) =>
      rows.length === 1
        ? Effect.void
        : Effect.fail(
            refuse(
              "stale_revision",
              `task ${taskId} changed while this call was being made: it no longer holds revision ${expectedRevision}`,
            ),
          );

    /** The shared opening of a mutation: read the card, and refuse a stale expected revision. */
    const currentAt = (taskId: TaskId, expectedRevision: number) =>
      readTask(taskId).pipe(
        Effect.tap((task) =>
          task.revision === expectedRevision
            ? Effect.void
            : Effect.fail(
                refuse(
                  "stale_revision",
                  `task ${taskId} is at revision ${task.revision}; the call expected ${expectedRevision}`,
                ),
              ),
        ),
      );

    const create = Effect.fn("TaskService.create")(function* (
      input: CreateTaskInput,
    ) {
      const taskId = yield* mintTaskId;
      const actor = actorOf(input.by);
      return yield* transact(
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          const columns = yield* columnsOf(
            board.definitionId,
            board.definitionVersion,
          );
          const first = columns[0];
          if (first === undefined) {
            return yield* storage(
              `definition ${board.definitionId} declares no columns`,
            );
          }
          const priority = input.priority ?? "normal";
          yield* sql`
            INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, priority)
            VALUES (${taskId}, ${board.id}, ${input.title}, ${first.name},
              ${board.definitionVersion}, 1, ${priority})
          `;
          yield* appendEvent({
            _tag: "created",
            taskId,
            boardId: input.boardId,
            title: input.title,
            column: first.name,
            actor,
            revision: 1,
          });
          return yield* readTask(taskId);
        }),
      );
    });

    const get = Effect.fn("TaskService.get")(function* (taskId: TaskId) {
      return yield* readTask(taskId).pipe(
        Effect.catchTag("SqlError", storageFailure),
      );
    });

    const list = Effect.fn("TaskService.list")(function* (
      input: ListTasksInput,
    ) {
      yield* loadBoard(input.boardId).pipe(
        Effect.catchTag("SqlError", storageFailure),
      );
      const column = input.column ?? null;
      const rows = yield* sql<TaskRow>`
        ${selectTask}
        WHERE board_id = ${input.boardId}
          AND (${column}::text IS NULL OR "column" = ${column})
        ORDER BY (priority = 'urgent') DESC, created_at, id
      `.pipe(Effect.catchTag("SqlError", storageFailure));
      return yield* Effect.forEach(rows, toTask);
    });

    const move = Effect.fn("TaskService.move")(function* (
      input: MoveTaskInput,
    ) {
      const actor = actorOf(input.by);
      return yield* transact(
        Effect.gen(function* () {
          const task = yield* currentAt(input.taskId, input.expectedRevision);
          if (task.blocked !== undefined) {
            return yield* refuse(
              "blocked",
              `task ${task.id} is blocked (${task.blocked.reason}) from ${task.blocked.column}: unblock it before moving it`,
            );
          }
          const board = yield* loadBoard(task.boardId);
          const columns = yield* columnsOf(
            board.definitionId,
            task.definitionVersion,
          );
          const fromIndex = columns.findIndex(
            (column) => column.name === task.column,
          );
          const from = columns[fromIndex];
          if (from === undefined) {
            return yield* storage(
              `task ${task.id} is in column ${task.column}, which its pinned definition does not declare`,
            );
          }
          const targets = declaredTargets(columns, fromIndex);
          if (!targets.includes(input.to)) {
            return yield* refuse(
              "undeclared_transition",
              `the transition ${from.name} → ${input.to} is not declared: ${from.name} may move to ${
                targets.length === 0 ? "no column" : targets.join(", ")
              }`,
            );
          }
          const gate = from.requires.find(isHumanGate);
          if (
            gate !== undefined &&
            input.to !== CANCELED &&
            input.by.kind === "run"
          ) {
            return yield* refuse(
              "human_gate",
              `a run cannot move ${task.id} from ${from.name} to ${input.to}: the human gate "${gate.key}" (${gate.description}) needs a person`,
            );
          }
          const rows = yield* sql<{ id: string }>`
            UPDATE tasks
            SET "column" = ${input.to}, revision = revision + 1, updated_at = now()
            WHERE id = ${task.id} AND revision = ${input.expectedRevision}
            RETURNING id
          `;
          yield* claimRevision(task.id, input.expectedRevision, rows);
          yield* appendEvent({
            _tag: "moved",
            taskId: task.id,
            from: from.name,
            to: input.to,
            actor,
            revision: input.expectedRevision,
          });
          return yield* readTask(task.id);
        }),
      );
    });

    const block = Effect.fn("TaskService.block")(function* (
      input: BlockTaskInput,
    ) {
      const actor = actorOf(input.by);
      return yield* transact(
        Effect.gen(function* () {
          const task = yield* currentAt(input.taskId, input.expectedRevision);
          if (task.blocked !== undefined) {
            return yield* refuse(
              "already_blocked",
              `task ${task.id} is already blocked (${task.blocked.reason}) from ${task.blocked.column}`,
            );
          }
          const note = input.note ?? null;
          const rows = yield* sql<{ id: string }>`
            UPDATE tasks
            SET blocked_reason = ${input.reason}, blocked_column = ${task.column},
              blocked_note = ${note}, blocked_since = now(),
              revision = revision + 1, updated_at = now()
            WHERE id = ${task.id} AND revision = ${input.expectedRevision}
            RETURNING id
          `;
          yield* claimRevision(task.id, input.expectedRevision, rows);
          yield* appendEvent({
            _tag: "blocked",
            taskId: task.id,
            reason: input.reason,
            column: task.column,
            actor,
            revision: input.expectedRevision,
          });
          return yield* readTask(task.id);
        }),
      );
    });

    const unblock = Effect.fn("TaskService.unblock")(function* (
      input: UnblockTaskInput,
    ) {
      const actor = actorOf(input.by);
      return yield* transact(
        Effect.gen(function* () {
          const task = yield* currentAt(input.taskId, input.expectedRevision);
          if (task.blocked === undefined) {
            return yield* refuse(
              "not_blocked",
              `task ${task.id} is not blocked`,
            );
          }
          const rows = yield* sql<{ id: string }>`
            UPDATE tasks
            SET blocked_reason = NULL, blocked_column = NULL,
              blocked_note = NULL, blocked_since = NULL,
              revision = revision + 1, updated_at = now()
            WHERE id = ${task.id} AND revision = ${input.expectedRevision}
            RETURNING id
          `;
          yield* claimRevision(task.id, input.expectedRevision, rows);
          yield* appendEvent({
            _tag: "unblocked",
            taskId: task.id,
            actor,
            revision: input.expectedRevision,
          });
          return yield* readTask(task.id);
        }),
      );
    });

    return TaskService.of({ create, get, list, move, block, unblock });
  }),
);
