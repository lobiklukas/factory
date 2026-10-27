import type {
  BlockReason,
  BoardColumn,
  BoardDefinition,
  Task,
} from "@repo/domain/Task";
import { declaredTransitions, humanGate } from "@repo/domain/Task";

/**
 * The board as lanes (LOB-75): what `/boards/$boardId` renders, computed from two server reads.
 *
 * Lanes come from the definition, cards from `listTasks`, and nothing else: no position, no
 * client-side ordering, no remembered state (docs/board.md B9 — a drag-ordered queue would be a
 * second source of truth about "what is next"). Pure on purpose, so the cases a screenshot cannot
 * settle — an empty lane, a card in a column the definition does not declare — are unit cases.
 */
export type Lane = {
  readonly column: BoardColumn;
  /** In the order the server listed them: urgent first, then FIFO (B9). */
  readonly cards: ReadonlyArray<Task>;
};

export type BoardLanes = {
  /** One per column, in definition order, empty lanes included. */
  readonly lanes: ReadonlyArray<Lane>;
  /**
   * Cards whose column this definition does not declare. Impossible while every card pins the
   * version its board binds (B2), but a card that went missing from the board would be a lie of
   * omission, so they are returned rather than dropped and the route renders them apart.
   */
  readonly strays: ReadonlyArray<Task>;
};

export const boardLanes = (
  definition: BoardDefinition,
  tasks: ReadonlyArray<Task>,
): BoardLanes => {
  const declared = new Set(definition.columns.map((column) => column.name));
  return {
    lanes: definition.columns.map((column) => ({
      column,
      cards: tasks.filter((task) => task.column === column.name),
    })),
    strays: tasks.filter((task) => !declared.has(task.column)),
  };
};

const BLOCK_WORDS: Readonly<Record<BlockReason, string>> = {
  dependency: "waiting on a dependency",
  needs_input: "needs input",
  capability: "missing a capability",
  transient: "transient failure",
};

/**
 * What a blocked card says about itself, or `null` when it is not blocked. A blocked card stays in
 * its own lane (B4: blocked is a card state, not a column), so the reason is the card's to show.
 */
export const blockedLabel = (task: Task): string | null =>
  task.blocked === undefined
    ? null
    : `blocked · ${BLOCK_WORDS[task.blocked.reason]}`;

/**
 * One move the card pane offers (LOB-76): a column the card's own column declares a transition to,
 * and the human gate it crosses, if any (B5).
 *
 * `gate` is what the pane marks: the dashboard's actor is a person, so a gated move *is* offered
 * here — it is the move B5 keeps for a person — but it is never offered unmarked, because the click
 * is the recorded approval (the plan approval, the merge), not an ordinary step along the pipeline.
 */
export type OfferedMove = {
  readonly to: string;
  readonly gate: string | undefined;
  /** The target's kind in this definition; `undefined` when the definition does not declare it. */
  readonly kind: BoardColumn["kind"] | undefined;
};

/**
 * The moves a card is offered: exactly the transitions its column declares, in the order the
 * pipeline declares them (docs/board.md B5), and nothing else.
 *
 * The list is `declaredTransitions` — the table `TaskService` refuses against — so a move the API
 * would refuse as undeclared is never offered: a card in `intake` is offered `specifying` and
 * `canceled`, never `done`. A target the definition does not declare is still listed with no kind
 * rather than dropped, so a table that disagrees with the definition shows up instead of hiding.
 */
export const offeredMoves = (
  task: Task,
  definition: BoardDefinition,
): ReadonlyArray<OfferedMove> =>
  declaredTransitions(task.column).map((to) => ({
    to,
    gate: humanGate(task.column, to),
    kind: definition.columns.find((column) => column.name === to)?.kind,
  }));

/**
 * Whether the card pane offers a run start, and why not when it does not (LOB-76).
 *
 * B4: a `working` column is where a run may be started; `intake` is resting (nothing runs until a
 * person moves the card on) and the terminal columns are finished. The reason travels with the
 * refusal so a disabled control can say why it is disabled.
 */
export type RunStart =
  | { readonly allowed: true; readonly column: string }
  | { readonly allowed: false; readonly reason: string };

