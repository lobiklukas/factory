/**
 * The board's data contract (docs/board.md B1–B12, introduced by docs/design.md D17).
 *
 * A **task** is the unit of work: its repo, its column, its history, its artifacts (B1). A **run**
 * is one attempt at advancing it and is exactly one Pi Durable session, so `run_id` *is* the
 * session id and the run's log is the truth for what the run did (D7) — which is why a task owns
 * runs rather than being one. One cardinality rule: **one card, many runs**.
 *
 * A board is **definitions plus instances**, held in the factory's own database (B2). A definition
 * declares columns and their policies; an instance binds one repository to a definition version.
 * Every task pins the definition version it started under, so editing a definition cannot mutate
 * work in flight.
 *
 * Cards are rows, not a log (B3): `tasks` plus an append-only `task_events`, one transaction per
 * mutation, with `revision` on the task for optimistic concurrency. Nothing here knows how those
 * rows are stored — the migration that creates them is `0007_create_tasks.ts`, and the service
 * that writes them is a later issue.
 */
import { Schema } from "effect";
// The package's own subpath, not `./Session`: `PgMigrator.fromFileSystem` loads a migration
// with a *native* dynamic import, and in that context an extensionless relative specifier
// inside this package is left for Node's ESM loader, which does not add `.ts`. Every other
// consumer in the repo (`packages/core`, `packages/harness`) already imports the subpath.
import { RepoSlug, SessionId, Timestamp } from "@repo/domain/Session";

/**
 * Task ids use `SessionId`'s alphabet and shape (`tsk_`, ten of millisecond timestamp then sixteen
 * of randomness, Crockford base32), because an id here is as much a label for a human as a key for
 * a database: it has to be sortable, unique, and safe to read out loud. The server mints it.
 */
export const TaskId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^tsk_[0-9abcdefghjkmnpqrstvwxyz]{26}$/)),
  Schema.brand("TaskId"),
);
export type TaskId = typeof TaskId.Type;

/** A board definition's own id, stable across the versions that carry its column sets. */
export const DefinitionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)),
  Schema.brand("DefinitionId"),
);
export type DefinitionId = typeof DefinitionId.Type;

/** A board instance's id: one repository bound to one definition version (B2). */
export const BoardInstanceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^brd_[0-9abcdefghjkmnpqrstvwxyz]{26}$/)),
  Schema.brand("BoardInstanceId"),
);
export type BoardInstanceId = typeof BoardInstanceId.Type;

/**
 * What a column does with a card sitting in it (B4).
 *
 * - `resting` — nothing happens to the card until a person moves it. `intake` is the only one.
 * - `working` — a run may be started here, and the column's `requires[]` are checked on exit.
 * - `terminal` — the card is finished; `done` and `canceled`.
 */
export const ColumnKind = Schema.Literals(["resting", "working", "terminal"]);
export type ColumnKind = typeof ColumnKind.Type;

/**
 * One machine-checkable exit requirement of a column (B5, B8).
 *
 * `key` is the stable identity a refusal names — B5 requires that "a refusal names the failing
 * requirement", so a requirement without a key is prose the gate cannot check. `description` is the
 * human statement of what satisfies it, which is what the UI shows and what a person reads.
 */
export const ColumnRequirement = Schema.Struct({
  key: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/))),
  description: Schema.String,
});
export type ColumnRequirement = typeof ColumnRequirement.Type;

/**
 * One column of a board definition (B4, B6).
 *
 * `role` resolves to model and tool policy in one place, so changing a model is one edit rather
 * than one per column; it is absent where B4 puts "—". `skills[]` are factory-owned skill names
 * (B6), injected at `openSession` alongside the role's tool policy. `requires[]` is checked on
 * exit, not on entry: a card may always be moved *into* a column, and the gate is what leaves it.
 */
export const BoardColumn = Schema.Struct({
  name: Schema.String,
  kind: ColumnKind,
  role: Schema.optional(Schema.String),
  skills: Schema.Array(Schema.String),
  requires: Schema.Array(ColumnRequirement),
});
export type BoardColumn = typeof BoardColumn.Type;

