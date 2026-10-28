# Metrics to a local collector

**What it is.** The control plane's metric set (`docs/metrics.md`): sessions created, sessions this
process owns, run duration and refusals, each with a documented unit, exported over OTLP/HTTP to the
collector `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` names (LOB-69). Off when the variable is unset.

**How a user reaches it.** An operator sets `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (and, optionally,
`OTEL_METRIC_EXPORT_INTERVAL` in milliseconds) and points it at a collector's OTLP/HTTP receiver.
Every session created, run and refused over RPC then moves the numbers the next export carries. The
boot log says `Exporting OTLP metrics to <origin><path> every <n>ms`.

**How the skill drives it.** `./metrics.sh` starts `otlp-receiver.ts` — a `Bun.serve` OTLP/HTTP
receiver on loopback that keeps every `POST /v1/metrics` body and serves them back at `GET
/received` — and boots the API (`./up.sh`, faux) with the endpoint at it and a 500 ms interval, with
`MOTEL_URL` unset. `metrics.ts` creates a session over RPC, runs it to idle, has a 100,001-character
message refused, then waits for one export that carries the whole set and checks it: the path and
the JSON content type, `service.name` `factory-api`, `factory.session.creates{origin=create}`,
`factory.session.active`, a recorded `factory.run.duration` (count ≥ 1, a sum in seconds) and
`factory.refusals{reason=message_too_long}`, each under the unit `docs/metrics.md` documents. The
shell also checks the boot log names the endpoint.

**Observable end state.** `.verify/evidence/latest/api/metrics.json` (every check, and the reading
of the matched export), `metrics-received.ndjson` (every body the receiver was sent) and
`metrics-api.log`. With the endpoint left out of the boot, the receiver is sent nothing and the drive
fails `an export carrying the whole set arrived` (`.verify/evidence/lob-69/mutation-no-endpoint/`).

**What it does not prove.** That a real OpenTelemetry Collector accepts the body, the protobuf
encoding, the exporter's retry and pause on a failing collector, and what a backend does with the
names and units — the OTLP row of `docs/testing-third-parties.md` lists them. Not motel: motel has no
metrics route, so nothing here reads it. The `busy`, `released` and `budget` refusals and the `fork`
and `replay` origins are moved in the gate (`packages/core/src/metrics.test.ts`), not by this drive;
admission control's refusal is LOB-70 and queue depth is LOB-71.
