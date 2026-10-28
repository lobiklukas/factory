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
 * One move a column declares (B5, LOB-267): the column a card may go to from it, and the human gate
 * the move crosses, when it crosses one — the name a refusal and the card pane give it. A move with a
 * gate is one only a person can make; a run's actor is refused it as `HumanGateRequired`.
 */
export const ColumnTransition = Schema.Struct({
  to: Schema.String,
  gate: Schema.optional(Schema.String),
});
export type ColumnTransition = typeof ColumnTransition.Type;

/**
 * One column of a board definition (B4, B6).
 *
 * `role` resolves to model and tool policy in one place, so changing a model is one edit rather
 * than one per column; it is absent where B4 puts "—". `skills[]` are factory-owned skill names
 * (B6), injected at `openSession` alongside the role's tool policy. `requires[]` is checked on
 * exit, not on entry: a card may always be moved *into* a column, and the gate is what leaves it.
 *
 * `transitions[]` are the moves out of the column, in the order the card pane offers them (B5,
 * LOB-267); anything else is an undeclared transition. Optional because default versions 1–3 were
 * written before the field existed and a version is never edited in place (B2): a definition none of
 * whose columns carries it is read through the default pipeline's table (`columnTransitions`), and
 * one where any column carries it declares its own moves, a column without it declaring none.
 */
export const BoardColumn = Schema.Struct({
  name: Schema.String,
  kind: ColumnKind,
  role: Schema.optional(Schema.String),
  skills: Schema.Array(Schema.String),
  requires: Schema.Array(ColumnRequirement),
  transitions: Schema.optional(Schema.Array(ColumnTransition)),
});
export type BoardColumn = typeof BoardColumn.Type;

/**
 * The default pipeline's moves (B4, B5): the forward pipeline, plus `canceled` from any column that
 * is not terminal. A terminal column declares none.
 *
 * Since LOB-267 a definition declares its moves on its columns (`BoardColumn.transitions`), and this
 * table is only two things: what a definition version that declares none resolves to — default
 * versions 1–3, which cards in flight still pin (B2) — and the seed `0026_seed_definition_transitions`
 * wrote into default version 4. Nothing reads it for a definition that declares its own.
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

/**
 * The default definition's terminal columns (B4): a card in one is finished, and its runs' worktrees
 * and branches are torn down when it gets there (LOB-268). Hard-coded by name: `BoardColumn.kind`
 * says it per definition, and moves read the card's definition since LOB-267, but the workspace
 * release still decides "finished" from the column's name alone, which is the default pipeline's.
 */
export const TERMINAL_COLUMNS: ReadonlyArray<string> = ["done", "canceled"];

/** Whether a card in `column` is finished: `done` or `canceled`. */
export const isTerminalColumn = (column: string): boolean =>
  TERMINAL_COLUMNS.includes(column);

/**
 * The default pipeline's two human gates (B5), keyed by `from→to`, with the name a refusal (and the
 * card pane) gives them. `DECLARED_TRANSITIONS`' companion, read only where that table is: a
 * definition version that declares no moves of its own, and default version 4's seed.
 */
export const HUMAN_GATES: Readonly<Record<string, string>> = {
  "planning→building": "plan approval",
  "review→done": "merge",
};

/** The default pipeline's initial column (B4): where default version 4's seed starts a card (0026). */
export const DEFAULT_INITIAL_COLUMN = "intake";

/**
 * The requirement a column declares when leaving it takes a passing verification of the card's
 * change (B8, LOB-80, part 3 of LOB-16). The default pipeline's `review` column declares it from
 * definition version 3 (`0018_seed_verified_requirement.ts`); `TaskService` checks it against the
 * `verify` records of the card's runs and refuses the move, naming it, when it is not met.
 */
export const VERIFIED_REQUIREMENT = "verified";

/**
 * The requirement a column declares when leaving it takes a change: the card's latest run's branch
 * differs from its base, measured as the PR step measures it (LOB-196, LOB-240). The default
 * pipeline's `building` declares it from version 1.
 */
export const NON_EMPTY_DIFF_REQUIREMENT = "non_empty_diff";

