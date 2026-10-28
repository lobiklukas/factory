import { Effect } from "effect";
import type { BoardInstanceId, TaskId } from "@repo/domain/Task";
import type { FirstRunFacts } from "./first-run-view";

/**
 * The four reads the checklist ticks from, as the RPC client offers them (C9). A structural type
 * rather than the client, so the reading below is a unit case with a fake that counts its calls.
 */
export type FirstRunReads<E1, E2 = E1, E3 = E1, E4 = E1> = {
  readonly listRepos: (input: {}) => Effect.Effect<
    { readonly repos: ReadonlyArray<unknown> },
    E1
  >;
  readonly listBoards: (input: {}) => Effect.Effect<
    ReadonlyArray<{ readonly id: BoardInstanceId }>,
    E2
  >;
  readonly listTasks: (input: {
    readonly boardId: BoardInstanceId;
  }) => Effect.Effect<ReadonlyArray<{ readonly id: TaskId }>, E3>;
  readonly listTaskRuns: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<ReadonlyArray<unknown>, E4>;
};

/** How many cards' runs are asked for at once: the width of one step of the probe. */
const RUN_PROBE_WIDTH = 4;

/**
 * Whether any of these cards has a run, stopping at the first batch that answers yes. Every card is
 * asked about, in batches, because a run can be on any of them and a probe that gave up after a few
 * would call a control plane in use empty; what stops the reads is the first run found.
 */
const anyRun = <E1, E2, E3, E4>(
  reads: FirstRunReads<E1, E2, E3, E4>,
  tasks: ReadonlyArray<{ readonly id: TaskId }>,
): Effect.Effect<boolean, E4> =>
  Effect.gen(function* () {
    for (let at = 0; at < tasks.length; at += RUN_PROBE_WIDTH) {
      const batch = yield* Effect.forEach(
        tasks.slice(at, at + RUN_PROBE_WIDTH),
        (task) => reads.listTaskRuns({ taskId: task.id }),
        { concurrency: RUN_PROBE_WIDTH },
      );
      if (batch.some((runs) => runs.length > 0)) return true;
    }
    return false;
  });

/**
 * What the checklist ticks from: `listRepos`, `listBoards`, and then, board by board (newest
 * first), `listTasks` and `listTaskRuns` on that board's cards until a run turns up. Every one is
 * the server's own answer, so a step made from the CLI, a trigger or another browser is ticked here
 * without a reload.
 *
 * Nothing after the first run is read: a run is the last step, and once it exists the checklist has
 * nothing left to say, so the boards after it and the cards after it are not asked about. With no
 * board there is no card and so no run, and the board reads are skipped. A failed read fails the
 * whole read: the checklist shows nothing then rather than a step ticked or unticked on a guess.
 */
export const readFirstRunFacts = <E1, E2, E3, E4>(
  reads: FirstRunReads<E1, E2, E3, E4>,
): Effect.Effect<FirstRunFacts, E1 | E2 | E3 | E4> =>
  Effect.gen(function* () {
    const [repos, boards] = yield* Effect.all(
      [reads.listRepos({}), reads.listBoards({})],
      { concurrency: 2 },
    );
    let card: FirstRunFacts["card"];
    let hasRun = false;
    for (const board of boards) {
      const tasks = yield* reads.listTasks({ boardId: board.id });
      const first = tasks[0];
      if (card === undefined && first !== undefined) {
        card = { boardId: board.id, taskId: first.id };
      }
      if (tasks.length === 0) continue;
      hasRun = yield* anyRun(reads, tasks);
      if (hasRun) break;
    }
    return {
      repos: repos.repos.length,
      boards: boards.map((board) => board.id),
      card,
      hasRun,
    };
  });
