// Shared plumbing for this skill's drivers (`drive.ts`, `sigterm.ts`): one evidence format, one
// wait primitive, one RPC client. Two drivers that disagreed about what "PASS" looks like would
// make the evidence unreadable, and the client must be the one the CLI and the dashboard build.
import { Effect, Layer, Option, Schema } from "effect";
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

/**
 * What `/livez` and `/readyz` answer (`apps/api/src/Api/Probes.ts`): a status word and, on
 * `/readyz`, one entry per dependency it checked.
 */
const ProbeAnswer = Schema.Struct({
  status: Schema.String,
  checks: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean })),
  ),
});
export type ProbeAnswer = typeof ProbeAnswer.Type;

/**
 * One plain-HTTP probe of a route the RPC client cannot reach. `body` is the JSON exactly as it
 * arrived, for the evidence; `answer` is that body decoded as a probe answer, or `null` when it is
 * not one, so a check reads typed fields and a wrong shape fails the check instead of the driver.
 */
export const probeFor =
  (apiUrl: string) =>
  async (
    route: string,
  ): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly answer: ProbeAnswer | null;
  }> => {
    const response = await fetch(`${apiUrl}${route}`);
    const body: unknown = await response.json().catch(() => null);
    return {
      status: response.status,
      body,
      answer: Option.getOrNull(Schema.decodeUnknownOption(ProbeAnswer)(body)),
    };
  };

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
  check: Effect.Effect<A | false | undefined, E, R>,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* check;
      if (value !== false && value !== undefined) return value;
      yield* Effect.sleep(100);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });
