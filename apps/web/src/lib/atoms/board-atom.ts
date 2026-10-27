import type { BoardInstanceId } from "@repo/domain/Task";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/**
 * The boards this control plane holds (LOB-75), newest first: what `/boards` offers to open.
 *
 * A server read and nothing else. There is no local copy to fall back on, so a reload always shows
 * what the server has — which is the whole point of the route.
 */
export const boardsAtom = runtime.atom(
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.listBoards({});
  }),
);

/**
 * One board as the lanes need it: the instance with the definition version it binds, and its cards.
 *
 * Two calls, issued together. `getBoard` answers the definition in one statement, so the lane order
 * is the pinned version's (B2); `listTasks` answers every card on the board in the server's order
 * (B9). A failure of either fails the read, rather than showing lanes with no cards — an empty lane
 * and a lane whose cards failed to load must not look the same.
 */
export const boardAtom = Atom.family((boardId: BoardInstanceId) =>
  runtime.atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      const [view, tasks] = yield* Effect.all(
        [rpc.client.getBoard({ boardId }), rpc.client.listTasks({ boardId })],
        { concurrency: 2 },
      );
      return { ...view, tasks };
    }),
  ),
);
