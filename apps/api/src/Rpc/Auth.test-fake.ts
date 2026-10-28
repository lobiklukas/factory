import { Effect, Option, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  controlPlaneAuthLayer,
  DEFAULT_SHARED_ACTOR,
  type TokenTable,
  tokenTableOf,
} from "./Auth";

/**
 * A control plane's credentials for an RPC suite (LOB-20): every suite that serves `SessionRpcLive`
 * serves it with auth on, as a deployment with `FACTORY_API_TOKEN` set does, and its client sends
 * the token — so a suite that forgot the credential fails `Unauthenticated` rather than passing on
 * an open surface.
 */
export const TEST_TOKEN = "rpc-suite-token-0123456789";
export const TEST_ACTOR = "rpc-suite";

/** The token table `entries` (`[actor, token]`) configure, checked as the boot checks it. */
export const testTokens = (
  entries: ReadonlyArray<readonly [string, string]>,
): TokenTable => {
  const table = Effect.runSync(
    tokenTableOf({
      token: Option.none(),
      actor: DEFAULT_SHARED_ACTOR,
      authOff: false,
      tokens: Option.some(
        Redacted.make(
          entries.map(([actor, token]) => `${actor}=${token}`).join(","),
        ),
      ),
    }),
  );
  if (table === undefined) throw new Error("a test token table names no token");
  return table;
};

/** `ControlPlaneAuth` with one credential: `TEST_TOKEN`, authenticating as `TEST_ACTOR`. */
export const TestControlPlaneAuth = controlPlaneAuthLayer(
  testTokens([[TEST_ACTOR, TEST_TOKEN]]),
);

/** `RpcClient.layerProtocolHttp`'s `transformClient`: every request carries `token`. */
export const sendingToken =
  (token: string) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
    HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token));
