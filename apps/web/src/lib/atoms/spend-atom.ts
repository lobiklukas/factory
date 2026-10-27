import { Duration, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { SESSIONS_KEY } from "./session-list";

/**
 * How often the spend pane re-reads `listSpend`. Spend moves as runs make model requests, which
 * happens off this page, so the pane polls; one grouped query over the index is cheap (R6), and five
 * seconds is fresh enough for a number an operator reads rather than watches.
 */
export const SPEND_POLL = Duration.seconds(5);

/**
 * Spend keyed by repo and actor (LOB-162): `listSpend`, the server's grouped read of the session
 * index. A session started from this dashboard re-reads it at once (`SESSIONS_KEY`).
 */
export const spendAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listSpend({});
    }),
  )
  .pipe(Atom.withReactivity([SESSIONS_KEY]), Atom.withRefresh(SPEND_POLL));
