import { Duration, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { runtime } from "../atom";
import type { FirstRunFacts } from "../first-run-view";
import { readFirstRunFacts } from "../first-run-read";
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

/**
 * What the checklist ticks from (C9): see `readFirstRunFacts` for the reads and where they stop.
 *
 * Once a run exists the checklist is complete for good (a run is the last step and cannot be
 * un-made), so a refresh after that answers with the facts it already holds and reads nothing: an
 * open /boards tab on a control plane in use costs no requests, however long it stays open.
 */
export const firstRunAtom = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const previous = Option.flatMap(
        get.self<AsyncResult.AsyncResult<FirstRunFacts, unknown>>(),
        (result) => AsyncResult.value(result),
      );
      if (Option.isSome(previous) && previous.value.hasRun) {
        return previous.value;
      }
      const rpc = yield* RpcClient;
      return yield* readFirstRunFacts(rpc.client);
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