/**
 * The requirement a column declares when leaving it takes a PR: the card's latest run's log records
 * one (`factory.pr`, LOB-177; LOB-240). The default pipeline's `building` declares it from version 1.
 */
export const PR_LINK_REQUIREMENT = "pr_link";

/**
 * The requirement a column declares when leaving it takes the reviewer's verdict: the card's newest
 * review run (LOB-36) recorded a `pass` on the head it was opened for (LOB-241). The default
 * pipeline's `review` declares it from version 1.
 */
export const REVIEW_VERDICT_REQUIREMENT = "review_verdict";

/** The columns the default pipeline's table lets a card in `from` move to, in pipeline order. */
export const declaredTransitions = (from: string): ReadonlyArray<string> =>
  DECLARED_TRANSITIONS[from] ?? [];

/** The human gate the default pipeline's move `from → to` crosses, or `undefined` when a run may make it too. */
export const humanGate = (from: string, to: string): string | undefined =>
  HUMAN_GATES[`${from}→${to}`];

/** The default pipeline's moves out of `from` as a column declares them: `DECLARED_TRANSITIONS` with `HUMAN_GATES` joined on. */
export const defaultPipelineTransitions = (
  from: string,
): ReadonlyArray<ColumnTransition> =>
  declaredTransitions(from).map((to) => {
    const gate = humanGate(from, to);
    return gate === undefined ? { to } : { to, gate };
  });

/**
 * What decides a card's moves and where a new card starts (LOB-267): a definition version's columns
 * and its initial column. `BoardDefinition` is one; so is anything else that carries the two.
 */
export type DefinitionMoves = {
  readonly columns: ReadonlyArray<BoardColumn>;
  readonly initialColumn?: string | undefined;
};

/**
 * Whether a definition version declares its own moves: any column of it carries `transitions`. One
 * that does not (default versions 1–3) is read through the default pipeline's table.
 */
export const declaresTransitions = (definition: DefinitionMoves): boolean =>
  definition.columns.some((column) => column.transitions !== undefined);

/**
 * The moves out of `from` under `definition` (B5, LOB-267), in declaration order: what
 * `TaskService.move` accepts and the card pane offers, so a move the API would refuse is never
 * offered. A column the definition does not name declares none.
 */
export const columnTransitions = (
  definition: DefinitionMoves,
  from: string,
): ReadonlyArray<ColumnTransition> =>
  declaresTransitions(definition)
    ? (definition.columns.find((column) => column.name === from)?.transitions ??
      [])
    : defaultPipelineTransitions(from);

/** The declared move `from → to` under `definition`, or `undefined` when it is undeclared. */
export const transitionOf = (
  definition: DefinitionMoves,
  from: string,
  to: string,
): ColumnTransition | undefined =>
  columnTransitions(definition, from).find(
    (transition) => transition.to === to,
  );

/**
 * The column a new card on `definition` starts in (B4, LOB-267): its `initialColumn`, or — for a
 * version written before the field existed — its first column, which is `intake` in default versions
 * 1–3. `undefined` for a definition that declares no columns: there is no lane to start a card in,
 * and naming one it lacks would start a card no lane shows (`definitionProblems` says why).
 */
export const initialColumnOf = (
  definition: DefinitionMoves,
): string | undefined =>
  definition.initialColumn ?? definition.columns[0]?.name;

/**
 * Why `definition` cannot be used as written, one sentence per fault, or `[]` when it can (LOB-267):
 * a column named twice, an initial column it does not declare, a move to a column it does not
 * declare, to the column itself, or to one target twice, and a gate with no name. Every move a card
 * makes is checked against the definition, so these are the faults that would leave a card with a
 * move no lane shows or a lane it can never leave. Default version 4's seed is held to it; so will
 * an authored version be.
 */
