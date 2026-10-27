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
runs `bun webhook.ts` — twelve checks over real HTTP, signed the way Linear signs a delivery:

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

Every check is required: `webhook.sh` exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-188/` (`webhook.log`, `observed.json`): 12/12 on the
API at `:9400`, faux model, Postgres on 5442. `packages/core/src/TriggerService.test.ts` proves the
half HTTP cannot: the same request id fired twice **concurrently** creates one session.

**Non-vacuity.** A mutation run of `TriggerService.test.ts`, recorded here rather than kept: with
the claim's `RETURNING request_id` / `claimed.length === 0` replay recognition removed, three cases
fail — "creates exactly one session when two deliveries race", "records a replay of a finished
delivery", and the unregistered-repo case (whose second half expects a replay). The claim is a
single `INSERT … ON CONFLICT DO NOTHING RETURNING`, so two processes cannot both win it.

**A route with no secret refuses everything.** An unset secret used to mean "accept"; now that a
delivery can _start a session_, accepting unsigned ones would let anyone who can reach the port open
an agent. Both routes answer `503 not-configured`, naming the variable to set, until
`TRIGGER_SECRET` / `LINEAR_WEBHOOK_SECRET` is configured. The drive cannot prove this one — it would
need a second API instance booted with no secret — so it rests on the code path in
`Webhook.ts`'s `handle` and on `webhook.sh` setting both.

**A failed delivery gives its claim back.** The claim row starts as `received`; if the session
cannot be created (or the write-back fails) the row is deleted before the failure is re-thrown, so
the sender's retry runs the work instead of being answered `replayed: true` to work that never
started. The release runs on _any_ unsuccessful exit — a typed `TriggerError`, a defect, or an
interrupt — because `Effect.exit` sees all three and `Effect.uninterruptible` keeps a cancelled
request from skipping its own cleanup; `Effect.tapError` alone would miss a defect.
`packages/core/src/TriggerService.test.ts` has both cases ("gives the claim back when the session
cannot be created" and "…even when the session layer dies rather than failing"), and reverting the
release to `Effect.tapError` turns the second one red. Safe because `sessions.create` dedupes on
`trigger:<requestId>`: a failure _after_ the session was opened reuses that session on the retry
rather than opening a second one.

**Residual risks, accepted.** (1) A `SIGKILL` between the claim and the outcome leaves the row in
`received` for good, and every retry then answers `replayed: true, status: "received"`. Reclaiming a
stale `received` row needs a lease with a timestamp — the same shape as `SessionBus`'s problem
(D12) — and is not part of this issue. (2) The `503 not-configured` branch of `/webhooks/*` has no
automated case: `apps/api` has no route-level test harness, and a drive would need a second instance
booted without a secret. It rests on the code path in `Webhook.ts`'s `handle` and on `webhook.sh`
setting both secrets; a case for it is a candidate issue, not a gap this PR pretends to have closed.

**Deliberately absent.** Write-back: `TriggerWriteBack` is an injected port with a no-op default,
because no adapter in part 1 has anywhere to write (the candidate is LOB-190's GitHub issue
comment). Per-request rule reloading: `TRIGGER_RULES` is read once when the routes are built, so
changing a mapping means restarting the API.
