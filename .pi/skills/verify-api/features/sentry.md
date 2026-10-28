# The Sentry receiver and its mapping (LOB-81 and LOB-82, parts 1 and 2 of LOB-33)

**What it is.** The inbound path for Sentry alerts, and its safety: `POST /webhooks/sentry` →
`apps/api/src/Api/Webhook.ts` (the body cap, the signature, the rate cap) →
`packages/core/src/Sentry.ts` (Sentry's signature check, its payload as a `TriggerEvent`, and the
delivery's key) → the same trigger seam every adapter delivers to (`TriggerService`, dedupe in
`webhook_deliveries`) → `SessionService`. A signed issue alert (`Sentry-Hook-Resource: event_alert`,
`action: "triggered"`) is a `create` keyed by its event (`sentry:event:<event_id>`), so the same
alert delivered twice — or once by each of two alert rules — opens one session, and the key is a
Postgres row, so a restarted process still knows it. Every other Sentry resource is answered and
recorded as a skip that names it (`action "issue:resolved" is not "create"`), unless the rule that
routes it opts its action in with `startsWorkFor` (`["issue:created"]`): then it is work, keyed by
its subject and action (`sentry:work:issue:<id>:issue:created`), so a re-send under a new
`Request-ID` is a replay rather than a second session.

**The mapping (LOB-82).** Three things decide what an alert becomes:

- **The filter.** `SENTRY_MIN_LEVEL` (one of `debug`, `info`, `warning`, `error`, `fatal`),
  `SENTRY_ENVIRONMENTS` and `SENTRY_RELEASES` (comma-separated; an entry ending in `*` is a prefix,
  `web@2.*`) narrow which alerts are work; each unset or blank is "any". An alert outside them is
  answered `200` and recorded as a skip in `webhook_deliveries` whose reason names the field and the
  value — `level "warning" is below SENTRY_MIN_LEVEL "error"`, `environment "staging" is not in
SENTRY_ENVIRONMENTS [production]`, `release "web@1.9.0" is not in SENTRY_RELEASES [web@2.*]` (a
  missing field fails a filter that names it: `environment is missing; …`). It is keyed by its
  `Request-ID`, like any delivery that cannot start work, and spends no rate-cap token. A
  `SENTRY_MIN_LEVEL` that is not a level is `503 not-configured` naming the variable, for every
  delivery, until it is fixed; the boot already says so, at error level (`sentry filter:
SENTRY_MIN_LEVEL is "eror"; …`), beside the armed-routes lines, and a valid filter is logged too
  (`sentry filter: level >= error, environments [production], releases any`).
- **The title.** A session's title is the event's title with its environment and release when the
  payload has them: `ReferenceError: x (production, release web@1.2.3)`.
- **The fingerprint.** An alert carries its Sentry issue (`data.event.issue_id`) as the event's
  fingerprint, and the seam binds `sentry:<issue_id>` to the session the issue's first alert opened,
  in Postgres (`trigger_fingerprints`), so the binding outlives a restart. Another event in the same
  issue — the alert firing again, under a new `event_id` — opens no second session while that
  session is open: it is a recorded skip naming it and the way out, `sentry:<issue_id> is bound to
open session ses_… (delivery sentry:event:<first event>), so this delivery opens no second
session; it frees when that session's workspace is released or after 3 days without activity, and
\`factory discard ses_…\` frees it now`. Two events racing for an unbound issue cannot both open
one (the binding is a single `INSERT … ON CONFLICT`). A session counts as closed when its
workspace is released — the card done or canceled, the PR merged, the session discarded
(`factory discard <session>`, the operator's way to unmute an issue at once) — **or** when it has
had no activity for `TRIGGER_FINGERPRINT_IDLE_AFTER`(72 hours;`session_activity`, else the
session's creation). The idle bound is what frees a binding nothing releases: a run that judged
the alert noise and stopped without a PR (the default prompt asks for exactly that), a run that
crashed, a PR closed unmerged, a session-mode run that has no card. The issue's next alert after
that opens a new session and the binding moves to it. A delivery that fails before opening its
session gives the binding back; an event that lost the race to it meanwhile was recorded as
`… is being bound by delivery …, which has not opened its session yet …`, a transient skip that a
redelivery of the same event (another alert rule, a new `Request-ID`) claims afresh rather than
  replays. An event Sentry never sends again stays skipped: the issue's next event opens the session.
- **A card rule.** A rule with `"mode": "card"` (LOB-254) files the alert's card under the issue,
  `externalRef` `sentry:<issue_id>`, not the event, so every event in one issue lands on one card
  (`already on the board as card …`) and the card's runs are the issue's sessions.

**The default prompt (LOB-82).** A rule whose `prompt` is blank (`""`) gets Sentry's own template,
`SENTRY_PROMPT_TEMPLATE` in `packages/core/src/Sentry.ts`, rendered by `renderPrompt` over the
alert's title and the `{{body}}` the receiver writes (one `name: value` line per fact: `alert rule`,
`level`, `culprit`, `release`, `environment`, `issue`, `event`, `link`). Verbatim:

```text
A Sentry alert fired: {{title}}

{{body}}

Investigate before you edit anything. Find where this error is raised and why: read the culprit and the code around it, and reproduce the failure with a test if you can. Then state the root cause in a short paragraph before you change any file.

If the cause is outside this repository, or the alert is noise, say so and stop without editing. Otherwise fix the root cause rather than the symptom, keep the change as small as the fix needs, and open a pull request whose description names the Sentry issue and the root cause.
```

So the documented default rule is `{"label":"sentry","repo":"<owner/name>","prompt":""}`; a rule
that writes its own prompt keeps it.

**How a user reaches it.** An operator creates a Sentry internal integration whose webhook URL is
the route, sets `SENTRY_CLIENT_SECRET` to its Client Secret, and adds a rule to `TRIGGER_RULES` for
the `sentry` label (every delivery carries it) or `sentry:project:<id>` (one project, ahead of the
catch-all). Unset secret: every delivery is `503 not-configured`. The route admits at most
`SENTRY_RATE_LIMIT` signed deliveries that can start work per `SENTRY_RATE_WINDOW_SECONDS` in one
process (20 per 60 s by default); past it, `429 rate-limited` with `Retry-After`, the limit and the
window. The token is taken after normalization, so a delivery that can start nothing (an `issue`,
`comment` or `installation` delivery no rule opts in, a malformed body) spends none: an integration
subscribed to `issue` cannot starve its alerts. A replay of an alert already handled does spend one,
because only the seam's dedupe knows it is a replay. A refusal before
the seam — `401`, `413`, `429` — writes one warning naming the route, the code, the `Request-ID` and
the body's size, and never the body.

**How the skill drives it.** `./sentry.sh` boots the skill's API (`up.sh`) with
`SENTRY_CLIENT_SECRET`, `SENTRY_RATE_LIMIT=6`, the filter `SENTRY_MIN_LEVEL=error`, `SENTRY_ENVIRONMENTS=production`,
`SENTRY_RELEASES=verify@*`, a `sentry` rule on a per-run repo and, ahead of it, a
`sentry:project:404` rule on a repo nobody registers and a `sentry:project:777` rule with a blank
prompt, then runs
`bun sentry.ts` in two phases around a restart, in `sigterm.sh`'s shape:

1. **first** — a signed alert opens a session; the same payload with the same headers again is
   `replayed: true`, and the repo has one session; the session's first message carries the alert's
   title and rule. The session's title is the alert's title with `(production, release verify@1.0.0)`;
   the alert's issue is bound to the session in `trigger_fingerprints`; a new event in the same issue
   is `200` and a recorded skip whose reason names the open session, and the repo still has one
   session. Three alerts of the wrong level, environment and release are each a recorded skip whose
   reason names the field and the value, and open nothing. An alert for project 777 opens a session
   whose first message is exactly the default template rendered over that alert. A missing signature is `401 missing-signature` and a signature of another body
   `401 bad-signature`; neither opens a session or leaves a `webhook_deliveries` row (read from the
   API's database); each refusal is one log line naming its reason and its `Request-ID`, and no line
   in the API's log carries the canary string both payloads contain. Then a firehose of ten signed
   `issue` deliveries: every one is `200` and a recorded skip, none `429`, because none can start
   work. Then a burst of ten signed alerts for project 404: the ones past the cap are `429
rate-limited` with `Retry-After` equal to the body's `retryAfterSeconds` and `limit: 6`, none is a
   `5xx`, none leaves a row, and the ones inside the cap are recorded `unregistered-repo` skips, so
   the burst opens no session.
2. **restart** — `down.sh` stops the process (SIGTERM, then SIGKILL if it lingers), and `up.sh`
   boots a fresh one on the same database; the script checks the pid changed.
3. **after-restart** — the same alert (a new `Request-ID`) is `replayed: true` with status
   `processed`, the repo still has one session, and the row the first process wrote is still
   `processed`. A new event in the first alert's issue is still a skip naming the first process's
   session, and the `trigger_fingerprints` row still names it. The control: a new alert in the restarted process opens its session, so the replay
   is the dedupe and not a process that cannot create.

**What proves it works.** `.verify/evidence/lob-82/` (gitignored; LOB-81's run is in
`.verify/evidence/lob-81/`): `sentry-first.json` and
`sentry-after-restart.json` (each phase's checks and every delivery's answer), `sentry-process.json`
(the script's checks), and both processes' logs. `packages/core/src/Sentry.test.ts` proves the
signature, the filter and the key in isolation, and the dedupe through the real seam on Postgres —
including across two runtimes — and, for LOB-82, the filter's reasons, the title, the default
prompt verbatim, and the binding through the real seam: readable after a restart, a repeat event
skipped naming the session across processes, four racing events opening one session, a closed
session's issue rebound, a failed delivery's binding given back; `apps/api/src/Api/SentryWebhook.test.ts`
proves the route's 401s and their log line with a recording logger, that the cap counts only signed
deliveries that can start work — an opted-in action counts, an `issue` firehose does not, and
neither does a filtered alert — and the `503` for a `SENTRY_MIN_LEVEL` that is not a level.

**Non-vacuity.** `.verify/evidence/lob-81/mutation-key-by-request-id/`: keying an alert by its
`Request-ID` instead of its event (the "obvious" key) passes the whole first phase — the drive's two
posts share one request id — and fails three after-restart checks: the fresh process opens a second
session for the same alert. `.verify/evidence/lob-82/mutation-no-binding/`: skipping the fingerprint
claim fails the binding, repeat-alert and session-count checks in both phases (a repeat event opens a
second session), and four cases in `Sentry.test.ts`.

**What it cannot prove.** That Sentry signs the bytes it sends, whether Sentry retries a delivery
or keeps its `Request-ID`, and its 1-second response budget (the route answers after the session
is opened). See `docs/testing-third-parties.md`'s Sentry row. That `environment` is on
`data.event` (the documented example does not show it), so the drive's environment filter is our
reading. The filter is deployment-wide, not per project or per rule. A repeat alert is recorded on
the delivery, not posted into the open session. The link back to the alert is LOB-83.
