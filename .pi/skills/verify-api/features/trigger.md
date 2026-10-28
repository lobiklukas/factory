# Inbound triggers (LOB-188)

**What it is.** One typed path from a delivery that arrives from outside to a session that starts
inside: `POST /webhooks/generic` and `POST /webhooks/linear` → `apps/api/src/Api/Webhook.ts` →
`packages/core/src/TriggerService.ts` → `packages/core/src/SessionService.ts`. The seam's five
steps are authenticate (`hmac-sha256`, header name from config), dedupe (`webhook_deliveries`,
`request_id` primary key), filter (`create` always starts work; a lifecycle action — a `push` or a
`schedule`, LOB-197 — only when a rule that claims the event sets `startsWorkFor`; the generic
adapter, whose caller types its own `action`, refuses both before the seam so it cannot name a push
no push produced, LOB-235), map (a stored route, else `TRIGGER_RULES`: label → repo, base
ref, prompt template), create (a session, with the rendered prompt as its first message). An
adapter's session port also sees the delivery id, which is what lets
[docs-trigger.md](docs-trigger.md) cut `factory/doc-<delivery id>`.

**How a user reaches it.** A sender posts a signed JSON body. The generic adapter wants
`{requestId, label, action?, title?, body?}` (or `requestId` in the body and a
`x-trigger-delivery` header), where `action` defaults to `create` and a lifecycle action (`push`,
`schedule`) is `400 lifecycle-action`; the Linear adapter wants Linear's own issue webhook, whose labels pick
the rule — its idempotency key is the issue, not the delivery, and [linear.md](linear.md) is how
it is driven (LOB-164). Both answer `{ok, status, replayed, sessionId?, reason?}` — `200`, except
a replay of work still in flight, which is `503 in-progress` so the sender retries (LOB-216).

**How the skill drives it.** `./webhook.sh` boots the skill's own API instance with
`TRIGGER_RULES` (a `factory` rule, and a `docs` rule that admits `push` and `schedule` as
`docsTriggerRules` does), `TRIGGER_SECRET`, `LINEAR_WEBHOOK_SECRET` and
`TRIGGER_MAX_BODY_BYTES=2048`, then runs `bun webhook.ts` — seventeen checks over real HTTP, signed
the way Linear signs a delivery:

1. A signed delivery starts a session, and the answer names it.
2. The same body again answers `replayed: true` — and the repo's session count went up by one, not
   two.
3. The session's first message is the rule's rendered template (`{{title}}`, `{{body}}`).
4. `action: "update"` is `skipped` with exactly `action "update" is not "create"` — the reason
   names what the routing rule admits, so it never lists `push` or `schedule` to a caller who is
   refused them — and a replay of that refusal stays skipped.
5. A label no rule names is `skipped` with `no rule matches labels [nobody]`.
6. Neither skip created a session.
7. A wrong signature is `401`, before parsing.
8. A 4 KiB body is `413 body-too-large` — the trigger cap, not the 1 MiB transport cap.
9. A Linear-shaped delivery through the other adapter reaches the same seam and creates a session.
10. A `received` row claimed an hour ago — what a process killed between its claim and its outcome
    leaves — is reclaimed by the next delivery of its id, which starts the session (LOB-216). The
    drive writes that row into the API's own database (`DATABASE_URL`) before it posts.
11. A `received` row claimed a moment ago — inside the window — is answered `503 in-progress` with
    `Retry-After`, `replayed: true`, and starts nothing: a sender must keep retrying it (LOB-216).
12. A signed generic `{action: "push", label: "docs"}` is `400 lifecycle-action`, names the action
    and why, starts nothing, and leaves no `webhook_deliveries` row — so no recorded `reason` can
    say `rule "docs" mapped it to …` about a push nobody pushed (LOB-235). The drive reads the
    API's database to prove the absent row.
13. A `{action: "release", label: "release"}` is `400 lifecycle-action` too, with no row: the
    `release` rule's `startsWorkFor: ["release"]` is operator config of any string, and the
    adapter refuses every action a rule admits, not a fixed list (LOB-235 review).

**What is recorded, and where it is read (T4).** The seam records every delivery it receives in
`webhook_deliveries`: its source, `received_at`, how it ended (`processed`, `skipped`, or `received`
while in flight) and the outcome's reason verbatim, and for a processed delivery the session it
opened (`session_id`) or the card it filed or found (`task_id`). `listTriggerDeliveries({source?,
status?, limit?, cursor?})` reads them newest first (`factory triggers ls`, the dashboard's
`/triggers`). A delivery **refused before the seam** — a wrong or missing signature (`401`), a body
over `TRIGGER_MAX_BODY_BYTES` (`413`), a route with no secret (`503 not-configured`), a rate-limited
one (`429`), a malformed or lifecycle-action one (`400`) — is logged and answered, never recorded:
the table is the dedupe fact, and an unauthenticated request must not be able to write a row. The
route tests (`Webhook.test.ts`) hold that the seam is handed nothing, and `linear.sh` checks that the
forged delivery adds no row to the list. 14. The same caller's `{action: "create", label: "docs"}` still starts a docs session, answered
`rule "docs" (env:TRIGGER_RULES[1]) mapped it to <repo>`, whose first message is the docs rule's template.

