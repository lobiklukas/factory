import type { BoardInstanceId } from "@repo/domain/Task";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { APPROVALS_KEY, BOARD_KEY, BOARD_POLL } from "./board-atom";

/** The key for "every board": an atom family is keyed by value, and one key must mean all of them. */
export const ALL_BOARDS = "all";

/**
 * What needs a person (LOB-77): `listAttention` on one board, or on every board for `ALL_BOARDS`.
 *
 * One server read, polled with the board (`BOARD_POLL`), because what makes a card need a person
 * changes off this page — a run asks, a run goes idle at a gate, the CLI answers a question — and
 * the view has to follow it without a reload. A move, a decision or an answer made from this
 * dashboard re-reads it at once (`BOARD_KEY`, `APPROVALS_KEY`).
 */
export const attentionAtom = Atom.family(
  (scope: BoardInstanceId | typeof ALL_BOARDS) =>
    runtime
      .atom(
        Effect.gen(function* () {
          const rpc = yield* RpcClient;
          return yield* rpc.client.listAttention(
            scope === ALL_BOARDS ? {} : { boardId: scope },
          );
        }),
      )
      .pipe(
        Atom.withReactivity([BOARD_KEY, APPROVALS_KEY]),
        Atom.withRefresh(BOARD_POLL),
      ),
);
