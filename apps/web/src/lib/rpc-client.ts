import { RpcApi } from "@repo/domain/Rpc";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient as EffectRpcClient, RpcSerialization } from "effect/rpc";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:9000";

/**
 * The dashboard's control-plane credential (LOB-20), sent as `Authorization: Bearer` on every call.
 * A build-time value, so it is in the bundle: whoever can load the dashboard holds it, which is the
 * shared-token model a local control plane runs (`FACTORY_API_TOKEN`, or a `FACTORY_API_TOKENS` row
 * for the dashboard's own actor). Unset, no header is sent, which only an open control plane serves.
 */
const API_TOKEN = (import.meta.env.VITE_FACTORY_API_TOKEN ?? "").trim();

const ProtocolLive = EffectRpcClient.layerProtocolHttp({
  url: `${SERVER_URL}/rpc`,
  ...(API_TOKEN === ""
    ? {}
    : {
        transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
          HttpClient.mapRequest(
            client,
            HttpClientRequest.bearerToken(API_TOKEN),
          ),
      }),
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