export const definitionProblems = (
  definition: DefinitionMoves,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const names = new Set<string>();
  for (const column of definition.columns) {
    if (names.has(column.name))
      problems.push(`column "${column.name}" is declared more than once`);
    names.add(column.name);
  }
  if (definition.columns.length === 0)
    problems.push("the definition declares no columns");
  if (
    definition.initialColumn !== undefined &&
    !names.has(definition.initialColumn)
  )
    problems.push(
      `the initial column "${definition.initialColumn}" is not a column of the definition`,
    );
  for (const column of definition.columns) {
    const targets = new Set<string>();
    for (const transition of column.transitions ?? []) {
      if (!names.has(transition.to))
        problems.push(
          `column "${column.name}" declares a move to "${transition.to}", which is not a column of the definition`,
        );
      if (transition.to === column.name)
        problems.push(`column "${column.name}" declares a move to itself`);
      if (targets.has(transition.to))
        problems.push(
          `column "${column.name}" declares its move to "${transition.to}" more than once`,
        );
      targets.add(transition.to);
      if (transition.gate !== undefined && transition.gate.trim() === "")
        problems.push(
          `column "${column.name}"'s move to "${transition.to}" names a gate with no name`,
        );
    }
  }
  return problems;
};

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
  /**
   * The column a new card starts in (B4, LOB-267). Absent on a version written before the field
   * existed (default versions 1–3), which starts a card in its first column (`initialColumnOf`).
   */
  initialColumn: Schema.optional(Schema.String),
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
  /**
   * Set when the board's repository has no local checkout registered (LOB-263): its runs get no
   * worktree, so no card can produce a diff. Read with the board, so it clears once the repo is
   * registered with a path.
   */
  warning: Schema.optional(Schema.String),
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

/** The definition the default pipeline ships under (0007, versioned by 0010 and 0018). */
export const DEFAULT_DEFINITION_ID = "default";

/**
 * One version of a definition as the list names it (LOB-270): enough to pick one for `createBoard`
 * without reading every version's columns.
 */
export const DefinitionVersionSummary = Schema.Struct({
  version: Schema.Int,
  name: Schema.String,
  createdAt: Timestamp,
});
export type DefinitionVersionSummary = typeof DefinitionVersionSummary.Type;

/** A definition and every version it holds, oldest first (LOB-270). */
export const DefinitionSummary = Schema.Struct({
  id: DefinitionId,
  versions: Schema.Array(DefinitionVersionSummary),
});
export type DefinitionSummary = typeof DefinitionSummary.Type;

/**
 * Which definitions exist (LOB-270), ordered by id: what `factory board create --definition` and
 * `--definition-version` can name. Definitions are written by migrations only, so the list is small
 * and is answered whole.
 */
export const ListDefinitionsInput = Schema.Struct({});
export type ListDefinitionsInput = typeof ListDefinitionsInput.Type;

/**
 * One definition version, with what each column does (LOB-270). `version` absent reads the newest,
 * as `createBoard` pins it; an unknown id, or a version it does not hold, is `DefinitionNotFound`.
 */
export const GetDefinitionInput = Schema.Struct({
  definitionId: DefinitionId,
  version: Schema.optional(Schema.Int),
});
export type GetDefinitionInput = typeof GetDefinitionInput.Type;

/** A board's configuration (LOB-270): its instance and the definition version it pins, described. */
export const GetBoardConfigInput = Schema.Struct({ boardId: BoardInstanceId });
export type GetBoardConfigInput = typeof GetBoardConfigInput.Type;

/**
 * One move a column declares (B5), and the human gate it crosses when it crosses one: the move only a
 * person can make. Built by the same `columnTransitions` `TaskService` refuses by, so what a reader is
 * told is what a move meets.
 */
export const ColumnExit = Schema.Struct({
  to: Schema.String,
  humanGate: Schema.optional(Schema.String),
});
export type ColumnExit = typeof ColumnExit.Type;

/**
 * One exit requirement as a reader is told it (LOB-270): the declared key and description, and
 * whether the board checks it on a move today. `checked: false` is a key the definition declares and
 * nothing enforces as a requirement yet — a human gate's `human_*` key among them, which the move's
 * actor check enforces instead and the column's exits mark.
 */
export const RequirementConfig = Schema.Struct({
  key: Schema.String,
  description: Schema.String,
  checked: Schema.Boolean,
});
export type RequirementConfig = typeof RequirementConfig.Type;

