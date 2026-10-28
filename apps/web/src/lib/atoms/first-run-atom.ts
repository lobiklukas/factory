import { Duration, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import type { FirstRunFacts } from "../first-run-view";
import { RpcClient } from "../rpc-client";
import { BOARD_KEY, RUNS_KEY } from "./board-atom";
import { REPOS_KEY } from "./repos-atom";
import { SESSIONS_KEY } from "./session-list";

/**
 * How often the getting-started checklist re-reads. A step is not only this page's to complete: a
 * repository added with `factory repo add`, a card put on the board by a trigger, a run started from
 * the CLI all tick the list, so it polls, slower than a board because it is four small reads and a
 * person is rarely watching it for a change they did not make.
 */
export const FIRST_RUN_POLL = Duration.seconds(4);

/** How many cards' runs are asked for: one run on any of them ticks the step, so a few suffice. */
const RUN_PROBE_CARDS = 10;

/**
 * What the checklist ticks from (C9): `listRepos`, `listBoards`, `listTasks` on each board and
 * `listTaskRuns` on the first few cards found. Every one is the server's own answer, so a step made
 * from the CLI, a trigger or another browser is ticked here without a reload.
 *
 * With no board there is no card and so no run, and the board reads are skipped. A failed read fails
 * the atom: the checklist shows nothing then rather than a step ticked or unticked on a guess.
 */
export const firstRunAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      const [repos, boards] = yield* Effect.all(
        [rpc.client.listRepos({}), rpc.client.listBoards({})],
        { concurrency: 2 },
      );
      const cards = yield* Effect.forEach(
        boards,
        (board) =>
          rpc.client
            .listTasks({ boardId: board.id })
            .pipe(
              Effect.map((tasks) =>
                tasks.map((task) => ({ boardId: board.id, taskId: task.id })),
              ),
            ),
        { concurrency: 4 },
      ).pipe(Effect.map((perBoard) => perBoard.flat()));
      const runs = yield* Effect.forEach(
        cards.slice(0, RUN_PROBE_CARDS),
        (card) => rpc.client.listTaskRuns({ taskId: card.taskId }),
        { concurrency: 4 },
      );
      const facts: FirstRunFacts = {
        repos: repos.repos.length,
        boards: boards.map((board) => board.id),
        card: cards[0],
        hasRun: runs.some((perCard) => perCard.length > 0),
      };
      return facts;
    }),
  )
  .pipe(
    Atom.withReactivity([REPOS_KEY, BOARD_KEY, RUNS_KEY, SESSIONS_KEY]),
    Atom.withRefresh(FIRST_RUN_POLL),
  );

/**
 * The boards `/` decides from. Its own atom rather than `boardsAtom`: nothing holds it open between
 * visits, so every visit to `/` (the logo included) reads the server afresh instead of answering
 * from whatever a boards page read last.
 */
export const homeBoardsAtom = runtime.atom(
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.listBoards({});
  }),
);
