import type {
  BlockReason,
  BoardColumn,
  BoardDefinition,
  Task,
} from "@repo/domain/Task";

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