/**
 * A versioned board definition: the column set a board instance binds to (B2).
 *
 * `id` + `version` identify one row. A new version is a new row, never an update, so a task that
 * pinned version 1 keeps reading the columns it started under while work moves on under version 2.
 */
export const BoardDefinition = Schema.Struct({
  id: DefinitionId,
  version: Schema.Int,
  name: Schema.String,
  columns: Schema.Array(BoardColumn),
});
export type BoardDefinition = typeof BoardDefinition.Type;

/**
 * One repository's board: a definition version bound to a repo (B2).
 *
 * The instance is what a task belongs to, and through it a task inherits a repo without repeating
 * it — B1 gives a task "its repo", and B2 gives the instance the binding that repo actually lives
 * in, so two boards over one repository stay two boards.
 */
export const BoardInstance = Schema.Struct({
  id: BoardInstanceId,
  repo: RepoSlug,
  definitionId: DefinitionId,
  definitionVersion: Schema.Int,
  createdAt: Timestamp,
});
export type BoardInstance = typeof BoardInstance.Type;

/** B9: within a column, dependency readiness, then this flag, then FIFO. */
export const TaskPriority = Schema.Literals(["urgent", "normal"]);
export type TaskPriority = typeof TaskPriority.Type;

/**
 * Why a card is blocked (B4).
 *
 * `blocked` is a **card state, not a column**: a blocked card stays visible in its own lane, so
 * there is no "return to where it was" ambiguity and no `ready` column pretending to be a queue.
 * B7 adds that a block carries the question a run ended with, recorded as a comment on the task.
 */
export const BlockReason = Schema.Literals([
  "dependency",
  "needs_input",
  "capability",
  "transient",
]);
export type BlockReason = typeof BlockReason.Type;

export const TaskBlocked = Schema.Struct({
  reason: BlockReason,
  /** The column the card blocked from. */
  column: Schema.String,
  note: Schema.optional(Schema.String),
  since: Timestamp,
});
export type TaskBlocked = typeof TaskBlocked.Type;

/**
 * One card on a board (B1, B3).
 *
 * `column` is a *name*, not a position: B9 rejects a drag-ordered queue as a second source of
 * truth about "what is next", so nothing here stores an ordering. `revision` is the optimistic
 * concurrency token B3 requires — every mutation carries the revision it expected, and a stale
 * write is refused rather than allowed to clobber a newer state.
 */
export const Task = Schema.Struct({
  id: TaskId,
  boardId: BoardInstanceId,
  title: Schema.String,
  column: Schema.String,
  repo: Schema.optional(RepoSlug),
  /** The definition version this task started under (B2). */
  definitionVersion: Schema.Int,
  revision: Schema.Int,
  priority: TaskPriority,
  blocked: Schema.optional(TaskBlocked),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = typeof Task.Type;

/**
 * Who did this. A string, not a typed actor, because the actor is LOB-20's to define — control-plane
 * identity and the per-session actor are uncut, and inventing a shape here would either collide
 * with that issue or force it to migrate this one.
 */
export const Actor = Schema.String;
export type Actor = typeof Actor.Type;

/**
 * One append-only event on a task (B3, B5, B7, B9).
 *
 * Events are the card's history: what happened, who did it, and under which expected `revision`.
 * **Append-only is a rule the writer upholds, not one the database enforces.** `commits` does
 * enforce it, with a trigger (`0002_create_commits.ts`); `task_events` has no trigger, so an
 * `UPDATE` or a `DELETE` on it succeeds today. That gap is not an oversight in either direction: a
 * `commits`-style `BEFORE DELETE` trigger would reject migration 0007's own `ON DELETE CASCADE`
 * from `board_instances`, so the two cannot both hold until someone decides which gives. The case
 * in `PostgresStorage.test.ts` that lets an event be rewritten and deleted asserts the real
 * behaviour on purpose, so these words and that test redden together when the decision is made.
 * It is a card's history either way — the audit trail for a gated move.
 *
 * The kinds are exactly the ones the board decisions name: a move (B5), a block and an unblock
 * (B4, B7), a comment (B7 — the question a run ended with, and the answer to one), and a priority
 * change (B9, "priority changes are recorded as events"). A run starting or finishing is a later
 * issue's event: LOB-60 owns the run-start and run-finish events and the `factory.task` log
 * document; this file already carries `TaskRun` and migration 0007 already creates `task_runs`,
 * because B1 makes a run a first-class thing a task owns.
 */
export const TaskEvent = Schema.TaggedUnion({
  created: {
    taskId: TaskId,
    boardId: BoardInstanceId,
    title: Schema.String,
    column: Schema.String,
    actor: Actor,
    revision: Schema.Int,
  },
  moved: {
    taskId: TaskId,
    from: Schema.String,
    to: Schema.String,
    actor: Actor,
    revision: Schema.Int,
  },
  blocked: {
    taskId: TaskId,
    reason: BlockReason,
    column: Schema.String,
    actor: Actor,
    revision: Schema.Int,
  },
  unblocked: {
    taskId: TaskId,
    actor: Actor,
    revision: Schema.Int,
  },
  commented: {
    taskId: TaskId,
    actor: Actor,
    body: Schema.String,
    revision: Schema.Int,
  },
  priorityChanged: {
    taskId: TaskId,
    from: TaskPriority,
    to: TaskPriority,
    actor: Actor,
    revision: Schema.Int,
  },
});
export type TaskEvent = typeof TaskEvent.Type;

/**
 * One attempt at advancing a task (B1).
 *
 * A run is exactly one Pi Durable session, so `sessionId` is the run's `log_id` and the log is the
 * truth for what the run did — the row is the index, not the record. `column` is the column the
 * run was started from, which is the column whose `requires[]` the run has to satisfy on exit.
 *
 * There is deliberately no `outcome` here: B10's failure mapping (`orphaned`, `faulted`, `failed`,
 * `aborted`) is wave 2, recorded so the MVP does not contradict it rather than implemented.
 *
 * `id` is the one id in this file that carries no pattern, and that is a decision rather than an
 * oversight: the run's natural key is `sessionId` (B1 — a run *is* one session), which 0007 makes
 * `UNIQUE`, while this row's own `id` exists only as the primary key the events and the UI would
 * reference. `Task.test.ts` pins the untypedness on both sides — the schema accepts any string and
 * so does `id TEXT PRIMARY KEY`. LOB-60 owns the run id when it owns the run's events.
 */
export const TaskRun = Schema.Struct({
  id: Schema.String,
  taskId: TaskId,
  sessionId: SessionId,
  column: Schema.String,
  startedAt: Timestamp,
  finishedAt: Schema.optional(Timestamp),
});
export type TaskRun = typeof TaskRun.Type;

/**
 * Why a board operation was refused (B5: "a refusal names the failing requirement").
 *
 * - `not_found` — no such task or board.
 * - `stale_revision` — the expected revision is not the card's current one (B3, B5). A move that
 *   loses a race to another move lands here too.
 * - `undeclared_transition` — the card's column declares no transition to the requested column,
 *   or the requested column is not in the card's pinned definition.
 * - `human_gate` — a run tried to cross a column's human gate; only a person may (B5).
 * - `blocked` — a move was asked of a card that is blocked; it is unblocked first.
 * - `already_blocked` / `not_blocked` — a block or an unblock against the wrong state.
 * - `storage` — the database could not be read or written, or a row failed the domain contract.
 */
export const TaskErrorCode = Schema.Literals([
  "not_found",
  "stale_revision",
  "undeclared_transition",
  "human_gate",
  "blocked",
  "already_blocked",
  "not_blocked",
  "storage",
]);
export type TaskErrorCode = typeof TaskErrorCode.Type;

/** A refused board operation: the code a caller can branch on, and the message a person reads. */
export class TaskError extends Schema.TaggedError<TaskError>()("TaskError", {
  code: TaskErrorCode,
  message: Schema.String,
}) {}
