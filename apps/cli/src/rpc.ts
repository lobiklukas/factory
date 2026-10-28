import { RpcApi, SessionRpc } from "@repo/domain/Rpc";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient as EffectRpcClient, RpcSerialization } from "effect/rpc";

/**
 * The control-plane credential (LOB-20): `FACTORY_API_TOKEN`, sent as `Authorization: Bearer` on
 * every call. It is the same variable the API reads as its shared token, so one export runs both
 * locally. Unset (or empty), no header is sent, which only a control plane with auth off serves;
 * one with auth on answers `unauthenticated`. Never a flag: a token on the command line is in every
 * process listing.
 */
const ApiTokenConfig = Config.option(Config.Redacted("FACTORY_API_TOKEN"));

/**
 * The session RPC client, built the way `apps/web/src/lib/rpc-client.ts` builds it: the same
 * `RpcClient.make(SessionRpc)` over NDJSON.
 *
 * The difference is the URL. The dashboard reads it once at module load from its build config; a
 * CLI run is one shot with a URL chosen by `--api` or the environment, so the layer is a function
 * of the URL rather than a module constant. Both send the control-plane credential (LOB-20).
 */
const protocolLive = (apiUrl: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const token = Option.filter(
        yield* ApiTokenConfig,
        (value) => Redacted.value(value).trim() !== "",
      );
      return EffectRpcClient.layerProtocolHttp({
        url: `${apiUrl}/rpc`,
        ...(Option.isSome(token)
          ? {
              transformClient: <E, R>(
                client: HttpClient.HttpClient.With<E, R>,
              ) =>
                HttpClient.mapRequest(
                  client,
                  HttpClientRequest.bearerToken(
                    Redacted.value(token.value).trim(),
                  ),
                ),
            }
          : {}),
      });
    }),
  ).pipe(
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

/**
 * The whole API's client: sessions, approvals and the board's `TasksRpc` group (LOB-61).
 *
 * `factory board start` needs both halves of the surface — it reads a card and then opens the run
 * against it — so the board commands hold one client over `RpcApi` rather than two layers; so do
 * `factory approve` / `deny` (LOB-53), which decide over `ApprovalsRpc` and then follow the session. The
 * session commands keep `SessionClient`, because a command that cannot reach the board should not
 * fail to compile with it.
 */
export class BoardClient extends Context.Service<BoardClient>()("BoardClient", {
  make: Effect.gen(function* () {
    return {
      client: yield* EffectRpcClient.make(RpcApi),
    } as const;
  }),
}) {
  static layer = (apiUrl: string) =>
    Layer.effect(BoardClient)(BoardClient.make).pipe(
      Layer.provide(protocolLive(apiUrl)),
    );
}

/** The merged client, for a board command to hold onto. */
export type BoardRpcClient = BoardClient["Service"]["client"];
