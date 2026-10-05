# Effect notes

Apply these only to the Effect code in this repo — `apps/api`, `apps/cli`, `packages/*`.

## Runtime wiring

This repo is on **effect 4.0.0 stable**, so the OTLP modules live in `effect/observability`
(`OtlpLogger`, `OtlpTracer`, `OtlpSerialization`, `OtlpResource`). Do not add
`@effect/opentelemetry` or `@opentelemetry/*` — that is the beta-era surface motel itself was
built against, and this repo is past it.

The exporters are already wired:

- `apps/api/src/observability/Motel.ts`
- `apps/cli/src/observability/Motel.ts`

Both are merged into their app's runtime next to `DevToolsLive` and both return `Layer.empty`
unless `MOTEL_URL` is set. Change the wiring there, once, rather than adding a second exporter
per feature or per request path. If a new process needs to report to motel, give it the same
layer shape — `OtlpLogger.layer` plus `OtlpTracer.layer` over `OtlpSerialization.layerJson`
and `FetchHttpClient.layer`.

Metrics are deliberately absent: motel ingests logs and traces, so a metrics exporter would be
a POST to a path that answers 404, retried forever.

## Instrumentation

- Prefer `Effect.fn("...")` for meaningful workflow spans.
- Add a few child spans around boundaries that are likely to fail or add latency.
- Emit `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError` with structured fields.
- Put searchable values in the structured fields, not only in the free-form message.
- Reuse `debug.session`, `debug.hypothesis`, `debug.step`, and `debug.label`.

## Debug blocks

Wrap temporary instrumentation in removable markers:

```ts
// #region motel debug
const program = Effect.fn("session/acquire")(function* () {
  yield* Effect.logInfo("entering acquire", {
    debug: {
      session: "abc123",
      hypothesis: "owner-lost",
      step: "entry",
    },
  });
});
// #endregion motel debug
```

Keep those blocks until the fix is verified, then remove them with the cleanup script.