export const runStart = (task: Task, definition: BoardDefinition): RunStart => {
  const column = definition.columns.find((c) => c.name === task.column);
  if (column === undefined) {
    return {
      allowed: false,
      reason: `${task.column} is not a column of ${definition.name} v${definition.version}`,
    };
  }
  switch (column.kind) {
    case "working":
      return { allowed: true, column: column.name };
    case "resting":
      return {
        allowed: false,
        reason: `${column.name} is a resting column: nothing runs until a person moves the card on`,
      };
    case "terminal":
      return {
        allowed: false,
        reason: `${column.name} is terminal: the card is finished`,
      };
  }
};

/**
 * What the card pane says when the API refuses a move (LOB-76).
 *
 * The body is the service's own message, verbatim (B5: "a refusal names the failing requirement" —
 * `StaleRevision` names the revision it found, `HumanGateRequired` the gate), so the pane and
 * `factory board move` print the same words. Only the heading is the pane's, and it says what to
 * do next. Anything that is not one of the board's typed refusals — a transport failure, a defect —
 * keeps its tag and the text it came with rather than being dressed up as one.
 */
export type MoveRefusal = {
  readonly tag: string;
  readonly title: string;
  readonly message: string;
  /**
   * The card revision the server held when it refused: a `StaleRevision`'s `actual`, otherwise the
   * revision the click sent. The refusal describes that revision and no later one.
   */
  readonly atRevision: number;
};

const REFUSAL_TITLES: Readonly<Record<string, string>> = {
  StaleRevision: "Someone changed this card first",
  UndeclaredTransition: "This column does not declare that move",
  HumanGateRequired: "Only a person can make this move",
  RequirementUnmet: "This column's exit requirement is not met",
  TaskNotFound: "This card no longer exists",
  TaskStorageError: "The board could not record the move",
};

export const moveRefusal = (
  error:
    | {
        readonly _tag: string;
        readonly message: string;
        readonly actual?: unknown;
      }
    | undefined,
  fallback: string,
  sentRevision: number,
): MoveRefusal =>
  error === undefined
    ? {
        tag: "Unknown",
        title: "The move did not go through",
        message: fallback,
        atRevision: sentRevision,
      }
    : {
        tag: error._tag,
        title: REFUSAL_TITLES[error._tag] ?? "The move did not go through",
        message: error.message.length > 0 ? error.message : fallback,
        atRevision:
          error._tag === "StaleRevision" &&
          typeof error.actual === "number" &&
          error.actual > sentRevision
            ? error.actual
            : sentRevision,
      };

/**
 * Whether a refusal still describes the card on screen. Once the card's revision passes the one the
 * server refused at, the card has moved on — a CLI move, another browser, a run — and the refusal is
 * about a card that no longer exists, so the pane drops it rather than showing it over the new
 * column's moves.
 */
export const refusalIsCurrent = (
  refusal: MoveRefusal | null,
  task: Pick<Task, "revision">,
): refusal is MoveRefusal =>
  refusal !== null && task.revision <= refusal.atRevision;

/**
 * Whether the pane is still waiting for the board read to show a move it made. A move lands before
 * the refetch does; until the card on screen reaches the revision the server answered, a second click
 * would send the old revision and be refused as stale for the person's own move.
 */
export const awaitingMove = (
  landedAt: number | null,
  task: Pick<Task, "revision">,
): boolean => landedAt !== null && task.revision < landedAt;

/**
 * Whether the run the URL names (`?run=`) is one of this card's runs (LOB-76), so the pane opens a
 * session's transcript, composer and approvals only under the card it was started against.
 *
 * `runs` is the card's `listTaskRuns` answer so far, or `undefined` before the first one lands;
 * `refreshing` says another read is in flight. A run missing from a list that is being re-read — the
 * one a click just started, say — is `loading`, not `foreign`, until the read settles without it.
 */
export type RunSelection = "none" | "loading" | "member" | "foreign";

export const runSelection = (
  run: string | undefined,
  runs: ReadonlyArray<{ readonly sessionId: string }> | undefined,
  refreshing: boolean,
): RunSelection => {
  if (run === undefined) return "none";
  if (runs === undefined) return "loading";
  if (runs.some((listed) => listed.sessionId === run)) return "member";
  return refreshing ? "loading" : "foreign";
};
