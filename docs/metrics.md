# Metrics

What the control plane (`apps/api`) exports as metrics, and how to receive them. The definitions
are `packages/core/src/metrics.ts`; this page is the operator's copy and changes with it.

## Turning it on

Metrics leave the process over OTLP/HTTP (JSON) to any OpenTelemetry-compatible receiver — an
OpenTelemetry Collector's `otlp` receiver, or a backend's OTLP intake. Off unless the endpoint is
set; the variable names are OpenTelemetry's own.

| Variable                              | Meaning                                                                                                                               | Default          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | The full URL metrics are posted to, used as given (a collector's is `http://host:4318/v1/metrics`). A malformed URL refuses the boot. | unset: no export |
| `OTEL_METRIC_EXPORT_INTERVAL`         | Milliseconds between exports; a positive integer. The last export is made on shutdown.                                                | `60000`          |
| `OTEL_SERVICE_NAME`                   | The resource's `service.name`.                                                                                                        | `factory-api`    |

Temporality is **cumulative**: every export carries totals since the process started. A restart
starts the totals again, which a collector reads as a counter reset.

**Not motel.** `MOTEL_URL` exports logs and traces to motel (`bun run motel`), which ingests nothing
else; metrics go to the endpoint above, never to motel.

The CLI (`apps/cli`) exports no metrics: it hosts no session, so none of the set below happens in its
process.

## The metric set

Names are OpenTelemetry-style (dotted); a Prometheus backend translates them (`factory.refusals` →
`factory_refusals_total`). Units are UCUM, as the OpenTelemetry semantic conventions write them.
Effect also sends each metric's unit as a `unit` point attribute beside the metric's own `unit`
field.

| Metric                    | Instrument              | Unit        | Attributes                                                 | What it counts                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------- | ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory.session.creates` | counter (monotonic sum) | `{session}` | `origin`: `create`, `fork`, `replay`                       | Sessions created. A `createSession` the request-id dedupe answers with an existing session is not counted; a fork or replay refused before it exists is not counted.                                                                                                                              |
| `factory.session.active`  | gauge                   | `{session}` | —                                                          | Sessions this process owns right now: an open harness and a held log, from the open that creates or wakes a session to the release that closes it (idle sweep, workspace release, shutdown). A session nobody owns is in the database, not here, so the sum over replicas is the fleet's.         |
| `factory.run.duration`    | histogram               | `s`         | —                                                          | Wall time of a run: from the session turning busy to idle again, as its owner saw it. Buckets: 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600. A run cut short by its owner's release (workspace release, shutdown) is not recorded; one resumed after a restart is timed from the reopen. |
| `factory.refusals`        | counter (monotonic sum) | `{refusal}` | `reason`: `message_too_long`, `busy`, `released`, `budget` | Requests the factory understood and declined: a message over the length cap, a `whenBusy: "reject"` message to a running session, a start on a session whose workspace was released, and a model request stopped by the session's budget.                                                         |

A metric appears in an export once it has been updated in that process: a fresh process with no
session yet sends none of them.

## How it is proven

`apps/api/src/observability/OtlpMetrics.test.ts` points the real exporter at an in-process OTLP/HTTP
receiver and creates a session; `packages/core/src/metrics.test.ts` moves each metric through the
service path that owns it; `.pi/skills/verify-api/metrics.sh` boots the API against a loopback
receiver (`features/metrics.md`). What a receiver of our own cannot prove — that a real collector
accepts the body, what a backend does with the names — is the OTLP row of
`docs/testing-third-parties.md`.

Admission control's refusal (LOB-70) and the board's queue depth (LOB-71) join this set when they
land.
