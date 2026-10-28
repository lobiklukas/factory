import type {
  BlockReason,
  BoardColumn,
  BoardDefinition,
  DefinitionConfig,
  Task,
} from "@repo/domain/Task";
import { columnTransitions, isWebLink } from "@repo/domain/Task";

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
 * Where the card came from outside the factory, as the card pane shows it (LOB-254): the external
 * ref as its label, and a link when the card carries a web link — its `externalUrl`, or a ref that is
 * itself one (a person may file a card with the issue's URL as its ref, LOB-260). `href` is only ever
 * an absolute http(s) URL (`isWebLink`), so the page never renders a `javascript:` link. `null` for a
 * card filed from nowhere.
 */
export const externalLink = (
  task: Task,
): { readonly label: string; readonly href: string | undefined } | null => {
  const ref = task.externalRef;
  const url = task.externalUrl;
  if (ref === undefined && url === undefined) return null;
  const href =
    url !== undefined && isWebLink(url)
      ? url
      : ref !== undefined && isWebLink(ref)
        ? ref
        : undefined;
  return { label: ref ?? url ?? "", href };
};

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
 * The moves a card is offered: exactly the transitions its column declares under `definition`, the
 * version the card pinned, in the order the definition declares them (docs/board.md B5, LOB-267),
 * and nothing else.
 *
 * The list is `columnTransitions` — what `TaskService` refuses against — so a move the API would
 * refuse as undeclared is never offered: a card in the default pipeline's `intake` is offered
 * `specifying` and `canceled`, never `done`. A target the definition does not declare is still
 * listed with no kind rather than dropped, so a move that disagrees with the lanes shows up instead
 * of hiding.
 */
export const offeredMoves = (
  task: Task,
  definition: BoardDefinition,
): ReadonlyArray<OfferedMove> =>
  columnTransitions(definition, task.column).map(({ to, gate }) => ({
    to,
    gate,
    kind: definition.columns.find((column) => column.name === to)?.kind,
  }));

/**
 * A definition version as `getDefinition` describes it, back as the columns a card's moves are read
 * from (LOB-267): each column's exits are its declared transitions, its human gates their `gate`.
 * The described exits are the server's own resolution (`columnTransitions`), so they are written
 * onto every column — a version that declared none answers the table it resolves through, and that
 * table is what the pane then offers.
 */
export const definitionOfConfig = (
  config: DefinitionConfig,
): BoardDefinition => ({
  id: config.id,
  version: config.version,
  name: config.name,
  ...(config.initialColumn === undefined
    ? {}
    : { initialColumn: config.initialColumn }),
  columns: config.columns.map((column) => ({
    name: column.name,
    kind: column.kind,
    ...(column.role === undefined ? {} : { role: column.role }),
    skills: column.skills,
    requires: column.requires.map(({ key, description }) => ({
      key,
      description,
    })),
    transitions: column.exits.map(({ to, humanGate }) =>
      humanGate === undefined ? { to } : { to, gate: humanGate },
    ),
  })),
});

/**
 * The definition version a card's moves are read from: the one it pinned (B2). That is the board's
 * own version for every card made on it, and `pinned` — the other versions the board read fetched,
 * keyed by version — for a card that pinned another. `undefined` while a pinned version is missing,
 * so the pane offers nothing rather than another version's moves.
 */
export const definitionFor = (
  task: Pick<Task, "definitionVersion">,
  board: BoardDefinition,
  pinned: ReadonlyMap<number, BoardDefinition>,
): BoardDefinition | undefined =>
  task.definitionVersion === board.version
    ? board
    : pinned.get(task.definitionVersion);

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
export type Refusal = {
  readonly tag: string;
  readonly title: string;
  readonly message: string;
  /**
   * The card revision the server held when it refused: a `StaleRevision`'s `actual`, otherwise the
   * revision the write sent. The refusal describes that revision and no later one.
   */
  readonly atRevision: number;
};

export type MoveRefusal = Refusal;

/** A typed failure as the RPC client hands it back: its tag, its message, and for a stale write the revision found. */
export type RefusedWith =
  | {
      readonly _tag: string;
      readonly message: string;
      readonly actual?: unknown;
    }
  | undefined;

/**
 * A card write's refusal, worded with `titles` (one heading per typed refusal) and `untitled` for
 * anything else. Shared by the pane's two writes — a move and a comment (LOB-239) — so they word a
 * refusal and date it (`atRevision`) the same way.
 */
export const refusalWith =
  (titles: Readonly<Record<string, string>>, untitled: string) =>
  (error: RefusedWith, fallback: string, sentRevision: number): Refusal =>
    error === undefined
      ? {
          tag: "Unknown",
          title: untitled,
          message: fallback,
          atRevision: sentRevision,
        }
      : {
          tag: error._tag,
          title: titles[error._tag] ?? untitled,
          message: error.message.length > 0 ? error.message : fallback,
          atRevision:
            error._tag === "StaleRevision" &&
            typeof error.actual === "number" &&
            error.actual > sentRevision
              ? error.actual
              : sentRevision,
        };

const REFUSAL_TITLES: Readonly<Record<string, string>> = {
  StaleRevision: "Someone changed this card first",
  UndeclaredTransition: "This column does not declare that move",
  HumanGateRequired: "Only a person can make this move",
  RequirementUnmet: "This column's exit requirement is not met",
  TaskNotFound: "This card no longer exists",
  TaskStorageError: "The board could not record the move",
};

export const moveRefusal: (
  error: RefusedWith,
  fallback: string,
  sentRevision: number,
) => MoveRefusal = refusalWith(REFUSAL_TITLES, "The move did not go through");

/**
 * Whether a refusal still describes the card on screen. Once the card's revision passes the one the
 * server refused at, the card has moved on — a CLI move, another browser, a run — and the refusal is
 * about a card that no longer exists, so the pane drops it rather than showing it over the new
 * column's moves.
 */
export const refusalIsCurrent = <R extends { readonly atRevision: number }>(
  refusal: R | null,
  task: Pick<Task, "revision">,
): refusal is R => refusal !== null && task.revision <= refusal.atRevision;

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
 * The last write the card pane landed on a card: the card and the revision the server answered. One
 * per pane, not one per section, because a move and a comment (LOB-239) bump the same revision — an
 * answer lands at R+2 — so either write has to hold both sends until the board read catches up, or
 * the other section sends the old revision and is refused as stale for the person's own write.
 */
export type Landed = {
  readonly taskId: Task["id"];
  readonly revision: number;
} | null;

/** The revision the pane is waiting to see on `task`, or `null` when nothing it wrote is pending. */
export const landedOn = (
  landed: Landed,
  task: Pick<Task, "id">,
): number | null =>
  landed !== null && landed.taskId === task.id ? landed.revision : null;

/** `landed` after a write on `taskId` came back at `revision`: never earlier than one already landed. */
export const recordLanding = (
  landed: Landed,
  taskId: Task["id"],
  revision: number,
): Landed => {
  const previous = landedOn(landed, { id: taskId });
  return {
    taskId,
    revision: previous === null ? revision : Math.max(previous, revision),
  };
};

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