/**
 * The model a run started in a column talks to (B6, LOB-207): `provider/modelId`, and where it came
 * from — the role's row in the deployment's `ROLE_MODELS` (`role`), or the deployment's own model for
 * a role with no row and a column with no role (`deployment`). Deployment configuration, read-only.
 */
export const ResolvedModel = Schema.Struct({
  model: Schema.String,
  source: Schema.Literals(["role", "deployment"]),
});
export type ResolvedModel = typeof ResolvedModel.Type;

/** One column as a reader is told it (LOB-270): the declared column, plus what the factory does with it. */
export const ColumnConfig = Schema.Struct({
  name: Schema.String,
  kind: ColumnKind,
  role: Schema.optional(Schema.String),
  model: ResolvedModel,
  skills: Schema.Array(Schema.String),
  requires: Schema.Array(RequirementConfig),
  exits: Schema.Array(ColumnExit),
});
export type ColumnConfig = typeof ColumnConfig.Type;

/**
 * A definition version described (LOB-270): every column in declaration order with its exits, human
 * gates, checked and unchecked requirements and its role's resolved model, so an operator can see what
 * a board will do before trusting it.
 */
export const DefinitionConfig = Schema.Struct({
  id: DefinitionId,
  version: Schema.Int,
  name: Schema.String,
  /**
   * The column a new card starts in, resolved as `createTask` resolves it (`initialColumnOf`, LOB-267).
   * Absent only for a version that declares no columns, on which `createTask` refuses to make a card.
   */
  initialColumn: Schema.optional(Schema.String),
  columns: Schema.Array(ColumnConfig),
});
export type DefinitionConfig = typeof DefinitionConfig.Type;

/** A board's full configuration (LOB-270): the instance and its pinned definition version, described. */
export const BoardConfig = Schema.Struct({
  instance: BoardInstance,
  definition: DefinitionConfig,
});
export type BoardConfig = typeof BoardConfig.Type;

/**
 * A new board (B2, LOB-208): one repository bound to a version of a named definition.
 *
 * `definitionVersion` is optional and defaults to the definition's **newest** version, read when the
 * board is created and pinned from then on — a board made today gets today's pipeline, and a version
 * a later migration adds reaches the next board, never this one. Naming a version is for a caller
 * that needs an older pipeline on purpose (a drive pinned to version 1's exits, say). A repository
 * gets one board: a second `createBoard` for it is `BoardExists`, naming the board it already has —
 * more than one board per repository is deferred board customization (docs/board.md, item 8).
 */
export const CreateBoardInput = Schema.Struct({
  repo: RepoSlug,
  definitionId: DefinitionId,
  definitionVersion: Schema.optional(Schema.Int),
});
export type CreateBoardInput = typeof CreateBoardInput.Type;

/**
 * What `createBoard` answers (LOB-263): the instance, and a `warning` when its repository has no
 * local checkout. The board is still made — a repository is registered on first use, so refusing
 * would make every board for a not-yet-registered slug fail — but the first answer says that its
 * runs can produce no diff, with the command that fixes it.
 */
export const CreatedBoard = Schema.Struct({
  ...BoardInstance.fields,
  warning: Schema.optional(Schema.String),
});
export type CreatedBoard = typeof CreatedBoard.Type;

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
 * The spec a card's specifying run declared (LOB-238, the card half of LOB-72's `factory.spec`).
 *
 * The run's log holds the document, and is the truth for what the run committed; this is the card's
 * record of it, written by the run's `spec` tool in the same call, so the card's spec is one read
 * over `task_events` rather than a fold of every run's log. A card has the spec its newest
 * `specified` event declared: a later specifying run that closes the gaps replaces an earlier one's
 * without erasing it from the history.
 *
 * The fields are LOB-72's `Spec` as the harness's validator accepted it — the harness owns the
 * rules (`gaps` required, `[]` allowed, nothing empty), so this shape only carries the result.
 * `sessionId` is the run that declared it, and `column` the column the card was in when it did.
 */
