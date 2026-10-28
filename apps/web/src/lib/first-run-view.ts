import type { BoardInstanceId, TaskId } from "@repo/domain/Task";

/**
 * Where the dashboard opens, and the getting-started checklist an empty control plane shows (C9).
 *
 * The owner's report was "when I open UI I can't do anything": the root redirected to an empty
 * session list, and every other section was an empty state with nothing to press. The board is the
 * primary surface (docs/board.md), so the root opens on it, and a control plane that has done none of
 * the four things a board needs says what they are, in order, with the form each one is a press away
 * from. Pure on purpose, so the cases a screenshot cannot settle (two boards, a card on the second
 * board only, a run with no card yet) are unit cases.
 */

/**
 * The board `/` and the logo open when exactly one exists, else `undefined`: with none there is
 * nothing to open and the boards page is where a board is made, and with several the choice is the
 * operator's, so the list is the answer rather than the newest board guessed.
 */
export const soleBoard = (
  boards: ReadonlyArray<{ readonly id: BoardInstanceId }>,
): BoardInstanceId | undefined =>
  boards.length === 1 ? boards[0]?.id : undefined;

/**
 * What the checklist reads, off `listRepos`, `listBoards`, `listTasks` and `listTaskRuns`: counts
 * and the first of each thing a later step opens. `card` is the first card found on any board, and
 * `hasRun` whether any card has a run.
 */
export type FirstRunFacts = {
  readonly repos: number;
  readonly boards: ReadonlyArray<BoardInstanceId>;
  readonly card:
    | undefined
    | { readonly boardId: BoardInstanceId; readonly taskId: TaskId };
  readonly hasRun: boolean;
};

export type FirstRunStepId = "repo" | "board" | "card" | "run";

/**
 * Where a step's press goes. A step whose form needs something an earlier step makes (a card needs
 * a board to sit on, a run needs a card to start from) has `blocked`, which names it, instead of a
 * link to a form that cannot work yet.
 */
export type FirstRunAction =
  | { readonly kind: "repos" }
  | { readonly kind: "new-board" }
  | { readonly kind: "new-card"; readonly boardId: BoardInstanceId }
  | {
      readonly kind: "open-card";
      readonly boardId: BoardInstanceId;
      readonly taskId: TaskId;
    }
  | { readonly kind: "blocked"; readonly until: string };

export type FirstRunStep = {
  readonly id: FirstRunStepId;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
  readonly done: boolean;
  readonly action: FirstRunAction;
};

/**
 * The four steps in order, each ticked when the control plane holds the thing it makes. A run
 * started from a card implies the card, the board and a repository to cut its worktree from, so a
 * run ticks every step: a control plane whose boards were made over a slug nobody registered (`factory
 * board create --repo`, or a board older than the registry) is in use, and is never nagged for the
 * repository it already runs from.
 *
 * `currentBoard` is the board the checklist is shown on, when it is shown on one: the card step
 * links to that board's form, and to the newest board's only when it is shown elsewhere.
 */
export const firstRunSteps = (
  facts: FirstRunFacts,
  currentBoard?: BoardInstanceId,
): ReadonlyArray<FirstRunStep> => {
  const board =
    currentBoard !== undefined && facts.boards.includes(currentBoard)
      ? currentBoard
      : facts.boards[0];
  return [
    {
      id: "repo",
      title: "Register a repository",
      detail: "The checkout a run is cut a worktree from.",
      actionLabel: "Register a repository",
      done: facts.repos > 0 || facts.hasRun,
      action: { kind: "repos" },
    },
    {
      id: "board",
      title: "Create a board",
      detail: "One board binds a repository to a definition version.",
      actionLabel: "Create a board",
      done: facts.boards.length > 0 || facts.hasRun,
      action: { kind: "new-board" },
    },
    {
      id: "card",
      title: "Add a card",
      detail: "A card is a unit of work: what a run is for.",
      actionLabel: "Add a card",
      done: facts.card !== undefined || facts.hasRun,
      action:
        board === undefined
          ? { kind: "blocked", until: "a board exists" }
          : { kind: "new-card", boardId: board },
    },
    {
      id: "run",
      title: "Start a run",
      detail:
        "Open the card, move it out of intake, and press Start run: a session works on it.",
      actionLabel: "Open the card",
      done: facts.hasRun,
      action:
        facts.card === undefined
          ? { kind: "blocked", until: "a card exists" }
          : { kind: "open-card", ...facts.card },
    },
  ];
};

/** Whether every step is ticked: the checklist has nothing left to say and is not shown. */
export const firstRunComplete = (facts: FirstRunFacts): boolean =>
  firstRunSteps(facts).every((step) => step.done);

/** The step the person does next: the first unticked one. */
export const nextStep = (
  facts: FirstRunFacts,
  currentBoard?: BoardInstanceId,
): FirstRunStep | undefined =>
  firstRunSteps(facts, currentBoard).find((step) => !step.done);
