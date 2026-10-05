import { SessionRpc } from "@repo/domain/Rpc";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient as EffectRpcClient, RpcSerialization } from "effect/rpc";

/**
 * The session RPC client, built the way `apps/web/src/lib/rpc-client.ts` builds it: the same
 * `RpcClient.make(SessionRpc)` over NDJSON.
 *
 * The difference is the URL. The dashboard reads it once at module load from its build config; a
 * CLI run is one shot with a URL chosen by `--api` or the environment, so the layer is a function
 * of the URL rather than a module constant.
 */
const protocolLive = (apiUrl: string) =>
  EffectRpcClient.layerProtocolHttp({ url: `${apiUrl}/rpc` }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson),
  );

export class SessionClient extends Context.Service<SessionClient>()(
  "SessionClient",
  {
    make: Effect.gen(function* () {
      return {
        client: yield* EffectRpcClient.make(SessionRpc),
      } as const;
    }),
  },
) {
  static layer = (apiUrl: string) =>
    Layer.effect(SessionClient)(SessionClient.make).pipe(
      Layer.provide(protocolLive(apiUrl)),
    );
}

/** The RPC client itself, as `rpc.client` in the dashboard, for a command to hold onto. */
export type SessionRpcClient = SessionClient["Service"]["client"];
