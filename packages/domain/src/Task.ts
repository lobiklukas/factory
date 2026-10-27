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
 * The moves each column of the default definition declares (B4, B5): the forward pipeline, plus
 * `canceled` from any column that is not terminal. A move to anything else is an undeclared
 * transition, and a terminal column declares none.
 *
 * Here rather than in `packages/core` because two readers must agree on it exactly: `TaskService`
 * refuses what it does not list, and the dashboard's card pane offers only what it lists (LOB-76),
 * so a move the API would refuse is never offered. `BoardColumn` carries no transitions field yet;
 * when a definition declares its own, this table is what it replaces, for both readers at once.
 */
export const DECLARED_TRANSITIONS: Readonly<
  Record<string, ReadonlyArray<string>>
> = {
  intake: ["specifying", "canceled"],
  specifying: ["planning", "canceled"],
  planning: ["building", "canceled"],
  building: ["review", "canceled"],
  review: ["done", "canceled"],
};

/** B5's two human gates, keyed by `from→to`, with the name a refusal (and the card pane) gives them. */
export const HUMAN_GATES: Readonly<Record<string, string>> = {
  "planning→building": "plan approval",
  "review→done": "merge",
};

/**
 * The requirement a column declares when leaving it takes a passing verification of the card's
 * change (B8, LOB-80, part 3 of LOB-16). The default pipeline's `review` column declares it from
 * definition version 3 (`0018_seed_verified_requirement.ts`); `TaskService` checks it against the
 * `verify` records of the card's runs and refuses the move, naming it, when it is not met.
 */
export const VERIFIED_REQUIREMENT = "verified";

/** The columns a card in `from` may move to, in the order the pipeline declares them. */
export const declaredTransitions = (from: string): ReadonlyArray<string> =>
  DECLARED_TRANSITIONS[from] ?? [];

export const isDeclaredTransition = (from: string, to: string): boolean =>
  declaredTransitions(from).includes(to);

/** The human gate the move `from → to` crosses, or `undefined` when a run may make it too. */
export const humanGate = (from: string, to: string): string | undefined =>
  HUMAN_GATES[`${from}→${to}`];

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

/**
 * One board as a client reads it: the instance and the exact definition version it binds (B2).
 *
 * Both halves are needed and neither can be derived from the other: the instance says which repo and
 * which version, the definition says what that version's columns are and in what order. That pairing
 * is why this is one read rather than two calls — a client that fetched them separately could print
 * one version's lanes with another version's cards. `factory board ls` (LOB-61) is the first reader.
 */
export const BoardView = Schema.Struct({
  instance: BoardInstance,
  definition: BoardDefinition,
});
export type BoardView = typeof BoardView.Type;

export const GetBoardInput = Schema.Struct({ boardId: BoardInstanceId });
export type GetBoardInput = typeof GetBoardInput.Type;

/**
 * Which boards exist (LOB-75): the instances a client can open, newest first.
 *
 * An instance, not a `BoardView`: the list is how a reader picks a board, and the definition's
 * columns are what `getBoard` answers for the one they pick. The dashboard's `/boards` route is the
 * first reader — without it a board is reachable only by an id typed into the address bar.
 */
export const ListBoardsInput = Schema.Struct({});
export type ListBoardsInput = typeof ListBoardsInput.Type;

/** The server answers at most this many instances; the MVP has one board per repository (B2). */
export const LIST_BOARDS_LIMIT = 100;

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
 * What one comment is in a task's thread (B7, LOB-73).
 *
 * - `question` — what a run asked when it ended parked: the comment half of a `needs_input` block.
 * - `answer` — a person's comment on a card blocked `needs_input`, which is what lifts the block.
 * - `note` — any other comment.
 *
 * The thread is the card's `commented` events in order, so the kind is recorded when the comment is
 * written rather than inferred on read: whether a comment answered a question depends on the card's
 * state at the time, which a later reader no longer has.
 */
