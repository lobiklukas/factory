---
name: motel-debug
description: Debug factory with runtime evidence from motel, the repo's local OpenTelemetry ingest server. Use when a bug needs traces or logs to decide it, when adding temporary debug instrumentation that gets removed later, or when checking that OTLP export from apps/api or apps/cli actually reaches a collector. Vendored from https://github.com/kitlangton/motel and adapted to this repo's scripts, service names, and effect/observability wiring.
---

# Motel Debug

Debug with runtime evidence, not guesswork. motel is the local OpenTelemetry server this repo
already exports to: `apps/api` and `apps/cli` send OTLP logs and traces when `MOTEL_URL` is set.

- Base URL: `http://127.0.0.1:27686`
- OTLP logs: `POST /v1/logs`
- OTLP traces: `POST /v1/traces`
- Query API: `GET /api/*` — spec at `GET /openapi.json`
- Services: `factory-api` (apps/api), `factory-cli` (apps/cli)
- No metrics: the exporters in this repo cover logs and traces only.

## Workflow

### 1. Make sure motel is running, then make sure the app is sending

```bash
bun run motel:status    # JSON status, including pid and database path
bun run motel:start     # idempotent; do NOT run `bun run motel`, the TUI blocks
```

The daemon is machine-global and shared across local projects. After starting, re-check:

```bash
curl -sf http://127.0.0.1:27686/api/health
curl -s http://127.0.0.1:27686/api/services
```

If `/api/services` is empty while the app is running, the app is not exporting: `MOTEL_URL`
is unset. That is the default — export is opt-in, so a run that is not being debugged ships
nothing.

If `motel:start` fails with `effect/net/NetAddress`, the isolated install drifted from its
lockfile. Run `bun install --cwd tools/motel` and read `tools/motel/README.md`.

### 2. Generate hypotheses

Before touching code, write 3–5 specific hypotheses. "The cache key does not include the user
id" beats "something is wrong with caching".

### 3. Instrument

Wrap every temporary block in these markers, and tag it so you can find it later:

```ts
// #region motel debug
yield *
  Effect.logInfo("before acquire", {
    debug: {
      session: "abc123",
      hypothesis: "owner-lost",
      step: "before-acquire",
    },
  });
// #endregion motel debug
```

| Key                | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `debug.session`    | groups all instrumentation for this debug session |
| `debug.hypothesis` | links to one hypothesis                           |
| `debug.step`       | position in the flow (`entry`, `before-write`, …) |
| `debug.label`      | human-readable description of the capture point   |

At least one instrumentation point; two to six is typical; never more than ten. Put searchable
values in the structured fields, not only in the log body.

This repo is Effect — see `references/effect.md` before changing runtime wiring.

### 4. Reproduce

If a failing test exists, run it. Otherwise drive the surface with the verification skill that
already exists: `.pi/skills/verify-api` for the API, `.pi/skills/verify-web` for the dashboard.
Both launch on isolated ports and write evidence to `.verify/`, and both accept an environment
you can add `MOTEL_URL` to — a drive run against a telemetry-enabled instance is a drive run
that produces evidence.

Reuse the one reproduction pathway for every iteration.

### 5. Analyze

```bash
curl "http://127.0.0.1:27686/api/logs/search?service=factory-api&attr.debug.session=abc123"
curl "http://127.0.0.1:27686/api/traces/search?service=factory-api&attr.debug.hypothesis=owner-lost"
curl "http://127.0.0.1:27686/api/spans/search?service=factory-api&traceId=<trace-id>"
curl "http://127.0.0.1:27686/api/spans/<span-id>/logs"
```

Two attribute filter prefixes: `attr.<key>=<value>` is exact, `attrContains.<key>=<substring>`
is case-insensitive substring.

List and search responses carry `meta.nextCursor` when more data exists.

For each hypothesis, answer **CONFIRMED**, **REJECTED**, or **INCONCLUSIVE**, citing the span,
log, or attribute that decided it.

### 6. Fix with evidence

Do not fix without runtime evidence. Keep the instrumentation, make the smallest change that
matches what the evidence shows, and reuse the architecture already there.

### 7. Verify the fix

Reproduce again with instrumentation still in place and compare before and after, citing the
records that prove it. If the fix failed, revert the code changes belonging to rejected
hypotheses rather than letting speculative fixes accumulate, and iterate on new ones.

### 8. Clean up

Only after the fix is verified and the user has no remaining issues:

```bash
bun .pi/skills/motel-debug/scripts/clear-motel-debug.ts .
```

Then `git diff` to confirm only the intentional fix remains.

## Query reference

```bash
curl http://127.0.0.1:27686/api/health
curl http://127.0.0.1:27686/api/services
curl "http://127.0.0.1:27686/api/traces?service=factory-api"
curl "http://127.0.0.1:27686/api/traces/<trace-id>"
curl "http://127.0.0.1:27686/api/traces/<trace-id>/spans"
curl "http://127.0.0.1:27686/api/spans/<span-id>"
curl "http://127.0.0.1:27686/api/spans/<span-id>/logs"
curl "http://127.0.0.1:27686/api/logs?service=factory-api"
curl "http://127.0.0.1:27686/api/traces/search?service=factory-api&operation=<text>"
curl "http://127.0.0.1:27686/api/logs/search?service=factory-api&severity=ERROR&body=<text>"
curl http://127.0.0.1:27686/openapi.json
```

## Rules

- Do not log secrets, tokens, passwords, or raw PII. Sessions hold prompts and model output.
- Do not remove instrumentation before post-fix verification succeeds.
- Do not use `setTimeout`, `sleep`, or an artificial delay as a fix.
- The SQLite store is machine-local development data, not a log to keep forever: it retains
  seven days. Do not commit anything out of it.

## Cleanup

`scripts/clear-motel-debug.ts` removes every block between `#region motel debug` and
`#endregion motel debug` in JS/TS files under a path (default: the current directory) and fails
on unmatched markers. If you cannot run it, delete the blocks by hand and grep for
`#region motel debug` to confirm none remain.
