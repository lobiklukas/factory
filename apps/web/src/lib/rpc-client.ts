import { RpcApi } from "@repo/domain/Rpc";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient as EffectRpcClient, RpcSerialization } from "effect/rpc";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:9000";

const ProtocolLive = EffectRpcClient.layerProtocolHttp({
  url: `${SERVER_URL}/rpc`,
}).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);

/**
 * The dashboard's one client over the API's whole RPC surface: sessions, approvals, and the board's
 * `TasksRpc` group (LOB-75), the same `RpcApi` the server mounts at `/rpc`.
 */
export class RpcClient extends Context.Service<RpcClient>()("RpcClient", {
  make: Effect.gen(function* () {
    return {
      client: yield* EffectRpcClient.make(RpcApi),
    } as const;
  }),
}) {
  static layer = Layer.effect(RpcClient)(RpcClient.make).pipe(
    Layer.provide(ProtocolLive),
  );
}