export const CommentKind = Schema.Literals(["question", "answer", "note"]);
export type CommentKind = typeof CommentKind.Type;

/**
 * One comment on a task, as a reader gets it (B7, LOB-73).
 *
 * The store is `task_events` itself — a comment is a `commented` event — so `revision` is the
 * revision the comment was written at and `createdAt` is the event row's. Bodies are verbatim: a
 * thread is quoted into the next run's prompt as it was typed (`@repo/harness`'s thread section).
 */
export const TaskComment = Schema.Struct({
  taskId: TaskId,
  kind: CommentKind,
  actor: Schema.String,
  body: Schema.String,
  revision: Schema.Int,
  createdAt: Timestamp,
});
export type TaskComment = typeof TaskComment.Type;

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
 * `created` records the initial revision (1); every other kind records the revision the mutation expected.
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
    /** What the comment is in the thread (LOB-73). Absent reads as a `note`. */
    kind: Schema.optional(CommentKind),
    /**
     * The ask a run's question came from — `<session id>:<tool call id>` — so a replayed tool call
     * finds the question it already recorded instead of asking twice (LOB-73).
     */
    askId: Schema.optional(Schema.String),
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
 * A card's runs (LOB-76): what the card pane lists, newest first, so a run started from the card
 * stays reachable from it. Read from `task_runs`, the index `createSession` writes when it is
 * given a task and `rebuildIndexes` refolds from each run's `factory.task` document.
 */
export const ListTaskRunsInput = Schema.Struct({ taskId: TaskId });
export type ListTaskRunsInput = typeof ListTaskRunsInput.Type;

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { taskId: Schema.String, message: Schema.String },
) {}

export class BoardNotFound extends Schema.TaggedError<BoardNotFound>()(
  "BoardNotFound",
  { boardId: Schema.String, message: Schema.String },
) {}

export class StaleRevision extends Schema.TaggedError<StaleRevision>()(
  "StaleRevision",
  {
    taskId: Schema.String,
    expected: Schema.Int,
    actual: Schema.Int,
    message: Schema.String,
  },
) {}

export class UndeclaredTransition extends Schema.TaggedError<UndeclaredTransition>()(
  "UndeclaredTransition",
  { from: Schema.String, to: Schema.String, message: Schema.String },
) {}

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
 * A move out of a column whose `requires[]` the card has not met (B5, B8; LOB-80). Names the
 * requirement by its `key`, and `message` says which column, which move and what is missing —
 * B5's "a refusal names the failing requirement", never a bare "denied".
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

/** A comment, a question or an answer with nothing in it (LOB-73): a thread entry must say something. */
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

export const CreateTaskInput = Schema.Struct({
  boardId: BoardInstanceId,
  title: Schema.String,
  repo: Schema.optional(RepoSlug),
  priority: Schema.optional(TaskPriority),
  actor: Schema.String,
});
export type CreateTaskInput = typeof CreateTaskInput.Type;

export const GetTaskInput = Schema.Struct({ taskId: TaskId });
export type GetTaskInput = typeof GetTaskInput.Type;

export const ListTasksInput = Schema.Struct({
  boardId: BoardInstanceId,
  column: Schema.optional(Schema.String),
});
export type ListTasksInput = typeof ListTasksInput.Type;

export const MoveTaskInput = Schema.Struct({
  taskId: TaskId,
  expectedRevision: Schema.Int,
  to: Schema.String,
  actor: Schema.String,
});
export type MoveTaskInput = typeof MoveTaskInput.Type;

export const BlockTaskInput = Schema.Struct({
  taskId: TaskId,
  expectedRevision: Schema.Int,
  reason: Schema.String,
  note: Schema.optional(Schema.String),
  actor: Schema.String,
});
export type BlockTaskInput = typeof BlockTaskInput.Type;

export const UnblockTaskInput = Schema.Struct({
  taskId: TaskId,
  expectedRevision: Schema.Int,
  actor: Schema.String,
});
export type UnblockTaskInput = typeof UnblockTaskInput.Type;