Every check is required: `webhook.sh` exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-188/` (`webhook.log`, `observed.json`): 12/12 on the
API at `:9400`, faux model, Postgres on 5442. `packages/core/src/TriggerService.test.ts` proves the
half HTTP cannot: the same request id fired twice **concurrently** creates one session. LOB-216's
re-run is `.verify/evidence/lob-216/webhook/`: 14/14 on `:9540`; the same drive against the seam
from before LOB-216 fails check 10 with `{"status":"received","replayed":true}`, which is the defect.
LOB-235's re-run is `.verify/evidence/lob-235/webhook/`: 17/17 on `:9520`; the same drive against
the adapter from before LOB-235 fails check 12 with `{"status":"processed","reason":"rule \"docs\"
mapped it to acme/verify-api-trigger"}` and a `processed` row, which is the defect.
`apps/api/src/Api/Webhook.test.ts` pins the refusal in-process for `push` and `schedule`, and for
a rule-admitted `release` (the case serves `WebhookRoutes` over a fake seam whose `rules` answers the widened rule), with two controls: a `create` on `docs` reaches the seam as a create, and `update` still reaches the
seam's filter (a route that refused every non-create would fail it).

**Non-vacuity.** A mutation run of `TriggerService.test.ts`, recorded here rather than kept: with
the claim's `RETURNING request_id` / `claimed.length === 0` replay recognition removed, three cases
fail — "creates exactly one session when two deliveries race", "records a replay of a finished
delivery", and the unregistered-repo case (whose second half expects a replay). The claim is a
single `INSERT … ON CONFLICT … DO UPDATE … WHERE … RETURNING` — a conditional takeover: only a stale
claim, or a work-keyed delivery's own unregistered-repo skip, hands the row over, and in the one
statement — so two processes still cannot both win it.

The race case only kills a read-then-insert because it forces the interleaving that loses: it holds
the request id in an uncommitted insert until both deliveries are queued on it, so each has read "no
row" before either can insert (LOB-219). Without the hold, the first delivery's read and insert land
before the second's read, and a `SELECT`-then-`INSERT` claim passed the race 20/20. With it, 20/20
red for each of: `SELECT` then plain `INSERT` (the loser's insert fails `claim delivery`), `SELECT`
then `INSERT … ON CONFLICT DO NOTHING` treated as a win, and no claim at all (two write-backs, two
non-replay answers). The correct claim passes it 20/20 alone, in the whole file, and beside a full
`bun run test`. Evidence: `.verify/evidence/lob-219/`.

**A route with no secret refuses everything.** An unset secret used to mean "accept"; now that a
delivery can _start a session_, accepting unsigned ones would let anyone who can reach the port open
an agent. Both routes answer `503 not-configured`, naming the variable to set, until
`TRIGGER_SECRET` / `LINEAR_WEBHOOK_SECRET` is configured. The drive cannot prove this one — it would
need a second API instance booted with no secret — so `apps/api/src/Api/Webhook.test.ts` does
(LOB-216): it serves the app's own `WebhookRoutes` in-process (`HttpRouter.toWebHandler`) with a
recording fake seam, unsets each secret in turn, and posts a body signed with the _empty_ key — the
key an unset secret degrades to. Both routes answer `503 not-configured` naming their variable, an
empty-string secret counts as unset, and the seam is handed nothing; a control case with both
secrets set reaches the seam. Removing the branch turns three cases red with `expected 200 to be
503`: the empty-key signature then verifies.

**A failed delivery gives its claim back.** The claim row starts as `received`; if the session
cannot be created (or the write-back fails) the row is deleted before the failure is re-thrown, so
the sender's retry runs the work instead of being answered `replayed: true` to work that never
started. The release runs on _any_ unsuccessful exit — a typed `TriggerError`, a defect, or an
interrupt — because `Effect.exit` sees all three and `Effect.uninterruptible` keeps a cancelled
request from skipping its own cleanup; `Effect.tapError` alone would miss a defect. A retry after a
failure _past_ the send (a write-back) runs `create` and `send` again: `create` reuses the session
(`sessions.request_id` is `trigger:<delivery id>`) and `send` carries that same key to Pi Durable's
submission dedupe, so the session still holds one prompt (LOB-218; `TriggerService.test.ts` and
[jira.md](jira.md)'s check 15).
`packages/core/src/TriggerService.test.ts` has both cases ("gives the claim back when the session
cannot be created" and "…even when the session layer dies rather than failing"), and reverting the
release to `Effect.tapError` turns the second one red. Safe because `sessions.create` dedupes on
`trigger:<requestId>`: a failure _after_ the session was opened reuses that session on the retry
rather than opening a second one.

**A claim whose process died is reclaimed (LOB-216).** The release above runs on every exit a process
lives to see; a `SIGKILL` between the claim and the outcome runs none, and used to leave the row in
`received` for good, so every retry answered `replayed: true, status: "received"` to work that never
started. The row now carries `claimed_at` (migration `0020`, backfilled from `received_at`), and the
claim's conflict clause takes a `received` row whose claim is older than `reclaimAfter` (default
`TRIGGER_RECLAIM_AFTER`, 10 minutes) — in the same single statement, renewing `claimed_at`, so of two
retries that race for a stale row only one wins. Inside the window the seam still answers a replay
`received` — the first process may be working — and the routes turn that answer into `503
in-progress` with `Retry-After: 60`, not `200`: Linear retries a failed delivery after 1 minute, 1
hour and 6 hours and stops on any `200`, so a `200` to the killed delivery's first retry (inside the
window) would have been its last, and the reclaim would never get its chance. Every non-`200` keeps
the sender retrying until an attempt reads the recorded outcome or lands past the window and takes
the claim. `apps/api/src/Api/Webhook.test.ts` pins both routes' `503` and the control (a replay with
an outcome stays `200`), and drive check 11 pins it over HTTP.

The window is a lease without a heartbeat, and guessing wrong is cheap: a reclaim of a claim that was
in fact alive re-runs `create` and `send`, which dedupe on the delivery's key, so the session still
holds one prompt (at worst the write-back runs twice, and Linear's is idempotent). What the slow
process must not do is give back a claim that is no longer its own, so the release deletes only the
row whose `claimed_at` is the one its claim returned (read back as text, so the microseconds
survive): otherwise a third retry would claim afresh and run beside the reclaimer.
`TriggerService.test.ts` covers an hour-old claim reclaimed then replayed, a two-minute-old claim left
alone under the default window and reclaimed under a one-minute one, a retry landing while the
reclaimer works (a replay — which fails without the renewal), a slow process failing after its claim
was reclaimed (the reclaimer's row survives and a third delivery is a replay — `expected undefined to
be 'received'` without the guard), and the work-keyed claim's own conflict clause.

**Deliberately absent.** Write-back: `TriggerWriteBack` is an injected port with a no-op default,
because no adapter in part 1 has anywhere to write (the candidate is LOB-190's GitHub issue
comment).

## Stored routes and boot validation (LOB-266)

`TRIGGER_RULES` is the _fallback_ now, not the only mapping. A route is a row in `trigger_routes`
(migration `0024`; a label, a team, or both → a registered repo, a base ref, a prompt, optional
`startsWorkFor`), added and removed over RPC (`addTriggerRoute`, `listTriggerRoutes`,
`removeTriggerRoute`, the `TriggerRoutesRpc` group), and **read per delivery** by the API's seam
(`TriggerServiceLive({ storedRoutes: true })`, `packages/core/src/TriggerRoutes.ts`): a route added
while the API runs routes the next delivery. The adapters normalize against the seam's own rule set
(`TriggerService.rules`), so what counts as work (a Linear label add, the issue's team key) follows
the table too. Precedence is deterministic: label+team routes, then label-only, then team-only, older
first within each, then the `TRIGGER_RULES` entries in their order. A route's repo must be
registered (the RPC refuses it by name). The docs and review seams do not read the table.

The recorded reason names the rule that matched: `rule "factory" (route trr_…) mapped it to
acme/widgets`, or `rule "factory" (env:TRIGGER_RULES[0]) mapped it to …`. A Linear issue's team key
(`data.team.key`) is what a team route claims; other adapters name none, so a team route claims only
Linear's.

At boot the API logs `trigger rules: N (label→repo, …)` and one line per webhook route (`webhook
/webhooks/linear: armed`, or `…: unarmed: LINEAR_WEBHOOK_SECRET unset` — a warning, because the route
answers every delivery `503`). A `TRIGGER_RULES` value that does not decode **refuses the boot**,
after an error line naming the variable and every decode fault. `WEBHOOK_ROUTES` in
`apps/api/src/Api/WebhookBoot.ts` is the table a new route adds a row to; a test fails for a mounted
`/webhooks/…` path with no row. Proof: `WebhookBoot.test.ts` (the log lines, captured),
`TriggerService.test.ts` ("stored trigger routes", on Postgres), `Rpc/TriggerRoutes.test.ts` (the
RPC), and `./linear.sh`, which adds and removes a stored route mid-run and greps the boot log.