export const TaskSpecFields = {
  goal: Schema.String,
  acceptance: Schema.Array(Schema.String),
  gaps: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
} as const;

export const TaskSpec = Schema.Struct({
  taskId: TaskId,
  sessionId: SessionId,
  column: Schema.String,
  ...TaskSpecFields,
  revision: Schema.Int,
  createdAt: Timestamp,
});
export type TaskSpec = typeof TaskSpec.Type;

/** The spec a card holds, or `null` when no run on it has declared one (LOB-238). */
export const GetTaskSpecInput = Schema.Struct({ taskId: TaskId });
export type GetTaskSpecInput = typeof GetTaskSpecInput.Type;

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
  /**
   * The board's repository, which `createTask` gives every card (LOB-255). A card made before then
   * holds none in its row and reads back with its board's, the one its runs are bound to.
   */
  repo: Schema.optional(RepoSlug),
  /**
   * What the card asks for, in markdown, as whoever filed it wrote it (LOB-260): the task's
   * description, quoted verbatim into every run's prompt as its `task_body` section. Absent for a
   * card with none, which is every card made before cards carried one.
   */
  body: Schema.optional(Schema.String),
  /**
   * The ref the card's runs cut their worktree from (LOB-260): a run started on the card with no
   * base of its own starts here rather than at the repository's default. Absent: the repository's.
   */
  baseRef: Schema.optional(Schema.String),
  /**
   * Where the card came from outside the factory (LOB-260): the tracker issue it was filed from — a
   * URL or a key such as `LOB-42`. Opaque here: nothing reads it back out of the card yet.
   */
  externalRef: Schema.optional(Schema.String),
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
 * (B4, B7), a comment (B7 — the question a run ended with, and the answer to one), the spec a
 * specifying run declared (B4's `specifying` exit, LOB-238), and a priority change (B9, "priority
 * changes are recorded as events"). A run starting or finishing is a later
 * issue's event: LOB-60 owns the run-start and run-finish events and the `factory.task` log
 * document; this file already carries `TaskRun` and migration 0007 already creates `task_runs`,
 * because B1 makes a run a first-class thing a task owns.
 */
export const TaskEvent = Schema.TaggedUnion({
  /**
   * The card was made. `body`, `baseRef`, `externalRef` and `priority` are what the create carried
   * (LOB-260), so the card's input is derivable from its history (`projectTask`); each is absent
   * when the create set none, and on every `created` event written before cards carried them.
   */
  created: {
    taskId: TaskId,
    boardId: BoardInstanceId,
    title: Schema.String,
    column: Schema.String,
    actor: Actor,
    revision: Schema.Int,
    body: Schema.optional(Schema.String),
    baseRef: Schema.optional(Schema.String),
    externalRef: Schema.optional(Schema.String),
    priority: Schema.optional(TaskPriority),
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
  /**
   * A specifying run declared the card's spec (LOB-238). `actor` is the run's session id; `specId`
   * is `<session id>:<tool call id>`, so a `spec` call replayed after a crash posts nothing twice.
   */
  specified: {
    taskId: TaskId,
    actor: Actor,
    revision: Schema.Int,
    column: Schema.String,
    ...TaskSpecFields,
    specId: Schema.optional(Schema.String),
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

/**
 * A board was asked for over a definition the factory does not hold (LOB-208), or a definition was
 * read that it does not hold (LOB-270): no row with that id, or — when the caller named one — no such
 * version of it. `version` is absent for the first.
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
 * A board was asked for over a repository that already has one (LOB-208): the MVP has one board per
 * repository. `boardId` names the board it already has.
 */
export class BoardExists extends Schema.TaggedError<BoardExists>()(
  "BoardExists",
  { repo: Schema.String, boardId: Schema.String, message: Schema.String },
) {}

/**
 * A card was asked for on a board with a repository other than the board's (LOB-255). A card
 * inherits its board's repository (B2), so one naming another would put runs on the board that
 * work somewhere else. Names both: `repo` is the one the caller named, `boardRepo` the board's.
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

/**
 * A create carried a field the card cannot take (LOB-260): a body or ref over its cap, or a base ref
 * that is not a plain git ref — every run on the card hands it to git. `field` names it.
 */
export class InvalidTaskInput extends Schema.TaggedError<InvalidTaskInput>()(
  "InvalidTaskInput",
  { field: Schema.String, message: Schema.String },
) {}

export type TaskError =
  | TaskNotFound
  | BoardNotFound
  | DefinitionNotFound
  | BoardExists
  | BoardRepoMismatch
  | StaleRevision
  | UndeclaredTransition
  | HumanGateRequired
  | RequirementUnmet
  | AlreadyBlocked
  | NotBlocked
  | EmptyComment
  | InvalidTaskInput
  | TaskStorageError;

/**
 * The longest body a card takes, in characters (LOB-260). The body is quoted verbatim into the
 * prompt of every request of every run on the card, so its size is a prompt budget (about 8,000
 * tokens), as a comment's is; a spec longer than this belongs in a file in the repository.
 */
export const MAX_TASK_BODY_CHARS = 32_000;

/** The longest base ref and external ref a card takes: a ref or a URL, never a document. */
export const MAX_TASK_REF_CHARS = 1_024;

/**
 * A new card (B3). `repo` defaults to the board instance's repository, which is the only one a card
 * on that board may name: another is `BoardRepoMismatch` (LOB-255).
 *
 * `body` is the card's description in markdown, `baseRef` the ref its runs cut their worktree from,
 * and `externalRef` the tracker issue it was filed from (LOB-260). Each is optional, and an empty or
 * all-whitespace one is stored as none: a card with an empty body gets no `task_body` section.
 */
export const CreateTaskInput = Schema.Struct({
  boardId: BoardInstanceId,
  title: Schema.String,
  repo: Schema.optional(RepoSlug),
  priority: Schema.optional(TaskPriority),
  body: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_TASK_BODY_CHARS))),
  ),
  baseRef: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_TASK_REF_CHARS))),
  ),
  externalRef: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_TASK_REF_CHARS))),
  ),
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
 * The column a card moves to out of `from` across a human gate under `definition`, and the gate's
 * name, or `undefined` when every move out of `from` is one a run may make too (B5). In the default
 * pipeline that is `planning → building` (plan approval) and `review → done` (merge). The first
 * gated move in declaration order when a column declares several.
 */
