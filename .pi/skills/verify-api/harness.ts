// Shared plumbing for this skill's drivers (`drive.ts`, `sigterm.ts`): one evidence format, one
// wait primitive, one RPC client. Two drivers that disagreed about what "PASS" looks like would
// make the evidence unreadable, and the client must be the one the CLI and the dashboard build.
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

/**
 * The RPC client layer for an API base URL: `RpcClient.make(SessionRpc)` over NDJSON, exactly as
 * `apps/web/src/lib/rpc-client.ts` and `apps/cli/src/rpc.ts` build it.
 */
export const protocolFor = (apiUrl: string) =>
  RpcClient.layerProtocolHttp({ url: `${apiUrl}/rpc` }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson),
  );

/** One recorded check: what the driver observed, as it appears in the evidence file. */
export type CheckRecord = {
  readonly passed: boolean;
  readonly detail: string;
};

/** The evidence record a driver accumulates. */
export type Observed = {
  readonly checks: Record<string, CheckRecord>;
};

/** Records a check into `observed.checks`, prints it, and returns the condition. */
export const makeChecker =
  (observed: Observed) =>
  (name: string, condition: unknown, detail: string): boolean => {
    observed.checks[name] = { passed: Boolean(condition), detail };
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
    return Boolean(condition);
  };

/**
 * Poll until `check` yields anything but `false`/`undefined`, so a drive never depends on a fixed
 * delay, and return what it yielded.
 */
export const waitUntil = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* check;
      if (value !== false && value !== undefined) return value as A;
      yield* Effect.sleep(100);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });
