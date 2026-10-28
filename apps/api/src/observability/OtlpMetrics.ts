import { Config, Duration, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization } from "effect/observability";

/**
 * OTLP/HTTP export of the control plane's metrics (LOB-69): the set `@repo/core`'s `metrics.ts`
 * defines and `docs/metrics.md` documents, pushed as OTLP JSON to whatever collector
 * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` names.
 *
 * Not motel: motel ingests logs and traces only (`./Motel.ts`), so this is a separate exporter
 * with its own endpoint, and nothing here is proven by reading motel. The gate's proof is an
 * in-process OTLP/HTTP receiver (`./OtlpMetrics.test.ts`); `docs/testing-third-parties.md` has the
 * row saying what that receiver cannot prove.
 *
 * Off unless the endpoint is set, as the motel exporter is: a run with no collector has no
 * exporter retrying a POST nobody answers. The variable names are OpenTelemetry's own, so an
 * operator's collector config carries over:
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` — the full URL metrics are posted to, used as given
 *   (a collector's is `http://<host>:4318/v1/metrics`).
 * - `OTEL_METRIC_EXPORT_INTERVAL` — milliseconds between exports; 60000 by default, the
 *   specification's. The last export is made on shutdown.
 * - `OTEL_SERVICE_NAME` — the resource's `service.name`, `factory-api` by default (shared with the
 *   motel exporter).
 *
 * Temporality is cumulative: every export carries totals since the process started, which is what
 * a Prometheus-backed collector expects and what survives a lost export.
 */
export const OtlpMetricsConfig = Config.all({
  // A URL, so a malformed one refuses the boot rather than failing every export quietly.
  endpoint: Config.option(Config.URL("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")),
  // Positive, because the exporter clamps a zero or negative interval to zero: a busy loop.
  exportIntervalMs: Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "OTEL_METRIC_EXPORT_INTERVAL",
  ).pipe(Config.withDefault(60_000)),
  serviceName: Config.String("OTEL_SERVICE_NAME").pipe(
    Config.withDefault("factory-api"),
  ),
});

export const OtlpMetricsLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* OtlpMetricsConfig;

    if (Option.isNone(config.endpoint)) {
      return Layer.empty;
    }

    const endpoint = config.endpoint.value;
    // Origin and path only: a collector's URL may carry a credential in its userinfo or query.
    yield* Effect.logInfo(
      `Exporting OTLP metrics to ${endpoint.origin}${endpoint.pathname} every ${config.exportIntervalMs}ms`,
    );

    return OtlpMetrics.layer({
      url: endpoint.href,
      resource: { serviceName: config.serviceName },
      exportInterval: Duration.millis(config.exportIntervalMs),
      temporality: "cumulative",
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
    );
  }),
);
