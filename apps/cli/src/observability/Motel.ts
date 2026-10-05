import { Config, Duration, Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import {
  OtlpLogger,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability";

/**
 * OTLP/HTTP export to a local motel server (https://github.com/kitlangton/motel).
 *
 * Off unless `MOTEL_URL` is set, so a normal run ships no telemetry and a run without
 * a daemon on the other end has no exporter to log export failures from. Point it at
 * `bun run motel` — that server is the reader for what this layer writes.
 *
 * Logs and traces only: those are the two signals motel ingests, so adding metrics
 * would just mean a POST to a path that answers 404 and a retry loop with it.
 */
const MotelConfig = Config.all({
  baseUrl: Config.option(Config.String("MOTEL_URL")),
  serviceName: Config.String("OTEL_SERVICE_NAME").pipe(
    Config.withDefault("factory-cli"),
  ),
});

// motel's TUI is interactive, so records land on a tick rather than on a shutdown.
const ExportInterval = Duration.millis(500);

export const MotelLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MotelConfig;

    if (Option.isNone(config.baseUrl)) {
      return Layer.empty;
    }

    const baseUrl = config.baseUrl.value;
    const base = HttpClientRequest.get(baseUrl);

    yield* Effect.logInfo(
      `Exporting OTLP logs and traces to motel at ${baseUrl}`,
    );

    return Layer.mergeAll(
      OtlpLogger.layer({
        url: HttpClientRequest.appendUrl(base, "/v1/logs").url,
        resource: { serviceName: config.serviceName },
        exportInterval: ExportInterval,
      }),
      OtlpTracer.layer({
        url: HttpClientRequest.appendUrl(base, "/v1/traces").url,
        resource: { serviceName: config.serviceName },
        exportInterval: ExportInterval,
      }),
    ).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
    );
  }),
);
