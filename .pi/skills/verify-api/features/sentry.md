# The Sentry receiver (LOB-81, part 1 of LOB-33)

**What it is.** The inbound path for Sentry alerts, and its safety: `POST /webhooks/sentry` →
`apps/api/src/Api/Webhook.ts` (the body cap, the signature, the rate cap) →
`packages/core/src/Sentry.ts` (Sentry's signature check, its payload as a `TriggerEvent`, and the
delivery's key) → the same trigger seam every adapter delivers to (`TriggerService`, dedupe in
`webhook_deliveries`) → `SessionService`. A signed issue alert (`Sentry-Hook-Resource: event_alert`,
`action: "triggered"`) is a `create` keyed by its event (`sentry:event:<event_id>`), so the same
alert delivered twice — or once by each of two alert rules — opens one session, and the key is a
Postgres row, so a restarted process still knows it. Every other Sentry resource is answered and
recorded as a skip that names it (`action "issue:resolved" is not "create"`).

**How a user reaches it.** An operator creates a Sentry internal integration whose webhook URL is
the route, sets `SENTRY_CLIENT_SECRET` to its Client Secret, and adds a rule to `TRIGGER_RULES` for
the `sentry` label (every delivery carries it) or `sentry:project:<id>` (one project, ahead of the
catch-all). Unset secret: every delivery is `503 not-configured`. The route admits at most
`SENTRY_RATE_LIMIT` signed deliveries per `SENTRY_RATE_WINDOW_SECONDS` in one process (20 per 60 s by
default); past it, `429 rate-limited` with `Retry-After`, the limit and the window. A refusal before
the seam — `401`, `413`, `429` — writes one warning naming the route, the code, the `Request-ID` and
the body's size, and never the body.

**How the skill drives it.** `./sentry.sh` boots the skill's API (`up.sh`) with
`SENTRY_CLIENT_SECRET`, `SENTRY_RATE_LIMIT=6`, and one `sentry` rule on a per-run repo, then runs
`bun sentry.ts` in two phases around a restart, in `sigterm.sh`'s shape:

1. **first** — a signed alert opens a session; the same payload with the same headers again is
   `replayed: true`, and the repo has one session; the session's first message carries the alert's
   title and rule. A missing signature is `401 missing-signature` and a signature of another body
   `401 bad-signature`; neither opens a session or leaves a `webhook_deliveries` row (read from the
   API's database); each refusal is one log line naming its reason and its `Request-ID`, and no line
   in the API's log carries the canary string both payloads contain. Then a burst of ten signed
   `issue` deliveries: the ones past the cap are `429 rate-limited` with `Retry-After` equal to the
   body's `retryAfterSeconds` and `limit: 6`, none is a `5xx`, none leaves a row, and the ones inside
   the cap are recorded skips.
2. **restart** — `down.sh` stops the process (SIGTERM, then SIGKILL if it lingers), and `up.sh`
   boots a fresh one on the same database; the script checks the pid changed.
3. **after-restart** — the same alert (a new `Request-ID`) is `replayed: true` with status
   `processed`, the repo still has one session, and the row the first process wrote is still
   `processed`. The control: a new alert in the restarted process opens its session, so the replay
   is the dedupe and not a process that cannot create.

**What proves it works.** `.verify/evidence/lob-81/` (gitignored): `sentry-first.json` and
`sentry-after-restart.json` (each phase's checks and every delivery's answer), `sentry-process.json`
(the script's checks), and both processes' logs. `packages/core/src/Sentry.test.ts` proves the
signature, the filter and the key in isolation, and the dedupe through the real seam on Postgres —
including across two runtimes; `apps/api/src/Api/SentryWebhook.test.ts` proves the route's 401s and
their log line with a recording logger, and that the cap counts only signed deliveries.

**Non-vacuity.** `mutation-key-by-request-id/`: keying an alert by its `Request-ID` instead of its
event (the "obvious" key) passes the whole first phase — the drive's two posts share one request id —
and fails three after-restart checks: the fresh process opens a second session for the same alert.

**What it cannot prove.** That Sentry signs the bytes it sends, whether Sentry retries a delivery
or keeps its `Request-ID`, and its 1-second response budget (the route answers after the session
is opened). See `docs/testing-third-parties.md`'s Sentry row. The release/environment/severity
filter and the fingerprint binding are LOB-82; the link back to the alert is LOB-83.
