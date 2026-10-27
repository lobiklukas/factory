# Inbound triggers (LOB-188)

**What it is.** One typed path from a delivery that arrives from outside to a session that starts
inside: `POST /webhooks/generic` and `POST /webhooks/linear` → `apps/api/src/Api/Webhook.ts` →
`packages/core/src/TriggerService.ts` → `packages/core/src/SessionService.ts`. The seam's five
steps are authenticate (`hmac-sha256`, header name from config), dedupe (`webhook_deliveries`,
`request_id` primary key), filter (`create` always starts work; a lifecycle action — a `push` or a
`schedule`, LOB-197 — only when a rule that claims the event sets `startsWorkFor`, so a caller that
types its own `action` cannot name a push no push produced), map (`TRIGGER_RULES`: label → repo, base
ref, prompt template), create (a session, with the rendered prompt as its first message). An
adapter's session port also sees the delivery id, which is what lets
[docs-trigger.md](docs-trigger.md) cut `factory/doc-<delivery id>`.

**How a user reaches it.** A sender posts a signed JSON body. The generic adapter wants
`{requestId, label, action?, title?, body?}` (or `requestId` in the body and a
`x-trigger-delivery` header); the Linear adapter wants Linear's own issue webhook, whose labels pick
the rule — its idempotency key is the issue, not the delivery, and [linear.md](linear.md) is how
it is driven (LOB-164). Both answer `{ok, status, replayed, sessionId?, reason?}`.

**How the skill drives it.** `./webhook.sh` boots the skill's own API instance with
`TRIGGER_RULES`, `TRIGGER_SECRET`, `LINEAR_WEBHOOK_SECRET` and `TRIGGER_MAX_BODY_BYTES=2048`, then
runs `bun webhook.ts` — thirteen checks over real HTTP, signed the way Linear signs a delivery:

1. A signed delivery starts a session, and the answer names it.
2. The same body again answers `replayed: true` — and the repo's session count went up by one, not
   two.
3. The session's first message is the rule's rendered template (`{{title}}`, `{{body}}`).
4. `action: "update"` is `skipped` with `action "update" is not "create"`, and a replay of that
   refusal stays skipped.
5. A label no rule names is `skipped` with `no rule matches labels [nobody]`.
6. Neither skip created a session.
7. A wrong signature is `401`, before parsing.
8. A 4 KiB body is `413 body-too-large` — the trigger cap, not the 1 MiB transport cap.
9. A Linear-shaped delivery through the other adapter reaches the same seam and creates a session.
10. A `received` row claimed an hour ago — what a process killed between its claim and its outcome
    leaves — is reclaimed by the next delivery of its id, which starts the session (LOB-216). The
    drive writes that row into the API's own database (`DATABASE_URL`) before it posts.

Every check is required: `webhook.sh` exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-188/` (`webhook.log`, `observed.json`): 12/12 on the
API at `:9400`, faux model, Postgres on 5442. `packages/core/src/TriggerService.test.ts` proves the
half HTTP cannot: the same request id fired twice **concurrently** creates one session. LOB-216's
re-run is `.verify/evidence/lob-216/webhook/`: 13/13 on `:9540`; the same drive against the seam
from before LOB-216 fails check 10 with `{"status":"received","replayed":true}`, which is the defect.

**Non-vacuity.** A mutation run of `TriggerService.test.ts`, recorded here rather than kept: with
the claim's `RETURNING request_id` / `claimed.length === 0` replay recognition removed, three cases
fail — "creates exactly one session when two deliveries race", "records a replay of a finished
delivery", and the unregistered-repo case (whose second half expects a replay). The claim is a
single `INSERT … ON CONFLICT DO NOTHING RETURNING`, so two processes cannot both win it.

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
retries that race for a stale row only one wins. Inside the window a replay still answers
`received`: the first process may be working. The window is a lease without a heartbeat, and
guessing wrong is harmless: a reclaim of a claim that was in fact alive re-runs `create` and `send`,
which dedupe on the delivery's key, so the session still holds one prompt (at worst the write-back
runs twice, and Linear's is idempotent). `TriggerService.test.ts` covers an hour-old claim reclaimed
then replayed, a two-minute-old claim left alone under the default window and reclaimed under a
one-minute one, a retry landing while the reclaimer works (a replay — which fails without the
renewal), and the work-keyed claim's own conflict clause.

**Deliberately absent.** Write-back: `TriggerWriteBack` is an injected port with a no-op default,
because no adapter in part 1 has anywhere to write (the candidate is LOB-190's GitHub issue
comment). Per-request rule reloading: `TRIGGER_RULES` is read once when the routes are built, so
changing a mapping means restarting the API.