/**
 * The longest comment a card takes, in characters (LOB-73). Every comment is quoted verbatim into
 * the prompt of every run on the card, so its size is a prompt budget, not only a storage one; a log
 * longer than this belongs in a file the run reads, not in the thread.
 */
export const MAX_COMMENT_CHARS = 16_000;

/**
 * A comment on a card (B7, LOB-73). A person's comment on a card blocked `needs_input` is the answer,
 * and lifts the block in the same transaction; any other comment is a note.
 */
export const CommentTaskInput = Schema.Struct({
  taskId: TaskId,
  expectedRevision: Schema.Int,
  body: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_COMMENT_CHARS))),
  actor: Schema.String,
});
export type CommentTaskInput = typeof CommentTaskInput.Type;

/** A card's thread, oldest first (B7, LOB-73). */
export const ListTaskCommentsInput = Schema.Struct({ taskId: TaskId });
export type ListTaskCommentsInput = typeof ListTaskCommentsInput.Type;

/**
 * The column a card moves to out of `from` across a human gate, and the gate's name, or `undefined`
 * when every move out of `from` is one a run may make too (B5). In the default pipeline that is
 * `planning → building` (plan approval) and `review → done` (merge).
 */
export const gatedExit = (
  from: string,
): { readonly to: string; readonly gate: string } | undefined => {
  for (const to of declaredTransitions(from)) {
    const gate = humanGate(from, to);
    if (gate !== undefined) return { to, gate };
  }
  return undefined;
};

/** Every column whose declared exits include a human gate, in pipeline order. */
export const GATED_COLUMNS: ReadonlyArray<string> = Object.keys(
  DECLARED_TRANSITIONS,
).filter((column) => gatedExit(column) !== undefined);

/**
 * Why a card needs a person (LOB-77): the three things the attention view lists.
 *
 * - `approval` — a run of the card asked to make a gated call and waits on a decision (D11). Listed
 *   whatever the card's column or block, because nothing but a person settles it.
 * - `question` — the card is blocked `needs_input` (B7): a run ended parked on a question, and the
 *   answer is a person's comment. `question` is the newest question asked since the block began, or
 *   the block's note when none was; absent when neither says anything.
 * - `gate` — the card is not blocked, it sits in a column whose exit crosses a human gate (B5), it has
 *   a run started in that column, and none of its runs is busy or holds an undecided approval: the
 *   run is idle, and the next move is the one only a person can make. `sessionId` is the newest
 *   run in the column.
 *
 * A card blocked for any other reason — a dependency, a capability, a transient failure — is waiting
 * on that, not on a person, so it is never a `gate`; it is listed only for an approval its run holds.
 */
export const AttentionReason = Schema.TaggedUnion({
  approval: {
    sessionId: SessionId,
    requestId: Schema.String,
    action: Schema.String,
    detail: Schema.String,
    requestedAt: Timestamp,
  },
  question: {
    question: Schema.optional(Schema.String),
    since: Timestamp,
  },
  gate: {
    gate: Schema.String,
    to: Schema.String,
    sessionId: SessionId,
  },
});
export type AttentionReason = typeof AttentionReason.Type;

/**
 * One row of the attention view (LOB-77): a card, the repository its board binds (so a row from any
 * board says where it is), and one reason it needs a person. A card with two reasons is two rows.
 */
export const AttentionItem = Schema.Struct({
  task: Task,
  repo: RepoSlug,
  reason: AttentionReason,
});
export type AttentionItem = typeof AttentionItem.Type;

/**
 * What needs a person, on one board or on every board (LOB-77). The answer is ordered approvals
 * first (oldest request first), then questions (oldest block first), then gates (least recently
 * changed card first). An unknown board is `BoardNotFound`, not an empty list: "nothing needs you"
 * must not be what a board that does not exist says.
 */
export const ListAttentionInput = Schema.Struct({
  boardId: Schema.optional(BoardInstanceId),
});
export type ListAttentionInput = typeof ListAttentionInput.Type;
