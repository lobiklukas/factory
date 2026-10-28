/**
 * Tasks: create, read, list, move, block, unblock and update (title, priority) cards on a board (docs/board.md B1–B5, B7, B9),
 * the thread on each card — a run's question, a person's answer, a note (B7, LOB-73) — and the spec
 * a specifying run declared on it (LOB-238, a `specified` event the run's `spec` tool writes) and the
 * plan a planning run declared (D10, a `planned` event its `plan` tool writes). The boards
 * themselves are read here and created here (`createBoard`, LOB-208), because B2 makes an instance
 * exist before any card and this service is the one that reads it back for every card; so are the
 * definitions they bind (`listDefinitions`, `getDefinition`, LOB-270), which migrations seed and
 * `defineBoard` (D4) adds versions to — validated first (`./boardDefine`), and never in place (B2).
 *
 * Cards are rows (B3). Every mutation runs in one transaction that locks the task row, checks the
 * caller's expected `revision`, checks the declared transition and any human gate, writes the task
 * row, and appends exactly one `task_events` row (an `ask` appends two, at two revisions; an `update`
 * that changes both title and priority appends two, at the one revision it expected). A refusal fails the transaction before anything is
 * written, so a refused move leaves no event behind.
 *
 * Refusals are typed values (`TaskRefusal`-family, below), each naming what failed. They are not
 * booleans, and a caller branches on `_tag`.
 *
 * **Moves are the card's pinned definition's (B2, B5; LOB-267).** A column declares its moves —
 * `transitions: [{ to, gate? }]` — and a definition the column a new card starts in, and every read
 * of them resolves through `@repo/domain/Task` (`columnTransitions`, `initialColumnOf`), because the
 * dashboard's card pane offers exactly what this service accepts (LOB-76):
 *
 * - **Declared transitions.** A move the card's column does not declare, under the definition
 *   version the card pinned, is an undeclared transition. A version that declares no moves at all
 *   (default versions 1–3, written before the field existed) resolves through the default pipeline's
 *   table, so a card pinned to one moves exactly as it did.
 * - **Human gates.** A declared move with a `gate` is one only a person can make — in the default
 *   pipeline `planning → building` (plan approval) and `review → done` (merge). A run is one Pi
 *   Durable session, so a run's actor is its session id; any actor that is a session id is a run and
 *   cannot cross a gate. Every other actor is a person.
 * - **The initial column.** `create` puts a card in its board's definition's `initialColumn`, or its
 *   first column for a version with none.
 *
 * **Exit requirements (B5, B8; LOB-80).** A move out of a column checks the column's `requires[]`
 * under the card's pinned definition version, after the transition and the gate, and a requirement
 * that is not met refuses the move with `RequirementUnmet`, naming it. Which keys are checked, and
 * against what, is `./requirements`; `verified` reads the `verify` records in the logs of the card's
 * runs, `pr_link` the card's PR — the latest run's `factory.pr` document, or an earlier run's
 * recorded from the branch the latest run continues while that branch is still at the commit the
 * PR was published at (C19) — and `non_empty_diff` the latest run's
 * branch, which since C19 is the card's, measured against its base by the PR step's own `git diff --numstat` from the run's
 * registered checkout (a session's worktree is a linked worktree of it, so the two share every ref).
 * A review run (LOB-36: a log with a `factory.review` target) is not among them: it judges a run's
 * change and makes none, and it starts while the card is still in `building` — the PR's `opened` is
 * what starts it — so counting it would make it the "latest run" whose PR and branch `building`'s exit
 * reads, and the card could never leave. What it records is `review_verdict`'s evidence instead
 * (LOB-241): the newest review run's verdict on its own head. The diff runs in a child process without blocking the event loop (`branchDiffSize`), so a large one
 * holds up this move only. The logs are read, and the branch measured, *before* the card is locked,
 * not inside the transaction: a log fold and a `git diff` are unbounded work, and holding the row
 * lock (and a pool connection) across them would let a long log or a large diff stall every other
 * move of the card. The evidence
 * is judged only for the revision the caller expected — a card read at any other revision is refused
 * as `StaleRevision` before its logs are read — and the transaction's own revision check then proves
 * the card did not change while they were (every write to a card bumps its revision). A `verify`
 * call (or a PR, or a commit) a run records in that window is concurrent with the move, which is
 * ordered before it (`./requirements`).
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
  AttentionItem,
  BoardCaps,
  BoardCard,
  BoardColumn,
  BoardDefinition,
  BoardInstance,
  BoardInstanceId,
  BoardView,
  CardMigrationProblem,
  type CreateBoardInput,
  type DefinitionMoves,
  definitionProblems,
  type CreatedBoard,
  type DefineBoardInput,
  type DefinedBoard,
  DefinitionFault,
  DefinitionSummary,
  gatedColumns,
  gatedExit,
  handoffCapRefusal,
  handoffPatchBytes,
  handoffPatchWireBytes,
  handoffPatchFiles,
  HUMAN_MERGE_REQUIREMENT,
  initialColumnOf,
  isTerminalColumn,
  isWebLink,
  LIST_BOARDS_LIMIT,
  MERGED_COLUMN,
  MAX_HANDOFF_PATCH_BYTES,
  MAX_TASK_BODY_CHARS,
  MAX_TASK_REF_CHARS,
  MAX_TASK_TITLE_CHARS,
  NON_EMPTY_DIFF_REQUIREMENT,
  PLAN_DOC_REQUIREMENT,
  RUN_COMPLETED_REQUIREMENT,
  SPEC_DOC_REQUIREMENT,
  Task,
  TaskExit,
  TaskEvent,
  TaskHandoff,
  type TaskHandoffInput,
  TaskId,
  TaskPlan,
  TaskRun,
  TaskSpec,
  transitionOf,
  type UpgradedBoard,
} from "@repo/domain/Task";
import { TaskComment } from "@repo/domain/Task";
import type {
  Actor,
  BlockReason as BlockReasonType,
  CommentKind,
  TaskPriority as TaskPriorityType,
} from "@repo/domain/Task";
import { SessionId } from "@repo/domain/Session";
import {
  readRecordedMerge,
  readRecordedPullRequest,
  readRunTurn,
  readRecordedReview,
  readVerifyCalls,
} from "@repo/harness";
import { PostgresStorage } from "@repo/storage-postgres";
import { isSafeBranchName } from "./git";
import { mintBoardId, mintTaskId } from "./ids";
import {
  authoredDefinitionFaults,
  type DefinitionLibrary,
  HARNESS_ROLES,
} from "./boardDefine";
import { projectTask, type TaskProjection } from "./taskProjection";
import { branchDiffSize } from "./prStep";
import { measureBaseOf } from "./RepoRemote";
import { resolveCommit } from "./repos";
import { parseAddedLines, scanAddedLines } from "./secretScan";
import { noCheckoutWarning } from "./workspace";
import {
  type BranchDiff,
  CHECKED_REQUIREMENTS,
  type CardEvidence,
  exitRequirements,
  exitView,
  requirementVerdict,
  type RunEvidence,
} from "./requirements";

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

/**
 * `createBoard` named a definition the factory does not hold, or a version of it that does not exist
 * (LOB-208). `version` is the one the caller named; it is absent when no version of the id exists.
 */
export class DefinitionNotFound extends Schema.TaggedError<DefinitionNotFound>()(
  "DefinitionNotFound",
  {
    definitionId: Schema.String,
    version: Schema.optional(Schema.Int),
    message: Schema.String,
  },
) {}

/**
 * `createBoard` was asked for a second board over a repository that already has one (LOB-208): the
 * MVP has one board per repository, and more than one is deferred board customization
 * (docs/board.md, deferred item 8). `boardId` is the board the repository already has, so a retried
 * call can read the answer it was after rather than be left with a bare "no".
 */
export class BoardExists extends Schema.TaggedError<BoardExists>()(
  "BoardExists",
  { repo: Schema.String, boardId: Schema.String, message: Schema.String },
) {}

/**
 * `create` named a repository other than its board's (LOB-255). A card inherits its board's repo
 * (B2) — the default when none is named — so naming another is refused, naming both, and nothing is
 * written: runs on the card would otherwise work in a repository the board is not over.
 */
