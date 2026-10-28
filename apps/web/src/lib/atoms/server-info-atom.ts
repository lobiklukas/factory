import { Duration, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/**
 * How often the shell re-reads `getServerInfo` (LOB-272). The answer is fixed for a process, but the
 * banner it drives tells the operator to set a key and restart, and the page should then stop
 * warning without a reload. The call reads no database, so ten seconds is cheap.
 */
export const SERVER_INFO_POLL = Duration.seconds(10);

/** What the control plane is running: the model backend and why, from `getServerInfo` (LOB-269). */
export const serverInfoAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.getServerInfo({});
    }),
  )
  .pipe(Atom.withRefresh(SERVER_INFO_POLL));