export const gatedExit = (
  definition: DefinitionMoves,
  from: string,
): { readonly to: string; readonly gate: string } | undefined => {
  for (const transition of columnTransitions(definition, from)) {
    if (transition.gate !== undefined)
      return { to: transition.to, gate: transition.gate };
  }
  return undefined;
};

/** Every column of `definition` whose declared exits include a human gate, in declaration order. */
export const gatedColumns = (
  definition: DefinitionMoves,
): ReadonlyArray<string> =>
  definition.columns
    .map((column) => column.name)
    .filter((column) => gatedExit(definition, column) !== undefined);

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
 *
 * An approval can also belong to a session no card owns — a scratch session, or one opened from a
 * repo with no card (LOB-271). That row has no `task`: `sessionTitle` names the session instead
 * (an untitled session says `""`), `repo` is the session's own repo when it has one, and the reason's
 * `sessionId` is where the row links. Only the `approval` reason ever appears without a card, and
 * only on the every-board read: a board's view lists the board's cards.
 */
export const AttentionItem = Schema.Struct({
  task: Schema.optional(Task),
  repo: Schema.optional(RepoSlug),
  sessionTitle: Schema.optional(Schema.String),
  reason: AttentionReason,
});
export type AttentionItem = typeof AttentionItem.Type;

/**
 * What needs a person, on one board or on every board (LOB-77). The answer is ordered approvals
 * first (oldest request first, a card-less session's among them), then questions (oldest block first), then gates (least recently
 * changed card first). An unknown board is `BoardNotFound`, not an empty list: "nothing needs you"
 * must not be what a board that does not exist says.
 */
export const ListAttentionInput = Schema.Struct({
  boardId: Schema.optional(BoardInstanceId),
});
export type ListAttentionInput = typeof ListAttentionInput.Type;