export class BoardRepoMismatch extends Schema.TaggedError<BoardRepoMismatch>()(
  "BoardRepoMismatch",
  {
    boardId: Schema.String,
    boardRepo: Schema.String,
    repo: Schema.String,
    message: Schema.String,
  },
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

/**
 * `upgradeBoard` expected the board at a version it is no longer pinned to (D5); `actual` is the pin
 * now. Another upgrade moved it first, and the caller's mapping was written against the old pin.
 */
export class StaleBoardVersion extends Schema.TaggedError<StaleBoardVersion>()(
  "StaleBoardVersion",
  {
    boardId: Schema.String,
    expected: Schema.Int,
    actual: Schema.Int,
    message: Schema.String,
  },
) {}

/**
 * `upgradeBoard`'s card migration refused whole (D5): every card that cannot be re-pinned, and why
 * (`CardMigrationProblem`). Nothing was written — not the cards, and not the board's pin either.
 */
export class CardMigrationRefused extends Schema.TaggedError<CardMigrationRefused>()(
  "CardMigrationRefused",
  {
    boardId: Schema.String,
    cards: Schema.Array(CardMigrationProblem),
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

/**
 * A create carried a field the card cannot take (LOB-260): a body or ref over its cap, or a base ref
 * that is not a plain git ref. `field` names it. Checked in the service, not only in the RPC schema,
 * so every in-process caller (a trigger, a sync) is held to it, and a base ref — which every run on
 * the card hands to git — is refused once, at create, rather than failing each run's worktree cut.
 */
export class InvalidTaskInput extends Schema.TaggedError<InvalidTaskInput>()(
  "InvalidTaskInput",
  { field: Schema.String, message: Schema.String },
) {}

/**
 * An authored definition version that cannot be used as written (D4, `./boardDefine`): `field` is
 * the first fault's path into the definition, `problems` every fault. Nothing is written.
 */
export class InvalidDefinition extends Schema.TaggedError<InvalidDefinition>()(
  "InvalidDefinition",
  {
    definitionId: Schema.String,
    field: Schema.String,
    problems: Schema.Array(DefinitionFault),
    message: Schema.String,
  },
) {}

export type TaskError =
  | TaskNotFound
  | BoardNotFound
  | DefinitionNotFound
  | BoardExists
  | BoardRepoMismatch
  | StaleRevision
  | StaleBoardVersion
  | CardMigrationRefused
  | UndeclaredTransition
  | HumanGateRequired
  | RequirementUnmet
  | AlreadyBlocked
  | NotBlocked
  | EmptyComment
  | InvalidTaskInput
  | InvalidDefinition
  | TaskStorageError;

export type CreateTaskInput = {
  readonly boardId: string;
  readonly title: string;
  /** Defaults to the board's repository; any other is `BoardRepoMismatch` (LOB-255). */
  readonly repo?: string;
  readonly priority?: TaskPriorityType;
  /**
   * The card's description, in markdown (LOB-260). Stored verbatim; an empty or all-whitespace body
   * is stored as none, so a card with nothing to say gets no `task_body` prompt section.
   */
  readonly body?: string;
  /**
   * The ref the card's runs cut their worktree from (LOB-260). Blank is none: the repo's default.
   * Trimmed, then held to `isSafeBranchName` (a branch, a tag, `origin/main` or a sha), since every
   * run on the card passes it to git: anything else is `InvalidTaskInput`.
   */
  readonly baseRef?: string;
  /** The tracker issue the card was filed from (LOB-260): a URL or a key. Blank is none. */
  readonly externalRef?: string;
  /**
   * Where a person opens that issue (LOB-254). Blank is none; anything but an absolute `http(s)` URL
   * is `InvalidTaskInput`, since the card pane renders it as a link.
   */
  readonly externalUrl?: string;
  /**
   * The work a local agent hands over with the card (S-local-agent-handoff-mcp, `handoffOf`): a
   * patch of at most `MAX_HANDOFF_PATCH_BYTES`, recorded on the `created` event. Absent: none.
   */
  readonly handoff?: TaskHandoffInput;
  readonly actor: Actor;
};

/**
 * A card filed for an item outside the factory (LOB-254): a create whose `externalRef` is the item's
 * key, and which makes the card only if the board holds none for that key yet.
 */
export type FileTaskInput = CreateTaskInput & { readonly externalRef: string };

/** What `file` did: made the card, or found the one already filed for the same item. */
export type FiledTask = { readonly task: Task; readonly created: boolean };

/**
 * Move a board's pin to a newer version of its definition (D5), and — with `migrateCards`, a column
 * mapping — re-pin its cards to it too. See `UpgradeBoardInput` in `@repo/domain/Task`.
 */
export type UpgradeBoardInput = {
  readonly boardId: string;
  readonly toVersion: number;
  readonly expectedVersion: number;
  readonly migrateCards?: Readonly<Record<string, string>> | undefined;
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

/** A card's title and/or priority (C11); at least one is named. */
export type UpdateTaskInput = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly priority?: TaskPriorityType;
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

/**
 * A run parking its own card on something only a person can fix (S-env-setup): a block by the run
 * itself, with the reason and a note saying what to fix.
 *
 * No expected revision, for the ask's reason: the writer is the run working the card, not a person
 * who read it. A card already blocked keeps the block it has — whatever it waits on was there first,
 * and replacing it would hide it — and is answered as it is.
 */
export type ParkRunInput = {
  readonly taskId: string;
  readonly reason: BlockReasonType;
  readonly note: string;
  readonly actor: Actor;
};

/**
 * A specifying run's spec, as its `spec` tool posts it on the card (LOB-238).
 *
 * Like the ask, no expected revision: the writer is the run working the card, not a person who read
 * it, and the spec lands on whatever revision the card is at. The fields arrive already validated by
 * the harness (LOB-72's `decodeSpec`), which is the one place that may say a value is a spec.
 * `specId` makes the post idempotent: a second post with the same id records nothing.
 */
export type DeclareSpecInput = {
  readonly taskId: string;
  readonly actor: Actor;
  readonly goal: string;
  readonly acceptance: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly openQuestions: ReadonlyArray<string>;
  /**
   * The column the declaring run was started in (its `task_runs.column`), recorded as the spec's
   * column. The harness offers the tool by the run's pinned role, not by where the card is now, so a
   * specifier resumed after a person moved the card on still declares a spec *from specifying*.
   * Absent, the card's current column is recorded.
   */
  readonly column?: string;
  readonly specId?: string;
};

/**
 * What GitHub reported about the card's PR (C20): it merged, or it was closed without being merged.
 * No expected revision, for the ask's reason: the writer is the forge's event, not a person who read
 * the card, and it lands on whatever revision the card is at.
 */
export type SettlePullRequestInput = {
  readonly taskId: string;
  readonly outcome: "merged" | "closed";
  /** The PR by its page (`html_url`), which the actor and the block's note name. */
  readonly pr: { readonly number: number; readonly url: string };
};

/** What `settlePullRequest` did: the card as it is now, and whether this call changed it. */
export type SettledPullRequest = {
  readonly task: Task;
  readonly changed: boolean;
};

/** The actor a merge's move records (C20): the merge itself, naming the PR by its page. */
export const mergeActor = (prUrl: string): Actor => `merge:${prUrl}`;

/** The actor an unmerged close's block records (C20), naming the PR by its page. */
export const closeActor = (prUrl: string): Actor => `pr-closed:${prUrl}`;

/** A planning run's plan, as its `plan` tool posts it on the card (D10); `DeclareSpecInput`'s shape. */
export type DeclarePlanInput = {
  readonly taskId: string;
  readonly actor: Actor;
  readonly summary: string;
  readonly steps: ReadonlyArray<string>;
  readonly surfaces: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  /** The column the declaring run was started in; absent, the card's current column. */
  readonly column?: string;
  readonly planId?: string;
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
  /**
   * A new board over a named definition (B2, LOB-208), pinned to the version the caller names or, by
   * default, the definition's newest. An unknown definition or version is `DefinitionNotFound`; a
   * repository that already has a board is `BoardExists`, naming it (one board per repository). A
   * repository with no local checkout registered still gets its board, with a `warning` (LOB-263).
   */
  readonly createBoard: (
    input: CreateBoardInput,
  ) => Effect.Effect<CreatedBoard, TaskError>;
  /** Every definition, ordered by id, with its versions oldest first (LOB-270). */
  readonly listDefinitions: Effect.Effect<
    ReadonlyArray<DefinitionSummary>,
    TaskError
  >;
  /**
   * One definition version as its row declares it (LOB-270): the one named, or by default the
   * newest — the version `createBoard` would pin. An unknown id or version is `DefinitionNotFound`.
   */
  readonly getDefinition: (
    definitionId: string,
    version?: number,
  ) => Effect.Effect<BoardDefinition, TaskError>;
  /**
   * A new version of a definition, authored (D4): written as the id's newest version + 1 (1 for an id
   * the factory does not hold), never over a row that exists (B2). Content identical to the newest
   * version writes nothing and answers that version (`unchanged`); a dry run validates and answers
   * the version it would write (`validated`). A version the rules refuse (`./boardDefine`, against
   * `library`'s skills and roles, plus the roles the definitions held already declare) is
   * `InvalidDefinition`, naming the field, and nothing is written.
   */
  readonly defineBoard: (
    input: DefineBoardInput,
    library: DefinitionLibrary,
  ) => Effect.Effect<
    {
      readonly outcome: DefinedBoard["outcome"];
      readonly definition: BoardDefinition;
    },
    TaskError
  >;
  /**
   * Every role a definition version the factory holds declares on a column (D6), whichever version:
   * the roles `defineBoard` accepts as known beside the harness's own and the deployment's table, so
   * an editor can offer them. A row whose `columns` is not an array contributes nothing.
   */
  readonly declaredRoles: Effect.Effect<ReadonlySet<string>, TaskError>;
  /**
   * Move a board to a newer version of its definition (D5), at the version the caller expected it
   * pinned to (`StaleBoardVersion` otherwise). New cards pin the new version; existing cards keep
   * theirs unless `migrateCards` maps their columns, which re-pins every card not already on it — all
   * of them or, when one has an unfinished run or a column the mapping does not take, none
   * (`CardMigrationRefused`, naming each), and then the pin does not move either.
   */
  readonly upgradeBoard: (
    input: UpgradeBoardInput,
  ) => Effect.Effect<UpgradedBoard, TaskError>;
  readonly create: (input: CreateTaskInput) => Effect.Effect<Task, TaskError>;
  /**
   * Make a card for an outside item unless the board already has one for it (LOB-254): the door a
   * trigger delivery comes through. Keyed by `externalRef`, so a second delivery about the same issue
   * answers the first's card with `created: false`.
   */
  readonly file: (input: FileTaskInput) => Effect.Effect<FiledTask, TaskError>;
  readonly get: (taskId: string) => Effect.Effect<Task, TaskError>;
  readonly list: (
    input: ListTasksInput,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskError>;
  /**
   * A board's cards in `list`'s order, each with its runs' newest status, PR link and summed spend
   * (C10): three reads over the board's runs however many cards it has, so a lane's faces never cost
   * a read per card.
   */
  readonly listCards: (
    input: ListTasksInput,
  ) => Effect.Effect<ReadonlyArray<BoardCard>, TaskError>;
  readonly move: (input: MoveTaskInput) => Effect.Effect<Task, TaskError>;
  readonly block: (input: BlockTaskInput) => Effect.Effect<Task, TaskError>;
  readonly unblock: (input: UnblockTaskInput) => Effect.Effect<Task, TaskError>;
  /**
   * Fix a card's title and/or priority (C11), revision-checked: a blank or over-long title, or a call
   * naming neither field, is `InvalidTaskInput`. A value the card already has changes nothing — no
   * revision, no event. Otherwise the revision moves on by one and each changed field writes its
   * event (`retitled`, `priorityChanged`) at the revision the call expected.
   */
  readonly update: (input: UpdateTaskInput) => Effect.Effect<Task, TaskError>;
  /** A run's question: a `question` comment and a `needs_input` block from the card's column. */
  readonly ask: (input: AskTaskInput) => Effect.Effect<Task, TaskError>;
  /** A run's own block of its card (`ParkRunInput`): a card already blocked keeps its block. */
  readonly parkRun: (input: ParkRunInput) => Effect.Effect<Task, TaskError>;
  /**
   * Settle the card on what GitHub reported about its PR (C20), exactly once however often it is
   * reported. A merge moves the card to `done` from whichever column it is in, recorded as a `moved`
   * event by `mergeActor`, and lifts any block it holds (an `unblocked` event first): the work is on
   * the base, so the merge is the completion the merge gate stands for, not a move the card's exit
   * requirements could refuse. An unmerged close blocks the card `pr_closed`, its note naming the PR,
   * once per PR: a close of a PR that already blocked the card once (its `blocked` event by
   * `closeActor`) leaves it as it is, so a person's unblock stands against the PR-state read that
   * reports the same close on every read. A card already finished (`done`, `canceled`), a close on a
   * card already blocked, and a merge on a card whose pinned definition declares no `done` column
   * change nothing (`changed: false`).
   */
  readonly settlePullRequest: (
    input: SettlePullRequestInput,
  ) => Effect.Effect<SettledPullRequest, TaskError>;
  /** A comment; from a person on a card blocked `needs_input`, the answer that lifts the block. */
  readonly comment: (input: CommentTaskInput) => Effect.Effect<Task, TaskError>;
  /** The card's thread, oldest first: every `commented` event, verbatim. */
  readonly comments: (
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<TaskComment>, TaskError>;
  /**
   * A specifying run's spec, recorded on the card as a `specified` event (LOB-238). The card's
   * revision moves on by one, and a card blocked for any reason stays blocked: a spec is not an
   * answer, and the gaps it declares are the ask's to raise.
   */
  readonly declareSpec: (
    input: DeclareSpecInput,
  ) => Effect.Effect<Task, TaskError>;
  /** The card's spec: its newest `specified` event, or `undefined` when no run declared one. */
  readonly spec: (
    taskId: string,
  ) => Effect.Effect<TaskSpec | undefined, TaskError>;
  /**
   * A planning run's plan, recorded on the card as a `planned` event (D10): what `plan_doc` is met
   * by, and what a person reads before the plan approval. The card's revision moves on by one, a
   * blocked card stays blocked, and a replayed post (the same `planId`) writes nothing.
   */
  readonly declarePlan: (
    input: DeclarePlanInput,
  ) => Effect.Effect<Task, TaskError>;
  /** The card's plan: its newest `planned` event, or `undefined` when no run declared one. */
  readonly plan: (
    taskId: string,
  ) => Effect.Effect<TaskPlan | undefined, TaskError>;
  /**
   * The work a local agent handed off with the card (S-local-agent-handoff-mcp): the patch its
   * `created` event carries, or `undefined` for a card made without one. An unknown card is
   * `TaskNotFound`.
   */
  readonly handoff: (
    taskId: string,
  ) => Effect.Effect<TaskHandoff | undefined, TaskError>;
  /**
   * What the card needs to leave its column, judged now (D9): the column's whole `requires[]`
   * under the card's pinned definition, each key met, unmet with the reason `move` would refuse
   * with, or not checked. An unknown card is `TaskNotFound`.
   */
  readonly exit: (taskId: string) => Effect.Effect<TaskExit, TaskError>;
  /**
   * The card as its `task_events` say it is (LOB-260, `./taskProjection`): the history folded,
   * oldest first. An unknown card is `TaskNotFound`; a history that does not start with `created`,
   * or holds an event that does not decode, is `TaskStorageError`.
   */
  readonly replay: (taskId: string) => Effect.Effect<TaskProjection, TaskError>;
  /** A card's runs, newest first (LOB-76). An unknown card is `TaskNotFound`, not an empty list. */
  readonly listRuns: (
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<TaskRun>, TaskError>;
  /**
   * What needs a person (LOB-77), on one board or every board: pending approvals on a card's runs,
   * cards blocked `needs_input`, and cards whose done run waits at a human gate. An unknown board is
   * `BoardNotFound`.
   */
  readonly attention: (
    boardId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<AttentionItem>, TaskError>;
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
  readonly body: string;
  readonly baseRef: string | null;
  readonly externalRef: string | null;
  readonly externalUrl: string | null;
  readonly blockedReason: string | null;
  readonly blockedColumn: string | null;
  readonly blockedNote: string | null;
  readonly blockedSince: Date | string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

/** One `board_instances` row, read through `BOARD_INSTANCE_COLUMNS`. */
type BoardInstanceRow = {
  readonly id: string;
  readonly repo: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly createdAt: Date | string;
};

/** The instance columns under the names `BoardInstance` decodes, for `listBoards` and `createBoard`. */
const BOARD_INSTANCE_COLUMNS = [
  "id",
  "repo",
  `definition_id AS "definitionId"`,
  `definition_version AS "definitionVersion"`,
  `created_at AS "createdAt"`,
].join(", ");

/** The column list, spelled out once so every read returns the same shape. */
const TASK_COLUMN_NAMES = [
  "id",
  "board_id",
  "title",
  `"column"`,
  "repo",
  "definition_version",
  "revision",
  "priority",
  "body",
  "base_ref",
  "external_ref",
  "external_url",
  "blocked_reason",
  "blocked_column",
  "blocked_note",
  "blocked_since",
  "created_at",
  "updated_at",
];
/**
 * The list a read selects, `table` qualifying every column. A card made before cards carried a
 * repository reads back with its board's (LOB-255), the same one `SessionService` binds its runs
 * to, so the card and its runs never disagree about where the work is.
 */
const taskColumns = (table: string): string =>
  TASK_COLUMN_NAMES.map((name) =>
    name === "repo"
      ? `COALESCE(${table}.repo, (SELECT b.repo FROM board_instances b WHERE b.id = ${table}.board_id)) AS repo`
      : `${table}.${name}`,
  ).join(", ");
const TASK_COLUMNS = taskColumns("tasks");

/** The same list qualified by `t.`, for a read that joins `tasks` to tables sharing column names. */
const TASK_COLUMNS_T = taskColumns("t");

/**
 * One run of a card as the exit checks read it (`cardEvidence`): its session, and the branch binding
 * the session's index row and its repository's registration give it. `indexed` is null when the
 * session has no row at all, which a deleted session leaves behind.
 */
type RunRow = {
  readonly sessionId: string;
  /** The column the run was started in (`task_runs.column`). */
  readonly column: string;
  readonly indexed: string | null;
  readonly repo: string | null;
  readonly baseRef: string | null;
  readonly branch: string | null;
  readonly localPath: string | null;
};

/**
 * What `move` judged about the card's exit before locking it, at the caller's expected revision: the
 * first unmet requirement, if any.
 */
type ExitJudgement = {
  readonly unmet: RequirementUnmet | undefined;
  /**
   * The card's pinned definition version as the judgement read it, which decides its moves; absent
   * when the read found no card, which the transaction then refuses as `TaskNotFound`.
   */
  readonly definition?: DefinitionMoves;
};

const iso = (value: Date | string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

/** A create's optional text, or `undefined` when it is absent or says nothing but whitespace. */
const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

/**
 * A create's body, base ref and external ref as the card stores them (LOB-260), or the first field
 * it cannot take. The body is kept verbatim; the refs are trimmed, since a ref or a key never means
 * its surrounding whitespace. The caps are the domain schema's, so an in-process caller is held to
 * what the RPC decode already enforces.
 */
export const cardText = (input: {
  readonly body?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly externalRef?: string | undefined;
  readonly externalUrl?: string | undefined;
}): Effect.Effect<
  {
    readonly body: string | undefined;
    readonly baseRef: string | undefined;
    readonly externalRef: string | undefined;
    readonly externalUrl: string | undefined;
  },
  InvalidTaskInput
> =>
  Effect.gen(function* () {
    const body = present(input.body);
    const baseRef = present(input.baseRef)?.trim();
    const externalRef = present(input.externalRef)?.trim();
    const externalUrl = present(input.externalUrl)?.trim();
    if (body !== undefined && body.length > MAX_TASK_BODY_CHARS) {
      return yield* new InvalidTaskInput({
        field: "body",
        message: `a card's body takes at most ${MAX_TASK_BODY_CHARS} characters; this one has ${body.length}`,
      });
    }
    for (const [field, value] of [
      ["baseRef", baseRef],
      ["externalRef", externalRef],
      ["externalUrl", externalUrl],
    ] as const) {
      if (value !== undefined && value.length > MAX_TASK_REF_CHARS) {
        return yield* new InvalidTaskInput({
          field,
          message: `a card's ${field} takes at most ${MAX_TASK_REF_CHARS} characters; this one has ${value.length}`,
        });
      }
    }
    if (baseRef !== undefined && !isSafeBranchName(baseRef)) {
      return yield* new InvalidTaskInput({
        field: "baseRef",
        message: `"${baseRef}" is not a base ref a run can start from: name a branch, a tag or a commit (letters, digits, '.', '_', '-' and '/', no '..')`,
      });
    }
    if (externalUrl !== undefined && !isWebLink(externalUrl)) {
      return yield* new InvalidTaskInput({
        field: "externalUrl",
        message: `"${externalUrl}" is not a link a card can carry: name an absolute http(s) URL`,
      });
    }
    return { body, baseRef, externalRef, externalUrl };
  });

/**
 * A create's handoff, checked (S-local-agent-handoff-mcp): a patch that is a git diff, within
 * `MAX_HANDOFF_PATCH_BYTES` once JSON-escaped. The cap is the CLI's too, which measures before it
 * sends, so a caller that skipped it is refused in the same words. A blank patch is no handoff —
 * there is nothing to apply — and is refused rather than stored as a card that claims one.
 */
export const handoffOf = (
  handoff: TaskHandoffInput | undefined,
): Effect.Effect<TaskHandoffInput | undefined, InvalidTaskInput> =>
  Effect.gen(function* () {
    if (handoff === undefined) return undefined;
    // Counted as the request carried it (`handoffPatchWireBytes`), so a patch the cap lets through
    // is one the API's request limit lets through too.
    const bytes = handoffPatchWireBytes(handoff.patch);
    if (bytes > MAX_HANDOFF_PATCH_BYTES) {
      return yield* new InvalidTaskInput({
        field: "handoff.patch",
        message: handoffCapRefusal(bytes),
      });
    }
    // A credential's shape in a line the patch adds is refused before the patch is stored: the
    // `created` event keeps it, `getTaskHandoff` serves it, and a run commits it — a stray unignored
    // `.env.local` the checkout swept in would otherwise leave the machine with the card. The shapes
    // are the pre-push scan's (S-agent-secrets); no line opts out, since no base vouches for it here.
    const findings = scanAddedLines(parseAddedLines(handoff.patch), []);
    if (findings.length > 0) {
      const named = findings
        .slice(0, 5)
        .map((finding) => `${finding.path}:${finding.line} (${finding.name})`)
        .join(", ");
      return yield* new InvalidTaskInput({
        field: "handoff.patch",
        message: `the handoff patch adds what looks like a credential at ${named}${findings.length > 5 ? ` and ${findings.length - 5} more` : ""}: take it out of the work (or leave an untracked file out with --tracked-only) and hand off again`,
      });
    }
    if (handoffPatchFiles(handoff.patch).length === 0) {
      return yield* new InvalidTaskInput({
        field: "handoff.patch",
        message:
          "the handoff patch changes no file: it is not a `git diff` (no `diff --git` header), so there is nothing for a run to apply",
      });
    }
    const branch = present(handoff.branch)?.trim();
    return {
      patch: handoff.patch,
      ...(branch === undefined ? {} : { branch }),
      ...(handoff.baseCommit === undefined
        ? {}
        : { baseCommit: handoff.baseCommit }),
    };
  });

/**
 * `board_definitions.initial_column` as `BoardDefinition` carries it: absent, not `null`, for a
 * version written before the column existed (0026), which starts a card in its first column.
 */
const initialColumnField = (
  initialColumn: string | null,
): { readonly initialColumn?: string } =>
  initialColumn === null ? {} : { initialColumn };

/**
 * `board_definitions.caps` (0038, LOB-71) as `BoardDefinition` carries it: absent, not `null`, for a
 * version written before the column existed, which caps nothing. Read as the driver parses JSONB and
 * decoded with the rest of the definition, so a malformed value is the definition's decode failure.
 */
const capsField = (caps: unknown): { readonly caps?: unknown } =>
  caps === null || caps === undefined ? {} : { caps };

/**
 * A definition version's content as one string, for `defineBoard`'s "identical" (D4): object keys
 * sorted and absent fields dropped, so a row read back from JSONB (which stores keys in its own order)
 * and a file written in any key order compare equal exactly when they declare the same thing.
 * Array order is kept — the order of columns, moves, requirements and skills is meaning.
 */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : field,
  );

/** What `defineBoard` compares: everything a version declares but its id and its version number. */
const definitionContent = (definition: {
  readonly name: string;
  readonly columns: ReadonlyArray<BoardColumn>;
  readonly initialColumn?: string | undefined;
  readonly caps?: BoardCaps | undefined;
}): string =>
  canonicalJson({
    name: definition.name,
    columns: definition.columns,
    initialColumn: definition.initialColumn,
    caps: definition.caps,
  });

/**
 * Merge two lists each already in the order `session_approvals` is read in (oldest request first,
 * then session, then request id) into one, without reordering either. `key` is the request time at
 * microsecond precision, as the database orders it: the `requestedAt` an item carries is cut to
 * milliseconds, so comparing that would reorder rows the database keeps apart. A tie takes the left
 * list's row first, and the two lists never share a session.
 */
const mergeByRequest = <A>(
  left: ReadonlyArray<readonly [key: string, item: A]>,
  right: ReadonlyArray<readonly [key: string, item: A]>,
): Array<A> => {
  const merged: Array<A> = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const l = left[i];
    const r = right[j];
    if (l !== undefined && (r === undefined || l[0] <= r[0])) {
      merged.push(l[1]);
      i += 1;
    } else if (r !== undefined) {
      merged.push(r[1]);
      j += 1;
    }
  }
  return merged;
};

export const TaskServiceLive = Layer.effect(
  TaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const decodeTask = Schema.decodeUnknownEffect(Task);
    const decodeBoard = Schema.decodeUnknownEffect(BoardView);
    const decodeInstance = Schema.decodeUnknownEffect(BoardInstance);
    const decodeDefinition = Schema.decodeUnknownEffect(BoardDefinition);
    const decodeDefinitionSummary =
      Schema.decodeUnknownEffect(DefinitionSummary);
    const decodeColumnsJson = Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(BoardColumn)),
    );
    /**
     * A definition row's column set. `board_definitions.columns` is unconstrained JSONB (0007), so a
     * set `BoardColumn` rejects is a storage fault naming the row, not a column set to guess at.
     */
    const readColumns = (text: string, what: string) =>
      decodeColumnsJson(text).pipe(
        Effect.mapError(
          (cause) =>
            new TaskStorageError({
              message: `${what} holds an invalid column set: ${String(cause)}`,
            }),
        ),
      );
    const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(TaskEvent));
    const encodeColumnsJson = Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(BoardColumn)),
    );
    const encodeCapsJson = Schema.encodeEffect(
      Schema.fromJsonString(BoardCaps),
    );

    const toInstance = (
      row: BoardInstanceRow,
    ): Effect.Effect<BoardInstance, TaskStorageError> =>
      decodeInstance({ ...row, createdAt: iso(row.createdAt) }).pipe(
        Effect.mapError(
          (cause) =>
            new TaskStorageError({
              message: `board ${row.id} does not decode: ${String(cause)}`,
            }),
        ),
      );

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
        ...(row.body === "" ? {} : { body: row.body }),
        ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
        ...(row.externalRef === null ? {} : { externalRef: row.externalRef }),
        ...(row.externalUrl === null ? {} : { externalUrl: row.externalUrl }),
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
    /**
     * The warning a board over this repository carries (LOB-263): `undefined` when the registry
     * holds a `local_path` for it, the sentence naming the fix when it does not — a repository no
     * run has named yet has no row at all, which is the same thing: no checkout. Read from the table,
     * never the disk, as the rest of this service is: whether the path is still a git work tree is
     * `listRepos`'s read, and a run that meets a stale one fails loudly at its worktree.
     */
    const checkoutWarningFor = (
      repo: string,
    ): Effect.Effect<string | undefined, SqlError> =>
      sql<{ localPath: string | null }>`
        SELECT local_path AS "localPath" FROM repos WHERE slug = ${repo}
      `.pipe(
        Effect.map((rows) =>
          rows[0]?.localPath == null ? noCheckoutWarning(repo) : undefined,
        ),
      );

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
            initialColumn: string | null;
            caps: unknown;
          }>`
            SELECT bi.repo,
                   bi.definition_id AS "definitionId",
                   bi.definition_version AS "definitionVersion",
                   bi.created_at AS "createdAt",
                   bd.name,
                   bd.columns::text AS columns,
                   bd.initial_column,
                   bd.caps
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
          const columns = yield* readColumns(row.columns, `board ${boardId}`);
          const warning = yield* checkoutWarningFor(row.repo);
          return yield* decodeBoard({
            ...(warning === undefined ? {} : { warning }),
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
              ...initialColumnField(row.initialColumn),
              ...capsField(row.caps),
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
        const rows = yield* sql<BoardInstanceRow>`
            SELECT ${sql.literal(BOARD_INSTANCE_COLUMNS)}
            FROM board_instances
            ORDER BY created_at DESC, id DESC
            LIMIT ${LIST_BOARDS_LIMIT}
          `;
        return yield* Effect.forEach(rows, toInstance);
      }),
    );

    /**
     * The one writer of `board_instances` (LOB-208): an instance over `definitionId`, at the version
     * named or the newest one, for a repository that has no board yet.
     *
     * One board per repository (docs/board.md, deferred item 8): the transaction takes an advisory
     * lock on the repository before it looks, so two concurrent creates for one repo cannot both see
     * none and both insert — the second waits, then finds the first's board and is `BoardExists`.
     *
     * The insert is one `INSERT … SELECT` over the definition's own rows, so the version the board
     * pins is the version that exists at the moment of the insert — there is no read-then-write
     * window in which "the newest" could be a row the insert then fails to reference. No row selected
     * is the refusal: the definition, or that version of it, is not in the factory's database (B2).
     */
    const createBoard = (
      input: CreateBoardInput,
    ): Effect.Effect<CreatedBoard, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              SELECT pg_advisory_xact_lock(hashtext(${`board_instances:${input.repo}`}))
            `;
            const existing = yield* sql<{ id: string }>`
              SELECT id FROM board_instances
              WHERE repo = ${input.repo}
              ORDER BY created_at, id
              LIMIT 1
            `;
            const found = existing[0];
            if (found !== undefined) {
              return yield* new BoardExists({
                repo: input.repo,
                boardId: found.id,
                message: `repository ${input.repo} already has board ${found.id}`,
              });
            }
            const id = yield* mintBoardId;
            const rows =
              input.definitionVersion === undefined
                ? yield* sql<BoardInstanceRow>`
                    INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    SELECT ${id}, ${input.repo}, bd.id, bd.version
                    FROM board_definitions bd
                    WHERE bd.id = ${input.definitionId}
                    ORDER BY bd.version DESC
                    LIMIT 1
                    RETURNING ${sql.literal(BOARD_INSTANCE_COLUMNS)}
                  `
                : yield* sql<BoardInstanceRow>`
                    INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    SELECT ${id}, ${input.repo}, bd.id, bd.version
                    FROM board_definitions bd
                    WHERE bd.id = ${input.definitionId}
                      AND bd.version = ${input.definitionVersion}
                    RETURNING ${sql.literal(BOARD_INSTANCE_COLUMNS)}
                  `;
            const row = rows[0];
            if (row === undefined) {
              return yield* input.definitionVersion === undefined
                ? new DefinitionNotFound({
                    definitionId: input.definitionId,
                    message: `no board definition ${input.definitionId}`,
                  })
                : new DefinitionNotFound({
                    definitionId: input.definitionId,
                    version: input.definitionVersion,
                    message: `board definition ${input.definitionId} has no version ${input.definitionVersion}`,
                  });
            }
            const warning = yield* checkoutWarningFor(row.repo);
            return {
              ...(yield* toInstance(row)),
              ...(warning === undefined ? {} : { warning }),
            };
          }),
        ),
      );

    /**
     * Every definition and its versions (LOB-270), from the rows' own columns — never their column
     * sets, which the list does not answer. Ordered by id (byte order, so the answer does not depend
     * on the server's collation), then version, so the grouping below sees each definition's rows
     * together and oldest first.
     */
    const listDefinitions: Effect.Effect<
      ReadonlyArray<DefinitionSummary>,
      TaskError
    > = withStorage(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          version: number;
          name: string;
          createdAt: Date | string;
        }>`
          SELECT id, version, name, created_at AS "createdAt"
          FROM board_definitions
          ORDER BY id COLLATE "C", version
        `;
        const grouped: Array<{
          id: string;
          versions: Array<{ version: number; name: string; createdAt: string }>;
        }> = [];
        for (const row of rows) {
          const version = {
            version: row.version,
            name: row.name,
            createdAt: iso(row.createdAt),
          };
          const last = grouped.at(-1);
          if (last !== undefined && last.id === row.id) {
            last.versions.push(version);
          } else {
            grouped.push({ id: row.id, versions: [version] });
          }
        }
        // A row that does not decode (an id outside `DefinitionId`, which the table does not check)
        // is a storage fault, and fails the whole list rather than hiding a definition: a list that
        // silently skips one would read as "it does not exist". The error names the row's id, so an
        // operator can find it.
        return yield* Effect.forEach(grouped, (definition) =>
          decodeDefinitionSummary(definition).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `board definition ${JSON.stringify(definition.id)} does not decode: ${String(cause)}`,
                }),
            ),
          ),
        );
      }),
    );

    /**
     * One definition version (LOB-270): the one named, or the newest. The refusal is `createBoard`'s,
     * in the same words, so "no such definition" reads the same whichever call met it.
     */
    const getDefinition = (
      definitionId: string,
      version?: number,
    ): Effect.Effect<BoardDefinition, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          type DefinitionRow = {
            version: number;
            name: string;
            columns: string;
            initialColumn: string | null;
            caps: unknown;
          };
          const rows =
            version === undefined
              ? yield* sql<DefinitionRow>`
                  SELECT version, name, columns::text AS columns, initial_column, caps
                  FROM board_definitions
                  WHERE id = ${definitionId}
                  ORDER BY version DESC
                  LIMIT 1
                `
              : yield* sql<DefinitionRow>`
                  SELECT version, name, columns::text AS columns, initial_column, caps
                  FROM board_definitions
                  WHERE id = ${definitionId} AND version = ${version}
                `;
          const row = rows[0];
          if (row === undefined) {
            return yield* version === undefined
              ? new DefinitionNotFound({
                  definitionId,
                  message: `no board definition ${definitionId}`,
                })
              : new DefinitionNotFound({
                  definitionId,
                  version,
                  message: `board definition ${definitionId} has no version ${version}`,
                });
          }
          const what = `board definition ${definitionId} v${row.version}`;
          const columns = yield* readColumns(row.columns, what);
          return yield* decodeDefinition({
            id: definitionId,
            version: row.version,
            name: row.name,
            columns,
            ...initialColumnField(row.initialColumn),
            ...capsField(row.caps),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `${what} does not decode: ${String(cause)}`,
                }),
            ),
          );
        }),
      );

    // A row whose `columns` is not an array (0007 leaves it unconstrained) contributes nothing
    // rather than failing the read.
    const declaredRoles: Effect.Effect<
      ReadonlySet<string>,
      TaskError
    > = withStorage(
      sql<{ readonly role: string }>`
          SELECT DISTINCT c ->> 'role' AS role
          FROM board_definitions d
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(d.columns) = 'array' THEN d.columns ELSE '[]'::jsonb END
          ) AS c
          WHERE jsonb_typeof(c) = 'object' AND c ->> 'role' IS NOT NULL
        `,
    ).pipe(Effect.map((rows) => new Set(rows.map((row) => row.role))));

    /**
     * A new version of a definition (D4). The rules come first and touch nothing (`./boardDefine`);
     * then one transaction takes an advisory lock on the definition's id, reads its newest version and
     * either answers it (the same content: `unchanged`), answers the version a write would take (a
     * dry run: `validated`), or inserts newest + 1. The lock is what makes "newest + 1" safe: two
     * concurrent defines of one id are serialised, so the second reads the first's version as the
     * newest and takes the next one, rather than meeting the primary key. Nothing here updates a row
     * — a board pinned to an older version keeps reading exactly what it pinned (B2).
     */
    const defineBoard = (
      input: DefineBoardInput,
      library: DefinitionLibrary,
    ): Effect.Effect<
      {
        readonly outcome: DefinedBoard["outcome"];
        readonly definition: BoardDefinition;
      },
      TaskError
    > =>
      Effect.gen(function* () {
        const { dryRun, ...authored } = input;
        // The roles the definitions the factory holds already declare are accepted as known (the
        // default pipeline's `planner` and `builder` among them): `ROLE_MODELS` is a partial override
        // table, so re-authoring a version under one that names only `reviewer` must not be refused
        // for the roles the version it replaces runs with today.
        const declared = yield* declaredRoles;
        const knownRoles: ReadonlySet<string> = new Set([
          ...(library.knownRoles ?? HARNESS_ROLES),
          ...declared,
        ]);
        const faults = authoredDefinitionFaults(authored, {
          ...library,
          knownRoles,
        });
        const first = faults[0];
        if (first !== undefined) {
          return yield* new InvalidDefinition({
            definitionId: input.id,
            field: first.field,
            problems: faults,
            message: `definition ${input.id}: ${first.field}: ${first.message}${faults.length > 1 ? ` (and ${faults.length - 1} more)` : ""}`,
          });
        }
        const encodedColumns = yield* encodeColumnsJson(authored.columns);
        const encodedCaps =
          authored.caps === undefined
            ? null
            : yield* encodeCapsJson(authored.caps);
        return yield* withStorage(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                SELECT pg_advisory_xact_lock(hashtext(${`board_definitions:${input.id}`}))
              `;
              const newest = yield* getDefinition(input.id).pipe(
                Effect.map(Option.some),
                Effect.catchTag("DefinitionNotFound", () => Effect.succeedNone),
              );
              if (
                Option.isSome(newest) &&
                definitionContent(newest.value) === definitionContent(authored)
              ) {
                return {
                  outcome: "unchanged" as const,
                  definition: newest.value,
                };
              }
              const version = Option.match(newest, {
                onNone: () => 1,
                onSome: (definition) => definition.version + 1,
              });
              if (dryRun === true) {
                return {
                  outcome: "validated" as const,
                  definition: {
                    ...authored,
                    version,
                  } satisfies BoardDefinition,
                };
              }
              yield* sql`
                INSERT INTO board_definitions (id, version, name, columns, initial_column, caps)
                VALUES (
                  ${input.id}, ${version}, ${authored.name}, ${encodedColumns}::jsonb,
                  ${authored.initialColumn ?? null}, ${encodedCaps}::jsonb
                )
              `;
              // Read back through the one decoder every reader uses, so the answer is the row as
              // `getDefinition` and a board pinned to it will read it — not the input echoed.
              return {
                outcome: "created" as const,
                definition: yield* getDefinition(input.id, version),
              };
            }),
          ),
        );
      }).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TaskStorageError({
              message: `definition ${input.id} does not encode: ${String(cause)}`,
            }),
          ),
        ),
      );

    /**
     * Move a board's pin to a newer version of its definition, and with `migrateCards` its cards too
     * (D5) — the one writer that updates a `board_instances` row or a card's pinned version.
     *
     * One transaction. The instance row is locked first (`FOR NO KEY UPDATE`), so two upgrades of one
     * board are serialised and the second meets the first's pin as `StaleBoardVersion`, and a card
     * being made on the board (`insertCard` reads its board `FOR SHARE`) either commits at the old pin
     * before this reads the board's cards, or waits and starts at the new one: no card is made at the
     * old pin after a migration has read the cards it re-pins. The refusals that need no card come
     * next — a version that is not newer, one the definition does not hold, one that cannot start a
     * card, a mapping onto a column the version lacks or of a column it still declares onto another (a
     * move, not a re-pin), a run's actor — and then, for a migration, the cards: under the
     * repository's `task_runs` advisory lock, which every run start on a card takes while it writes its
     * run (`checkRunCaps`), so no run starts on a card between the check that it has none unfinished
     * and its re-pin, and a start that waited on the lock resolves its column again once it holds it
     * (`withRunAdmitted`), refusing rather than writing a run in a column of the old pin. Every card is judged before any is written, and one that cannot move refuses the
     * batch, naming every such card; only then is anything written — the pin, each card's row at its
     * next revision, and one `repinned` event per card at the revision it was read at.
     *
     * A run is unfinished from its start until its session first goes idle (`task_runs.finished_at`,
     * as the caps count it), unless its workspace was released first; a run whose session row is gone
     * is counted as unfinished, since nothing says it ended. Its column, prompt and policy were resolved
     * from the version the card pins, so re-pinning under it would change what the run is held to.
     */
    const upgradeBoard = (
      input: UpgradeBoardInput,
    ): Effect.Effect<UpgradedBoard, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const boards = yield* sql<BoardInstanceRow>`
              SELECT ${sql.literal(BOARD_INSTANCE_COLUMNS)} FROM board_instances
              WHERE id = ${input.boardId}
              FOR NO KEY UPDATE
            `;
            const board = boards[0];
            if (board === undefined) {
              return yield* new BoardNotFound({
                boardId: input.boardId,
                message: `no board ${input.boardId}`,
              });
            }
            const pinned = `${board.definitionId} v${board.definitionVersion}`;
            if (board.definitionVersion !== input.expectedVersion) {
              return yield* new StaleBoardVersion({
                boardId: board.id,
                expected: input.expectedVersion,
                actual: board.definitionVersion,
                message: `board ${board.id} is pinned to ${pinned}, not v${input.expectedVersion}: someone upgraded it first`,
              });
            }
            // A person's write, never a run's: an upgrade changes the moves and exits every card on
            // the board is held to, which a run of one of them must not do to its own (as a move
            // across a human gate is refused one, `move`).
            if (isRunActor(input.actor)) {
              return yield* new InvalidTaskInput({
                field: "actor",
                message: `${input.actor} is a run: only a person upgrades a board`,
              });
            }
            const mapping = input.migrateCards;
            if (
              input.toVersion < board.definitionVersion ||
              (input.toVersion === board.definitionVersion &&
                mapping === undefined)
            ) {
              return yield* new InvalidTaskInput({
                field: "toVersion",
                message: `board ${board.id} is pinned to ${pinned}: an upgrade names a newer version, or v${board.definitionVersion} itself with migrateCards to re-pin the cards an earlier upgrade left behind`,
              });
            }
            const target = yield* getDefinition(
              board.definitionId,
              input.toVersion,
            );
            const targetName = `${board.definitionId} v${target.version}`;
            // The version every card made from now on starts under: held to what `insertCard` holds
            // it to, so an upgrade never leaves a board on which no card can be made (LOB-267).
            const faults = definitionProblems(target);
            if (faults.length > 0 || initialColumnOf(target) === undefined) {
              return yield* new InvalidTaskInput({
                field: "toVersion",
                message: `${targetName} cannot start a card: ${faults.join("; ")}`,
              });
            }
            const repinned: Array<UpgradedBoard["repinned"][number]> = [];
            if (mapping !== undefined) {
              for (const [from, to] of Object.entries(mapping)) {
                if (!target.columns.some((column) => column.name === to)) {
                  return yield* new InvalidTaskInput({
                    field: `migrateCards.${from}`,
                    message: `the mapping sends ${from} to "${to}", which ${targetName} does not declare`,
                  });
                }
                // A column the target still declares keeps its cards: sending them on to another
                // is a move, and a move is made past the exit requirements and gates between the
                // two (`move`), not around them by a re-pin. Only a column the target no longer
                // declares — renamed or dropped — is mapped elsewhere.
                if (
                  to !== from &&
                  target.columns.some((column) => column.name === from)
                ) {
                  return yield* new InvalidTaskInput({
                    field: `migrateCards.${from}`,
                    message: `the mapping sends ${from} to "${to}", but ${targetName} still declares ${from}: a migration keeps a card in a column the version declares, and moving it on to ${to} is a move, past the column's exit`,
                  });
                }
              }
              yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`task_runs:${board.repo}`}))`;
              const cards = yield* sql<{
                id: string;
                column: string;
                blockedColumn: string | null;
                definitionVersion: number;
                revision: number;
                columns: string;
                unfinished: boolean;
              }>`
                SELECT t.id, t."column", t.blocked_column, t.definition_version, t.revision,
                       bd.columns::text AS columns,
                       EXISTS (
                         SELECT 1 FROM task_runs tr
                         LEFT JOIN sessions s ON s.id = tr.session_id
                         WHERE tr.task_id = t.id
                           AND tr.finished_at IS NULL
                           AND s.workspace_released_at IS NULL
                       ) AS unfinished
                FROM tasks t
                JOIN board_definitions bd
                  ON bd.id = ${board.definitionId} AND bd.version = t.definition_version
                WHERE t.board_id = ${board.id} AND t.definition_version <> ${target.version}
                ORDER BY t.created_at, t.id
                FOR UPDATE OF t
              `;
              const mapped = (column: string): string | undefined =>
                Object.hasOwn(mapping, column) ? mapping[column] : undefined;
              const problems: Array<CardMigrationProblem> = [];
              for (const card of cards) {
                const taskId = TaskId.make(card.id);
                const to = mapped(card.column);
                const declared = (yield* readColumns(
                  card.columns,
                  `task ${card.id}'s definition`,
                )).find((column) => column.name === card.column);
                const landing = target.columns.find(
                  (column) => column.name === to,
                );
                const problem: CardMigrationProblem | undefined =
                  card.unfinished
                    ? { taskId, column: card.column, reason: "unfinished_run" }
                    : to === undefined
                      ? {
                          taskId,
                          column: card.column,
                          reason: "unmapped_column",
                        }
                      : card.blockedColumn !== null &&
                          mapped(card.blockedColumn) === undefined
                        ? {
                            taskId,
                            column: card.blockedColumn,
                            reason: "unmapped_column",
                          }
                        : declared !== undefined &&
                            landing !== undefined &&
                            declared.kind !== landing.kind
                          ? {
                              taskId,
                              column: card.column,
                              reason: "kind_changed",
                            }
                          : undefined;
                if (problem !== undefined) problems.push(problem);
              }
              if (problems.length > 0) {
                const why = {
                  unfinished_run: "has an unfinished run",
                  unmapped_column: "is in a column the mapping does not name",
                  kind_changed: `would land in a column of another kind under ${targetName}`,
                } as const;
                return yield* new CardMigrationRefused({
                  boardId: board.id,
                  cards: problems,
                  message: `the board's cards cannot all move to ${targetName}, so none did: ${problems
                    .map(
                      (problem) =>
                        `${problem.taskId} (${problem.column}) ${why[problem.reason]}`,
                    )
                    .join("; ")}`,
                });
              }
              for (const card of cards) {
                const to = mapped(card.column) ?? card.column;
                const blockedColumn =
                  card.blockedColumn === null
                    ? null
                    : (mapped(card.blockedColumn) ?? card.blockedColumn);
                yield* sql`
                  UPDATE tasks
                  SET definition_version = ${target.version}, "column" = ${to},
                      blocked_column = ${blockedColumn},
                      revision = revision + 1, updated_at = now()
                  WHERE id = ${card.id}
                `;
                yield* appendEvent({
                  _tag: "repinned",
                  taskId: TaskId.make(card.id),
                  actor: input.actor,
                  revision: card.revision,
                  fromVersion: card.definitionVersion,
                  toVersion: target.version,
                  from: card.column,
                  to,
                  mapping: { ...mapping },
                });
                repinned.push({
                  taskId: TaskId.make(card.id),
                  fromVersion: card.definitionVersion,
                  from: card.column,
                  to,
                  revision: card.revision + 1,
                });
              }
            }
            const updated =
              target.version === board.definitionVersion
                ? board
                : (yield* sql<BoardInstanceRow>`
                    UPDATE board_instances SET definition_version = ${target.version}
                    WHERE id = ${board.id}
                    RETURNING ${sql.literal(BOARD_INSTANCE_COLUMNS)}
                  `)[0];
            const behind = yield* sql<{ n: number }>`
              SELECT count(*)::int AS n FROM tasks
              WHERE board_id = ${board.id} AND definition_version <> ${target.version}
            `;
            return {
              instance: yield* toInstance(updated ?? board),
              fromVersion: board.definitionVersion,
              repinned,
              unmigrated: behind[0]?.n ?? 0,
            };
          }),
        ),
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

    /** Make one card, inside the caller's transaction: `create`'s body, and `file`'s second half. */
    const insertCard = (
      input: CreateTaskInput,
    ): Effect.Effect<Task, TaskError | SqlError> =>
      Effect.gen(function* () {
        // The instance is locked `FOR SHARE` first, so an upgrade (D5) that holds it waits for this
        // card to commit before it reads the cards it re-pins, and a create that waits on an upgrade
        // goes on at the new pin. A statement of its own, not a lock on the join below: a row lock
        // that waited re-checks the join against the instance's new version but the definition row
        // of the old one, which no longer matches, and the board would read as missing.
        yield* sql`SELECT id FROM board_instances WHERE id = ${input.boardId} FOR SHARE`;
        // The board and the definition version it binds, which is the version the card pins (B2)
        // and so the one whose initial column it starts in (LOB-267): read after the lock, so it is
        // the pin as it stands once any upgrade holding it has committed.
        const boards = yield* sql<{
          id: string;
          repo: string;
          definitionVersion: number;
          columns: string;
          initialColumn: string | null;
        }>`
              SELECT bi.id, bi.repo, bi.definition_version,
                     bd.columns::text AS columns, bd.initial_column
              FROM board_instances bi
              JOIN board_definitions bd
                ON bd.id = bi.definition_id AND bd.version = bi.definition_version
              WHERE bi.id = ${input.boardId}
            `;
        const board = boards[0];
        if (board === undefined) {
          return yield* new BoardNotFound({
            boardId: input.boardId,
            message: `no board ${input.boardId}`,
          });
        }
        // The card's repository is its board's (B2, LOB-255): the default when none is named,
        // and the only one a caller may name. A card with none made only scratch runs, which
        // have no branch and so can never leave building.
        const repo = input.repo ?? board.repo;
        if (repo !== board.repo) {
          return yield* new BoardRepoMismatch({
            boardId: board.id,
            boardRepo: board.repo,
            repo,
            message: `board ${board.id} is over ${board.repo}, so a card on it cannot name ${repo}`,
          });
        }
        const definition: DefinitionMoves = {
          columns: yield* readColumns(board.columns, `board ${board.id}`),
          ...initialColumnField(board.initialColumn),
        };
        // A definition that cannot be used as written (an initial column it lacks, no columns
        // at all, a move to a lane it lacks) makes no card: one would start in a lane the board
        // does not render, with no moves out (LOB-267). 0026 holds its seed to the same check, and
        // `defineBoard` (D4) an authored version; a row written any other way is held to it here.
        const problems = definitionProblems(definition);
        const column = initialColumnOf(definition);
        if (problems.length > 0 || column === undefined) {
          return yield* new TaskStorageError({
            message: `board ${board.id}'s definition version ${board.definitionVersion} cannot start a card: ${problems.join("; ")}`,
          });
        }
        const id = yield* mintTaskId;
        const priority = input.priority ?? "normal";
        // What the card says and where its runs start (LOB-260). A blank value is none, so an
        // empty body is no body — the row's '' and the event's absence — and no prompt section.
        const { body, baseRef, externalRef, externalUrl } =
          yield* cardText(input);
        // The handoff is the card's input like its body, so it rides on the `created` event and the
        // row holds none of it: `handoff` reads it back from there.
        const handoff = yield* handoffOf(input.handoff);
        const rows = yield* sql<TaskRow>`
              INSERT INTO tasks (
                id, board_id, title, "column", repo, definition_version,
                revision, priority, body, base_ref, external_ref, external_url,
                created_at, updated_at
              )
              VALUES (
                ${id}, ${board.id}, ${input.title}, ${column}, ${repo},
                ${board.definitionVersion}, 1, ${priority}, ${body ?? ""},
                ${baseRef ?? null}, ${externalRef ?? null}, ${externalUrl ?? null},
                now(), now()
              )
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
        // The event carries the create's whole input, so the row is derivable from the history
        // (`./taskProjection`): the projection rebuilt from `task_events` is this card.
        yield* appendEvent({
          _tag: "created",
          taskId: id,
          boardId: BoardInstanceId.make(board.id),
          title: input.title,
          column,
          actor: input.actor,
          revision: 1,
          priority,
          ...(body === undefined ? {} : { body }),
          ...(baseRef === undefined ? {} : { baseRef }),
          ...(externalRef === undefined ? {} : { externalRef }),
          ...(externalUrl === undefined ? {} : { externalUrl }),
          ...(handoff === undefined ? {} : { handoff }),
        });
        return yield* toTask(rows[0] as TaskRow);
      });

    const create = (input: CreateTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(sql.withTransaction(insertCard(input)));

    /**
     * File a card for an outside item at most once per board (LOB-254): the trigger seam's door. The
     * transaction takes an advisory lock on the board and the item's key before it looks — as
     * `createBoard` does on a repository — so two deliveries about one issue that arrive together
     * cannot both see no card and both insert: the second waits, then finds the first's card.
     *
     * Not a unique index: a person may file several cards against one issue on purpose (LOB-260 keeps
     * `externalRef` free-form), and only the trigger's door promises one. When the board already holds
     * cards for the key, the oldest is the answer.
     */
    const file = (input: FileTaskInput): Effect.Effect<FiledTask, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            const externalRef = input.externalRef.trim();
            if (externalRef === "") {
              return yield* new InvalidTaskInput({
                field: "externalRef",
                message:
                  "a card filed for an outside item names the item: its externalRef is blank",
              });
            }
            yield* sql`
              SELECT pg_advisory_xact_lock(hashtext(${`tasks:${input.boardId}:${externalRef}`}))
            `;
            const existing = yield* sql<TaskRow>`
              SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
              WHERE board_id = ${input.boardId} AND external_ref = ${externalRef}
              ORDER BY created_at, id
              LIMIT 1
            `;
            const found = existing[0];
            if (found !== undefined) {
              return { task: yield* toTask(found), created: false };
            }
            const task = yield* insertCard({ ...input, externalRef });
            return { task, created: true };
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

    /**
     * The board's cards and what their runs say (C10). The card list is `list`'s; the run facts come
     * from three statements scoped to the board, never one per card: the runs' count and summed
     * spend, the newest run's session and status, and the newest PR any run recorded. A run whose
     * session index row is missing counts for zero spend and reads `idle`, so a missing row never
     * shows a card as working.
     */
    const listCards = (
      input: ListTasksInput,
    ): Effect.Effect<ReadonlyArray<BoardCard>, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const tasks = yield* list(input);
          if (tasks.length === 0) return [];
          const totals = yield* sql<{
            taskId: string;
            runCount: number;
            costTotal: number;
          }>`
            SELECT tr.task_id, COUNT(*)::int AS run_count,
                   COALESCE(SUM(sa.cost_total), 0)::float8 AS cost_total
            FROM task_runs tr
            JOIN tasks t ON t.id = tr.task_id
            LEFT JOIN session_activity sa ON sa.session_id = tr.session_id
            WHERE t.board_id = ${input.boardId}
            GROUP BY tr.task_id
          `;
          const newest = yield* sql<{
            taskId: string;
            sessionId: string;
            startedAt: Date | string;
            status: string | null;
          }>`
            SELECT DISTINCT ON (tr.task_id) tr.task_id, tr.session_id, tr.started_at, sa.status
            FROM task_runs tr
            JOIN tasks t ON t.id = tr.task_id
            LEFT JOIN session_activity sa ON sa.session_id = tr.session_id
            WHERE t.board_id = ${input.boardId}
            ORDER BY tr.task_id, tr.started_at DESC, tr.id DESC
          `;
          const pulls = yield* sql<{ taskId: string; prUrl: string }>`
            SELECT DISTINCT ON (tr.task_id) tr.task_id, s.pr_url
            FROM task_runs tr
            JOIN tasks t ON t.id = tr.task_id
            JOIN sessions s ON s.id = tr.session_id
            WHERE t.board_id = ${input.boardId} AND s.pr_url IS NOT NULL AND s.pr_url <> ''
            ORDER BY tr.task_id, tr.started_at DESC, tr.id DESC
          `;
          const totalOf = new Map(totals.map((row) => [row.taskId, row]));
          const newestOf = new Map(newest.map((row) => [row.taskId, row]));
          const prOf = new Map(pulls.map((row) => [row.taskId, row.prUrl]));
          return yield* Effect.forEach(tasks, (task) => {
            const total = totalOf.get(task.id);
            const run = newestOf.get(task.id);
            const prUrl = prOf.get(task.id);
            return decodeCard({
              task,
              runCount: total?.runCount ?? 0,
              costTotal: total?.costTotal ?? 0,
              ...(run === undefined
                ? {}
                : {
                    run: {
                      sessionId: run.sessionId,
                      status: run.status === "busy" ? "busy" : "idle",
                      startedAt: iso(run.startedAt),
                    },
                  }),
              ...(prUrl === undefined ? {} : { prUrl }),
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new TaskStorageError({
                    message: `card ${task.id} does not read as a board card: ${String(cause)}`,
                  }),
              ),
            );
          });
        }),
      );

    const decodeColumns = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(BoardColumn)),
    );

    /**
     * The column a card sits in, by name and as the definition version it pinned declares it (B2):
     * `undefined` for a card that is gone, and `declared` absent for a column its definition does
     * not name. `definition` is that version's columns and initial column, which decide the card's
     * moves (LOB-267). A card's pinned version changes only by a migration (D5), which bumps its
     * revision, so a read before the card is locked and one under the lock at the same revision
     * answer the same definition.
     */
    const pinnedColumn = (taskId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          column: string;
          revision: number;
          columns: string;
          initialColumn: string | null;
        }>`
          SELECT t."column", t.revision, bd.columns::text AS columns, bd.initial_column
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
        const definition: DefinitionMoves = {
          columns,
          ...initialColumnField(row.initialColumn),
        };
        return {
          name: row.column,
          revision: row.revision,
          declared: columns.find((candidate) => candidate.name === row.column),
          definition,
        };
      });

    /**
     * The latest run's branch against its base, measured the way the PR step measures it
     * (`./requirements`): the same `git diff --numstat` (`branchDiffSize`, which `diffSize` runs),
     * over the same `base...head`, with the branches the step would name — the session's own branch,
     * or `factory/<id>`, and its base ref. Measured from the repository's registered `local_path`
     * rather than the run's worktree: the worktree is a linked worktree that `resolveWorkspace` cut
     * with git's discovery from that same path, so git finds the same refs from it — a `local_path`
     * inside a checkout included — and the path is in the registry while the worktree's depends on the
     * API's session root. Where the two can part (a `local_path` re-registered after the run was cut,
     * a run cut before any checkout was registered) the branch is not found here, which is
     * `unmeasured` and refused, never a pass (`./requirements`).
     */
    const branchDiff = (run: RunRow): Effect.Effect<BranchDiff> => {
      const { sessionId } = run;
      if (run.repo === null)
        return Effect.succeed({
          _tag: "unmeasured",
          sessionId,
          reason:
            run.indexed === null
              ? "its session is not in the index"
              : "its session is bound to no repository, so it has no branch",
        });
      if (run.localPath === null)
        return Effect.succeed({
          _tag: "unmeasured",
          sessionId,
          reason: `repository ${run.repo} has no local checkout registered, so no branch of it can be read`,
        });
      const head = run.branch ?? `factory/${sessionId}`;
      const base = run.baseRef ?? "main";
      const checkout = run.localPath;
      // Against the base the PR step measures against (C17, `measureBaseOf`): the forge's fetched
      // tip when the run was cut from it, so the forge's own new commits are not the run's change.
      // The answer names the ref it measured against, so its `git diff` is the one that ran.
      return measureBaseOf({ directory: checkout, base, head }).pipe(
        Effect.flatMap((measureBase) =>
          branchDiffSize({ checkout, base: measureBase, head }).pipe(
            Effect.map(({ files }): BranchDiff => ({
              _tag: "measured",
              sessionId,
              base: measureBase,
              head,
              files,
            })),
          ),
        ),
        Effect.catchTag("PrError", (error) =>
          Effect.succeed<BranchDiff>({
            _tag: "unmeasured",
            sessionId,
            reason: `${error.message}: git diff ${error.ref} in ${run.localPath}`,
          }),
        ),
      );
    };

    /**
     * What the card's runs recorded, oldest run first (B1: a run is one session, and its log is the
     * truth for what it did). One batched read folds every run's log; none is opened as an owner.
     * What a run's turn, the card's spec and the latest run's branch cost to read is paid only when
     * `keys` names the requirement that reads it (`run_completed`, `spec_doc`, `non_empty_diff`). The review
     * runs are split out, in the same order, beside the head each of the card's PRs was last
     * reported at (`review_heads`), which says which of them `review_verdict` judges (LOB-241).
     */
    const cardEvidence = (
      taskId: string,
      keys: ReadonlySet<string>,
      column: string,
    ) =>
      Effect.gen(function* () {
        const runs = yield* sql<RunRow>`
          SELECT tr.session_id, tr."column", s.id AS indexed, s.repo, s.base_ref, s.branch, r.local_path
          FROM task_runs tr
          LEFT JOIN sessions s ON s.id = tr.session_id
          LEFT JOIN repos r ON r.slug = s.repo
          WHERE tr.task_id = ${taskId}
          ORDER BY tr.started_at, tr.id
        `;
        const logs = yield* Effect.tryPromise({
          try: () =>
            // Each run's log from its checkpoint (LOB-243): a card's evidence costs its runs'
            // tails, not their whole logs.
            PostgresStorage.readers(
              sql,
              runs.map((run) => run.sessionId),
              { checkpoints: true },
            ),
          catch: (cause) =>
            new TaskStorageError({
              message: `task ${taskId}: could not read its runs' logs: ${String(cause)}`,
            }),
        });
        // A review run is not a run of the card's change (module doc), so it is neither evidence nor
        // the latest run; what it recorded is `review_verdict`'s evidence.
        const recordedReviews = yield* Effect.forEach(runs, (run) => {
          const storage = logs.get(run.sessionId);
          return storage === undefined
            ? Effect.undefined
            : readRecordedReview(storage).pipe(
                Effect.mapError(
                  (cause) =>
                    new TaskStorageError({
                      message: `task ${taskId}: run ${run.sessionId}'s review record does not read: ${cause.message}`,
                    }),
                ),
              );
        });
        const reviews = runs.flatMap((run, index) => {
          const review = recordedReviews[index];
          return review === undefined
            ? []
            : [{ sessionId: run.sessionId, review }];
        });
        const changing = runs.filter(
          (_, index) => recordedReviews[index] === undefined,
        );
        // `run_completed` judges the newest run started in the column being left, so only that run's
        // turn is read: a run an earlier column started says nothing about this one.
        const completing = changing
          .filter((run) => run.column === column)
          .at(-1)?.sessionId;
        const recorded = yield* Effect.forEach(
          changing,
          (run): Effect.Effect<RunEvidence, TaskStorageError> => {
            const sessionId = run.sessionId;
            const startedIn = run.column;
            // The branch the run is on (C19: a card's later runs share its first change run's), so
            // `pr_link` can tell the card's PR from a PR of a branch the card no longer carries.
            const branch =
              run.repo === null
                ? {}
                : { branch: run.branch ?? `factory/${sessionId}` };
            const storage = logs.get(sessionId);
            if (storage === undefined)
              return Effect.succeed({
                sessionId,
                column: startedIn,
                calls: [],
                ...branch,
              });
            return Effect.gen(function* () {
              const calls = yield* readVerifyCalls(storage).pipe(
                Effect.mapError(
                  (cause) =>
                    new TaskStorageError({
                      message: `task ${taskId}: run ${sessionId}'s verify records do not read: ${cause.message}`,
                    }),
                ),
              );
              const pr = yield* readRecordedPullRequest(storage).pipe(
                Effect.mapError(
                  (cause) =>
                    new TaskStorageError({
                      message: `task ${taskId}: run ${sessionId}'s PR record does not read: ${cause.message}`,
                    }),
                ),
              );
              const turn =
                keys.has(RUN_COMPLETED_REQUIREMENT) && sessionId === completing
                  ? yield* readRunTurn(storage).pipe(
                      Effect.mapError(
                        (cause) =>
                          new TaskStorageError({
                            message: `task ${taskId}: run ${sessionId}'s turn does not read: ${cause.message}`,
                          }),
                      ),
                    )
                  : undefined;
              // GitHub's merge of the PR this run recorded, for `human_merge` (C20).
              const merge = keys.has(HUMAN_MERGE_REQUIREMENT)
                ? yield* readRecordedMerge(storage).pipe(
                    Effect.mapError(
                      (cause) =>
                        new TaskStorageError({
                          message: `task ${taskId}: run ${sessionId}'s merge record does not read: ${cause.message}`,
                        }),
                    ),
                  )
                : undefined;
              return {
                sessionId,
                column: startedIn,
                calls,
                ...(merge === undefined || merge.mergedAt === ""
                  ? {}
                  : { mergedPr: merge.url }),
                ...(pr === undefined
                  ? {}
                  : {
                      prUrl: pr.url,
                      prHead: pr.head,
                      ...(pr.commit === undefined
                        ? {}
                        : { prCommit: pr.commit }),
                    }),
                ...branch,
                ...(turn === undefined ? {} : { turn }),
              };
            });
          },
        );
        // The head each of the card's PRs was last reported at, which picks the review that counts
        // (`review_heads`, LOB-241).
        const reviewHeads = (yield* sql<{
          readonly prUrl: string;
          readonly apiUrl: string | null;
          readonly head: string;
        }>`
          SELECT pr_url, api_url, head FROM review_heads WHERE task_id = ${taskId}
        `).map((row) => ({
          url: row.prUrl,
          ...(row.apiUrl === null ? {} : { apiUrl: row.apiUrl }),
          head: row.head,
        }));
        const latest = changing.at(-1);
        // Whether the card has a spec: any `specified` event.
        const specified = keys.has(SPEC_DOC_REQUIREMENT)
          ? (yield* sql<{ id: number }>`
              SELECT id FROM task_events
              WHERE task_id = ${taskId} AND kind = 'specified'
              LIMIT 1
            `)[0]
          : undefined;
        // Whether the card has a plan: any `planned` event (D10).
        const planned = keys.has(PLAN_DOC_REQUIREMENT)
          ? (yield* sql<{ id: number }>`
              SELECT id FROM task_events
              WHERE task_id = ${taskId} AND kind = 'planned'
              LIMIT 1
            `)[0]
          : undefined;
        // Where the latest run's branch is, for `pr_link` standing on an earlier run's PR (C19):
        // read from the registered checkout, as `non_empty_diff` reads it.
        const branchTip =
          latest === undefined ||
          latest.repo === null ||
          latest.localPath === null
            ? undefined
            : yield* resolveCommit(
                latest.localPath,
                `refs/heads/${latest.branch ?? `factory/${latest.sessionId}`}`,
              );
        const tip = branchTip === undefined ? {} : { branchTip };
        const evidence: CardEvidence = {
          column,
          runs: recorded,
          reviews,
          reviewHeads,
          ...(specified === undefined ? {} : { specified: true }),
          ...(planned === undefined ? {} : { planned: true }),
          ...(keys.has(NON_EMPTY_DIFF_REQUIREMENT) && latest !== undefined
            ? { diff: yield* branchDiff(latest) }
            : {}),
          ...tip,
        };
        return evidence;
      });

    /**
     * The first exit requirement leaving the card's current column for `to` does not meet, judged
     * before the card is locked (module doc) and only at the revision the caller expected: a card at
     * another revision is refused as `StaleRevision` here, before its logs are read, so the
     * transaction's revision check is what holds the judgement to the card it locks. A card the read
     * does not find is left to the transaction, which refuses it as `TaskNotFound`.
     */
    const judgeExit = (
      input: MoveTaskInput,
    ): Effect.Effect<ExitJudgement, TaskError | SqlError> =>
      Effect.gen(function* () {
        const pinned = yield* pinnedColumn(input.taskId);
        if (pinned === undefined) return { unmet: undefined };
        const definition = pinned.definition;
        if (pinned.revision !== input.expectedRevision) {
          return yield* new StaleRevision({
            taskId: input.taskId,
            expected: input.expectedRevision,
            actual: pinned.revision,
            message: `task ${input.taskId} is at revision ${pinned.revision}, not ${input.expectedRevision}: someone moved it first`,
          });
        }
        const column = pinned.declared;
        const requirements = exitRequirements(column, input.to);
        if (column === undefined || requirements.length === 0)
          return { unmet: undefined, definition };
        const evidence = yield* cardEvidence(
          input.taskId,
          new Set(requirements.map((requirement) => requirement.key)),
          column.name,
        );
        for (const requirement of requirements) {
          const verdict = requirementVerdict(requirement, evidence);
          if (!verdict.met) {
            return {
              definition,
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
        return { unmet: undefined, definition };
      });

    const exit = (taskId: string): Effect.Effect<TaskExit, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const pinned = yield* pinnedColumn(taskId);
          if (pinned === undefined) {
            return yield* new TaskNotFound({
              taskId,
              message: `no task ${taskId}`,
            });
          }
          const column = pinned.declared;
          const base = {
            taskId: TaskId.make(taskId),
            column: pinned.name,
            revision: pinned.revision,
          };
          // A column the pinned definition does not declare has no requirements to meet.
          if (column === undefined) return { ...base, requirements: [] };
          const keys = new Set(
            column.requires
              .map((requirement) => requirement.key)
              .filter((key) => CHECKED_REQUIREMENTS.has(key)),
          );
          const evidence = yield* cardEvidence(taskId, keys, pinned.name);
          return { ...base, requirements: exitView(column, evidence) };
        }),
      );

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
            // From the version the card pinned (B2): the moves are its, not the board's newest or
            // the default pipeline's (LOB-267). The judgement read it at the revision this lock
            // holds, and a pin moves only with the revision (D5), so it is not read again here.
            const transition =
              exit.definition === undefined
                ? undefined
                : transitionOf(exit.definition, from, input.to);
            if (transition === undefined) {
              return yield* new UndeclaredTransition({
                from,
                to: input.to,
                message: `column "${from}" declares no transition to "${input.to}"`,
              });
            }
            const gate = transition.gate;
            if (gate !== undefined && isRunActor(input.actor)) {
              return yield* new HumanGateRequired({
                gate,
                from,
                to: input.to,
                actor: input.actor,
                message: `the move ${from} → ${input.to} crosses the ${gate} gate, which only a person can make`,
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

    const update = (input: UpdateTaskInput): Effect.Effect<Task, TaskError> =>
      withStorage(
        sql.withTransaction(
          Effect.gen(function* () {
            if (input.title === undefined && input.priority === undefined) {
              return yield* new InvalidTaskInput({
                field: "update",
                message: "an update names a title, a priority or both",
              });
            }
            const title = input.title?.trim();
            if (title !== undefined && title === "") {
              return yield* new InvalidTaskInput({
                field: "title",
                message: "a card's title cannot be blank",
              });
            }
            if (title !== undefined && title.length > MAX_TASK_TITLE_CHARS) {
              return yield* new InvalidTaskInput({
                field: "title",
                message: `a card's title takes at most ${MAX_TASK_TITLE_CHARS} characters; this one has ${title.length}`,
              });
            }
            const row = yield* lockExpected(
              input.taskId,
              input.expectedRevision,
            );
            const retitle = title !== undefined && title !== row.title;
            const reprioritize =
              input.priority !== undefined &&
              input.priority !== (row.priority as TaskPriorityType);
            // Saying what the card already says is no edit: nothing moves, nothing is recorded.
            if (!retitle && !reprioritize) return yield* toTask(row);
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET title = ${retitle ? title : row.title},
                  priority = ${reprioritize ? input.priority : row.priority},
                  revision = revision + 1, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            const taskId = TaskId.make(input.taskId);
            if (retitle) {
              yield* appendEvent({
                _tag: "retitled",
                taskId,
                from: row.title,
                to: title,
                actor: input.actor,
                revision: input.expectedRevision,
              });
            }
            if (reprioritize) {
              yield* appendEvent({
                _tag: "priorityChanged",
                taskId,
                from: row.priority as TaskPriorityType,
                to: input.priority,
                actor: input.actor,
                revision: input.expectedRevision,
              });
            }
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

    const parkRun = (input: ParkRunInput): Effect.Effect<Task, TaskError> =>
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
            if (row.blockedReason !== null) return yield* toTask(row);
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET blocked_reason = ${input.reason}, blocked_column = ${row.column},
                  blocked_note = ${input.note}, blocked_since = now(),
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
              revision: row.revision,
            });
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const settlePullRequest = (
      input: SettlePullRequestInput,
    ): Effect.Effect<SettledPullRequest, TaskError> =>
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
            const unchanged = Effect.map(toTask(row), (task) => ({
              task,
              changed: false,
            }));
            // Under the lock, so a redelivery that waited on the first reads the card it left.
            if (isTerminalColumn(row.column)) return yield* unchanged;
            const taskId = TaskId.make(input.taskId);
            if (input.outcome === "closed") {
              if (row.blockedReason !== null) return yield* unchanged;
              // One block per PR, not per report: the PR-state read reports the close on every read
              // of the card, and a person who unblocked the card has answered it.
              const reported = yield* sql<{ readonly one: number }>`
                SELECT 1 AS one FROM task_events
                WHERE task_id = ${input.taskId} AND kind = 'blocked'
                  AND actor = ${closeActor(input.pr.url)}
                LIMIT 1
              `;
              if (reported.length > 0) return yield* unchanged;
              const rows = yield* sql<TaskRow>`
                UPDATE tasks
                SET blocked_reason = 'pr_closed', blocked_column = ${row.column},
                    blocked_note = ${`pull request #${input.pr.number} (${input.pr.url}) was closed without being merged: reopen and merge it in GitHub, which moves the card to done, or unblock the card to go on (its next run pushes to the same PR's branch, which stays closed until someone reopens it)`},
                    blocked_since = now(), revision = revision + 1, updated_at = now()
                WHERE id = ${input.taskId}
                RETURNING ${sql.literal(TASK_COLUMNS)}
              `;
              yield* appendEvent({
                _tag: "blocked",
                taskId,
                reason: "pr_closed",
                column: row.column,
                actor: closeActor(input.pr.url),
                revision: row.revision,
              });
              return { task: yield* toTask(rows[0] as TaskRow), changed: true };
            }
            const pinned = yield* pinnedColumn(input.taskId);
            if (
              pinned === undefined ||
              !pinned.definition.columns.some(
                (column) => column.name === MERGED_COLUMN,
              )
            )
              return yield* unchanged;
            const actor = mergeActor(input.pr.url);
            // A block lifts with the merge: a finished card waits on nothing.
            const blocked = row.blockedReason !== null;
            if (blocked) {
              yield* appendEvent({
                _tag: "unblocked",
                taskId,
                actor,
                revision: row.revision,
              });
            }
            const moveRevision = blocked ? row.revision + 1 : row.revision;
            const rows = yield* sql<TaskRow>`
              UPDATE tasks
              SET "column" = ${MERGED_COLUMN}, blocked_reason = NULL, blocked_column = NULL,
                  blocked_note = NULL, blocked_since = NULL,
                  revision = ${moveRevision + 1}, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            yield* appendEvent({
              _tag: "moved",
              taskId,
              from: row.column,
              to: MERGED_COLUMN,
              actor,
              revision: moveRevision,
            });
            return { task: yield* toTask(rows[0] as TaskRow), changed: true };
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

    const declareSpec = (
      input: DeclareSpecInput,
    ): Effect.Effect<Task, TaskError> =>
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
            if (input.specId !== undefined) {
              // Read under the card's lock, as the ask's id is, so two replays cannot both miss.
              const posted = yield* sql<{ n: number }>`
                SELECT count(*)::int AS n FROM task_events
                WHERE task_id = ${input.taskId} AND kind = 'specified'
                  AND payload->>'specId' = ${input.specId}
              `;
              if ((posted[0]?.n ?? 0) > 0) return yield* toTask(row);
            }
            yield* appendEvent({
              _tag: "specified",
              taskId: TaskId.make(input.taskId),
              actor: input.actor,
              revision: row.revision,
              column: input.column ?? row.column,
              goal: input.goal,
              acceptance: [...input.acceptance],
              gaps: [...input.gaps],
              openQuestions: [...input.openQuestions],
              ...(input.specId === undefined ? {} : { specId: input.specId }),
            });
            const rows = yield* sql<TaskRow>`
              UPDATE tasks SET revision = revision + 1, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const decodeSpecView = Schema.decodeUnknownEffect(TaskSpec);

    const spec = (
      taskId: string,
    ): Effect.Effect<TaskSpec | undefined, TaskError> =>
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
          // The newest by write order, as the thread is ordered: two specs in one millisecond keep
          // the order they were written in.
          const rows = yield* sql<{
            id: string;
            payload: string;
            createdAt: Date | string;
          }>`
            SELECT id::text AS id, payload::text AS payload, created_at
            FROM task_events
            WHERE task_id = ${taskId} AND kind = 'specified'
            ORDER BY task_events.id DESC
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) return undefined;
          return yield* Effect.gen(function* () {
            const event = yield* decodeEvent(row.payload);
            if (event._tag !== "specified") {
              return yield* Effect.fail(
                `event ${row.id} is stored as specified but is ${event._tag}`,
              );
            }
            return yield* decodeSpecView({
              taskId: event.taskId,
              sessionId: event.actor,
              column: event.column,
              goal: event.goal,
              acceptance: event.acceptance,
              gaps: event.gaps,
              openQuestions: event.openQuestions,
              revision: event.revision,
              createdAt: iso(row.createdAt),
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `task ${taskId} holds an unreadable spec ${row.id}: ${String(cause)}`,
                }),
            ),
          );
        }),
      );

    /**
     * The card its history describes (LOB-260): every event in write order — the identity column,
     * as the thread is read — decoded and folded by `projectTask`. Read from `task_events` alone,
     * never from the row, so a test can wipe the row's columns and still find the card here.
     */
    const replay = (taskId: string): Effect.Effect<TaskProjection, TaskError> =>
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
          const rows = yield* sql<{ id: string; payload: string }>`
            SELECT id::text AS id, payload::text AS payload
            FROM task_events
            WHERE task_id = ${taskId}
            ORDER BY task_events.id
          `;
          const events = yield* Effect.forEach(rows, (row) =>
            decodeEvent(row.payload).pipe(
              Effect.mapError(
                (cause) =>
                  new TaskStorageError({
                    message: `task ${taskId} holds an unreadable event ${row.id}: ${String(cause)}`,
                  }),
              ),
            ),
          );
          const card = projectTask(events);
          if (card === undefined) {
            return yield* new TaskStorageError({
              message: `task ${taskId}'s history does not start with one created event`,
            });
          }
          return card;
        }),
      );

    const declarePlan = (
      input: DeclarePlanInput,
    ): Effect.Effect<Task, TaskError> =>
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
            if (input.planId !== undefined) {
              // Read under the card's lock, as the spec's id is, so two replays cannot both miss.
              const posted = yield* sql<{ n: number }>`
                SELECT count(*)::int AS n FROM task_events
                WHERE task_id = ${input.taskId} AND kind = 'planned'
                  AND payload->>'planId' = ${input.planId}
              `;
              if ((posted[0]?.n ?? 0) > 0) return yield* toTask(row);
            }
            yield* appendEvent({
              _tag: "planned",
              taskId: TaskId.make(input.taskId),
              actor: input.actor,
              revision: row.revision,
              column: input.column ?? row.column,
              summary: input.summary,
              steps: [...input.steps],
              surfaces: [...input.surfaces],
              risks: [...input.risks],
              ...(input.planId === undefined ? {} : { planId: input.planId }),
            });
            const rows = yield* sql<TaskRow>`
              UPDATE tasks SET revision = revision + 1, updated_at = now()
              WHERE id = ${input.taskId}
              RETURNING ${sql.literal(TASK_COLUMNS)}
            `;
            return yield* toTask(rows[0] as TaskRow);
          }),
        ),
      );

    const decodePlanView = Schema.decodeUnknownEffect(TaskPlan);

    const plan = (
      taskId: string,
    ): Effect.Effect<TaskPlan | undefined, TaskError> =>
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
          // The newest by write order, as the spec is read.
          const rows = yield* sql<{
            id: string;
            payload: string;
            createdAt: Date | string;
          }>`
            SELECT id::text AS id, payload::text AS payload, created_at
            FROM task_events
            WHERE task_id = ${taskId} AND kind = 'planned'
            ORDER BY task_events.id DESC
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) return undefined;
          return yield* Effect.gen(function* () {
            const event = yield* decodeEvent(row.payload);
            if (event._tag !== "planned") {
              return yield* Effect.fail(
                `event ${row.id} is stored as planned but is ${event._tag}`,
              );
            }
            return yield* decodePlanView({
              taskId: event.taskId,
              sessionId: event.actor,
              column: event.column,
              summary: event.summary,
              steps: event.steps,
              surfaces: event.surfaces,
              risks: event.risks,
              revision: event.revision,
              createdAt: iso(row.createdAt),
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `task ${taskId} holds an unreadable plan ${row.id}: ${String(cause)}`,
                }),
            ),
          );
        }),
      );

    const decodeHandoffView = Schema.decodeUnknownEffect(TaskHandoff);

    const handoff = (
      taskId: string,
    ): Effect.Effect<TaskHandoff | undefined, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          // The card's first event is its `created`, and only it carries a handoff: one row read by
          // its kind, with no fold of the rest of the history.
          const rows = yield* sql<{
            id: string | null;
            payload: string | null;
            createdAt: Date | string | null;
            baseRef: string | null;
          }>`
            SELECT e.id::text AS id, e.payload::text AS payload, e.created_at,
                   t.base_ref
            FROM tasks t
            LEFT JOIN task_events e ON e.task_id = t.id AND e.kind = 'created'
            WHERE t.id = ${taskId}
            ORDER BY e.id
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) {
            return yield* new TaskNotFound({
              taskId,
              message: `no task ${taskId}`,
            });
          }
          const { id, payload, createdAt } = row;
          if (id === null || payload === null || createdAt === null)
            return undefined;
          return yield* Effect.gen(function* () {
            const event = yield* decodeEvent(payload);
            if (event._tag !== "created") {
              return yield* Effect.fail(
                `event ${id} is stored as created but is ${event._tag}`,
              );
            }
            if (event.handoff === undefined) return undefined;
            return yield* decodeHandoffView({
              taskId: event.taskId,
              ...event.handoff,
              ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
              bytes: handoffPatchBytes(event.handoff.patch),
              files: handoffPatchFiles(event.handoff.patch),
              actor: event.actor,
              createdAt: iso(createdAt),
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TaskStorageError({
                  message: `task ${taskId} holds an unreadable handoff ${id}: ${String(cause)}`,
                }),
            ),
          );
        }),
      );

    const decodeRun = Schema.decodeUnknownEffect(TaskRun);
    const decodeCard = Schema.decodeUnknownEffect(BoardCard);

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

    const decodeAttention = Schema.decodeUnknownEffect(AttentionItem);

    /** One attention row from a task row, its board's repo and the reason; a bad row is a storage fault. */
    const toAttention = (
      row: TaskRow & { readonly boardRepo: string },
      reason: unknown,
    ): Effect.Effect<AttentionItem, TaskStorageError> =>
      Effect.gen(function* () {
        const task = yield* toTask(row);
        return yield* decodeAttention({
          task,
          repo: row.boardRepo,
          reason,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TaskStorageError({
                message: `task ${row.id} does not read as an attention row: ${String(cause)}`,
              }),
          ),
        );
      });

    /** One attention row for an approval of a session no card owns (LOB-271); a bad row is a storage fault. */
    const toSessionAttention = (
      row: {
        readonly approvalSession: string;
        readonly sessionTitle: string;
        readonly sessionRepo: string | null;
      },
      reason: unknown,
    ): Effect.Effect<AttentionItem, TaskStorageError> =>
      decodeAttention({
        sessionTitle: row.sessionTitle,
        ...(row.sessionRepo === null ? {} : { repo: row.sessionRepo }),
        reason,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TaskStorageError({
              message: `session ${row.approvalSession} does not read as an attention row: ${String(cause)}`,
            }),
        ),
      );

    /**
     * What needs a person (LOB-77): three statements over the rows the board and the approvals
     * service already keep, and no log fold — the view is polled, so its cost is a fixed number of
     * row reads, never a fold per card (R6). The approvals read starts from the
     * `session_approvals_pending` index; the questions and gates reads filter `tasks` by block and
     * column, which no index covers, so the every-board view scans `tasks` — fine at the MVP's card
     * count, and a partial index on `blocked_reason` is the fix when it is not.
     *
     * - **Approvals** are `session_approvals` rows with no decision, on a session `task_runs` names
     *   as a run of the card. Every column, every block: only a person settles one. On the every-board
     *   read they also include the undecided rows of sessions `task_runs` names nowhere (LOB-271): a
     *   scratch session gated by `APPROVAL_REQUIRED` waits on a person as much as a run does, and the
     *   view is the one place that person looks. They carry no card, only the session; a board's own
     *   view lists the board's cards, so it leaves them out. Both kinds share one order, oldest first.
     * - **Questions** are cards blocked `needs_input` (B7). The question is the newest `question`
     *   comment asked since the block began (an answered question from an earlier block is not this
     *   block's), falling back to the block's note (a person may block a card `needs_input` by hand,
     *   with no run asking).
     * - **Gates** are unblocked cards in a column whose exit crosses a human gate (B5), with a run
     *   started in that column, no run of the card busy in `session_activity`, and no run of the
     *   card holding an undecided approval. In the MVP a person starts and drives every run, so an
     *   idle run in a gated column is one whose work is handed back: the next step is the person's
     *   move. A run parked on an approval is idle too (LOB-52: the hook never waits), but it is
     *   waiting on a decision, not handing back — that card is listed as the approval, not the gate.
     *   A card with no run there yet is not at the gate — the column's work has not been done — and
     *   a blocked card is waiting on its block.
     */
    const attention = (
      boardId: string | undefined,
    ): Effect.Effect<ReadonlyArray<AttentionItem>, TaskError> =>
      withStorage(
        Effect.gen(function* () {
          const board = boardId ?? null;
          if (board !== null) {
            const found = yield* sql<{ id: string }>`
              SELECT id FROM board_instances WHERE id = ${board}
            `;
            if (found[0] === undefined) {
              return yield* new BoardNotFound({
                boardId: board,
                message: `no board ${board}`,
              });
            }
          }

          const approvals = yield* sql<
            TaskRow & {
              readonly boardRepo: string;
              readonly approvalSession: string;
              readonly requestId: string;
              readonly action: string;
              readonly detail: string;
              readonly requestedAt: Date | string;
              readonly requestedKey: string;
            }
          >`
            SELECT ${sql.literal(TASK_COLUMNS_T)}, bi.repo AS board_repo,
                   sa.session_id AS approval_session, sa.request_id, sa.action, sa.detail,
                   sa.requested_at,
                   to_char(sa.requested_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS requested_key
            FROM session_approvals sa
            JOIN task_runs tr ON tr.session_id = sa.session_id
            JOIN tasks t ON t.id = tr.task_id
            JOIN board_instances bi ON bi.id = t.board_id
            WHERE sa.decision IS NULL
              AND (${board}::text IS NULL OR t.board_id = ${board})
            ORDER BY sa.requested_at, sa.session_id, sa.request_id
          `;

          // A session no card owns. `task_runs.session_id` is unique, so the anti-join is one index probe
          // per pending row, and the pending rows come from `session_approvals_pending`.
          const sessionApprovals =
            board !== null
              ? []
              : yield* sql<{
                  readonly approvalSession: string;
                  readonly requestId: string;
                  readonly action: string;
                  readonly detail: string;
                  readonly requestedAt: Date | string;
                  readonly requestedKey: string;
                  readonly sessionTitle: string;
                  readonly sessionRepo: string | null;
                }>`
                  SELECT sa.session_id AS approval_session, sa.request_id, sa.action, sa.detail,
                         sa.requested_at,
                         to_char(sa.requested_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS requested_key,
                         s.title AS session_title, s.repo AS session_repo
                  FROM session_approvals sa
                  JOIN sessions s ON s.id = sa.session_id
                  WHERE sa.decision IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM task_runs tr WHERE tr.session_id = sa.session_id
                    )
                  ORDER BY sa.requested_at, sa.session_id, sa.request_id
                `;

          const questions = yield* sql<
            TaskRow & {
              readonly boardRepo: string;
              readonly question: string | null;
            }
          >`
            SELECT ${sql.literal(TASK_COLUMNS_T)}, bi.repo AS board_repo,
                   COALESCE(q.body, t.blocked_note) AS question
            FROM tasks t
            JOIN board_instances bi ON bi.id = t.board_id
            LEFT JOIN LATERAL (
              SELECT e.payload->>'body' AS body
              FROM task_events e
              WHERE e.task_id = t.id AND e.kind = 'commented'
                AND e.payload->>'kind' = 'question'
                AND e.created_at >= t.blocked_since
              ORDER BY e.id DESC
              LIMIT 1
            ) q ON true
            WHERE t.blocked_reason = 'needs_input'
              AND (${board}::text IS NULL OR t.board_id = ${board})
            ORDER BY t.blocked_since, t.id
          `;

          // The definition versions the unblocked cards pin, each with the columns whose exit crosses
          // a human gate under it (LOB-267): a gate is the card's pinned version's, not a name the
          // default pipeline gates. Keyed `<definition>@<version>:<column>`; a definition id has no
          // `@` or `:`, so a key names one column of one version.
          const pinned = yield* sql<{
            readonly id: string;
            readonly version: number;
            readonly columns: string;
            readonly initialColumn: string | null;
          }>`
            SELECT bd.id, bd.version, bd.columns::text AS columns, bd.initial_column
            FROM board_definitions bd
            WHERE EXISTS (
              SELECT 1
              FROM tasks t
              JOIN board_instances bi ON bi.id = t.board_id
              WHERE bi.definition_id = bd.id AND t.definition_version = bd.version
                AND t.blocked_reason IS NULL
                AND (${board}::text IS NULL OR t.board_id = ${board})
            )
          `;
          const definitions = new Map<string, DefinitionMoves>();
          for (const row of pinned) {
            definitions.set(`${row.id}@${row.version}`, {
              columns: yield* readColumns(
                row.columns,
                `board definition ${row.id} v${row.version}`,
              ),
              ...initialColumnField(row.initialColumn),
            });
          }
          const gatedKeys = [...definitions].flatMap(([key, definition]) =>
            gatedColumns(definition).map((column) => `${key}:${column}`),
          );

          type GateRow = TaskRow & {
            readonly boardRepo: string;
            readonly definitionId: string;
            readonly runSession: string;
          };
          // No pinned version gates any column: nothing can wait at a gate, and an empty array is
          // not a parameter to send.
          const gates: ReadonlyArray<GateRow> =
            gatedKeys.length === 0
              ? []
              : yield* sql<GateRow>`
            SELECT ${sql.literal(TASK_COLUMNS_T)}, bi.repo AS board_repo,
                   bi.definition_id, r.session_id AS run_session
            FROM tasks t
            JOIN board_instances bi ON bi.id = t.board_id
            JOIN LATERAL (
              SELECT tr.session_id
              FROM task_runs tr
              WHERE tr.task_id = t.id AND tr."column" = t."column"
              ORDER BY tr.started_at DESC, tr.id DESC
              LIMIT 1
            ) r ON true
            WHERE t.blocked_reason IS NULL
              AND (bi.definition_id || '@' || t.definition_version || ':' || t."column")
                = ANY(${gatedKeys}::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM task_runs busy
                JOIN session_activity sa ON sa.session_id = busy.session_id
                WHERE busy.task_id = t.id AND sa.status = 'busy'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM task_runs asking
                JOIN session_approvals ap ON ap.session_id = asking.session_id
                WHERE asking.task_id = t.id AND ap.decision IS NULL
              )
              AND (${board}::text IS NULL OR t.board_id = ${board})
            ORDER BY t.updated_at, t.id
          `;

          const approvalItems = yield* Effect.forEach(approvals, (row) =>
            toAttention(row, {
              _tag: "approval",
              sessionId: row.approvalSession,
              requestId: row.requestId,
              action: row.action,
              detail: row.detail,
              requestedAt: iso(row.requestedAt),
            }).pipe(Effect.map((item) => [row.requestedKey, item] as const)),
          );
          const sessionApprovalItems = yield* Effect.forEach(
            sessionApprovals,
            (row) =>
              toSessionAttention(row, {
                _tag: "approval",
                sessionId: row.approvalSession,
                requestId: row.requestId,
                action: row.action,
                detail: row.detail,
                requestedAt: iso(row.requestedAt),
              }).pipe(Effect.map((item) => [row.requestedKey, item] as const)),
          );
          const questionItems = yield* Effect.forEach(questions, (row) =>
            toAttention(row, {
              _tag: "question",
              since: iso(row.blockedSince ?? row.updatedAt),
              ...(row.question === null || row.question.trim() === ""
                ? {}
                : { question: row.question }),
            }),
          );
          // A gate whose exit still misses a document the card must hold (a planning run that
          // settled without a plan: `plan_doc`, D10) is still a person's — someone must start or
          // prompt a run — but not yet the gate's move, which `move` would refuse naming the key.
          // The item names it, judged by the same `requirementVerdict`, so the view says "needs a
          // plan" rather than inviting an approval the service refuses. Only the keys a card's own
          // events settle (`spec_doc`, `plan_doc`) are judged here, in one read for every gate row:
          // the log-judged keys (`verified`, `review_verdict`, …) would read every run's log on
          // every attention poll, and are the exit checklist's (`exit`) to show.
          const documentKeys: ReadonlySet<string> = new Set([
            SPEC_DOC_REQUIREMENT,
            PLAN_DOC_REQUIREMENT,
          ]);
          const documents =
            gates.length === 0
              ? []
              : yield* sql<{ taskId: string; kind: string }>`
                  SELECT DISTINCT task_id, kind FROM task_events
                  WHERE task_id = ANY(${gates.map((row) => row.id)}::text[])
                    AND kind IN ('specified', 'planned')
                `;
          const held = new Set(
            documents.map((row) => `${row.taskId}:${row.kind}`),
          );
          const gateItems = yield* Effect.forEach(gates, (row) => {
            const definition = definitions.get(
              `${row.definitionId}@${row.definitionVersion}`,
            );
            const exit =
              definition === undefined
                ? undefined
                : gatedExit(definition, row.column);
            const evidence: CardEvidence = {
              column: row.column,
              runs: [],
              ...(held.has(`${row.id}:specified`) ? { specified: true } : {}),
              ...(held.has(`${row.id}:planned`) ? { planned: true } : {}),
            };
            const unmet =
              exit === undefined
                ? []
                : exitRequirements(
                    definition?.columns.find(
                      (column) => column.name === row.column,
                    ),
                    exit.to,
                  )
                    .filter(
                      (requirement) =>
                        documentKeys.has(requirement.key) &&
                        !requirementVerdict(requirement, evidence).met,
                    )
                    .map((requirement) => requirement.key);
            return toAttention(row, {
              _tag: "gate",
              gate: exit?.gate,
              to: exit?.to,
              sessionId: row.runSession,
              ...(unmet.length === 0 ? {} : { unmet }),
            });
          });
          return [
            ...mergeByRequest(approvalItems, sessionApprovalItems),
            ...questionItems,
            ...gateItems,
          ];
        }),
      );

    return {
      getBoard,
      listBoards,
      createBoard,
      listDefinitions,
      getDefinition,
      defineBoard,
      upgradeBoard,
      declaredRoles,
      create,
      file,
      get,
      list,
      move,
      block,
      unblock,
      update,
      ask,
      parkRun,
      settlePullRequest,
      comment,
      comments,
      declareSpec,
      spec,
      declarePlan,
      plan,
      handoff,
      exit,
      replay,
      listCards,
      listRuns,
      attention,
    } satisfies TaskServiceShape;
  }),
);
