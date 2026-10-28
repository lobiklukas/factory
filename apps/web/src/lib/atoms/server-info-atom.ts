import { Effect } from "effect";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/**
 * What the control plane is running (LOB-269's `getServerInfo`), read once per page load: the
 * models the New session picker offers (LOB-274) are its catalog, and its default is what the
 * picker's first choice means. The answer is boot configuration, so nothing on the page changes it
 * and a re-read could only find a restarted server.
 */
export const serverInfoAtom = runtime.atom(
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.getServerInfo({});
  }),
);
