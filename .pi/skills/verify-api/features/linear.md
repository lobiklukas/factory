# Linear issue → one session (LOB-164)

**What it is.** The Linear half of the trigger seam ([trigger.md](trigger.md)): a Linear issue
created with a label a rule names opens exactly one session, bound to the rule's repo at its base
ref, with the issue's title and description — through the rule's prompt template — as its first
message. `POST /webhooks/linear` → `apps/api/src/Api/Webhook.ts` → `packages/core/src/Linear.ts`
(normalize, and derive the idempotency key) → `packages/core/src/TriggerService.ts` (claim, filter,
map, create) → `SessionService`.

**How a user reaches it.** An operator points a Linear webhook (Issues data-change events) at
`/webhooks/linear`, sets `LINEAR_WEBHOOK_SECRET` to its signing secret, and names the mapping in
`TRIGGER_RULES` — `[{"label": "factory", "repo": "acme/widgets", "baseRef": "main", "prompt": "…"}]`.
The prompt template takes `{{key}}` (the issue id), `{{title}}`, `{{body}}` (the description),
`{{labels}}`, `{{source}}` and `{{action}}`. The rules are read once, when the API boots.

**What starts work.** An issue `create`, and an `update` that _adds_ a label a rule names
(`updatedFrom.labelIds` lacks it, the issue now carries it): the issue triaged into the factory
after it was filed. Adding a label no rule names starts nothing, even on an issue that already
carries a mapped one. Every other action keeps Linear's own name (`update`, `remove`) and is
recorded `skipped` with it. Another entity (`type: "Comment"`, `"IssueSLA"`, …) is answered `200`
and skipped as `Comment:create`, keyed by the entity's own id (a Comment's `data.issue` is context,
not the subject) or by the delivery when its `data` names none, because a `4xx` makes Linear retry
the delivery three times and then disable the webhook. Only an issue body with no id is `400`.

**One issue, one session.** A delivery that can start work is keyed by its issue once a rule claims
it (`linear:<issue id>:mapped`), never by `Linear-Delivery` or the body: Linear's retry is not
promised to reuse the header, and its `webhookTimestamp` — and so its signature — is new. A delivery
no rule claims is keyed by its label set, so an issue filed unlabelled records its skip and the
label that arrives later is new work. A delivery that cannot start work (an edit) is keyed by the
delivery, so it can never claim the issue's key ahead of the label. `webhookId` is the
_subscription's_ id, the same on every delivery, and nothing reads it.

**An unregistered repo is reclaimable.** The issue-wide key outlives any one delivery, so the
adapter marks it `keyedByWork`, and the seam's claim takes back a row it recorded as
`repo … is not registered` (one conditional `INSERT … ON CONFLICT DO UPDATE … WHERE`, so two
deliveries still cannot both win). Once the operator registers the repo, the next delivery for the
issue — re-adding the label — starts the session. A generic sender's own delivery id is unchanged:
its retry after registration is still a replay, and a new id is the second chance.

**Unmappable is a recorded skip.** No rule for the labels → `skipped`, reason
`no rule matches labels [Bug, Frontend]` (or `the event carries no labels, so no rule maps it`),
written to `webhook_deliveries.skip_reason`; a rule whose repo is not registered →
`repo … is not registered`. None opens a session.

**How the skill drives it.** `./linear.sh` boots the skill's API instance (`API_PORT`, default
`9415`) with two per-run rules (`factory`, and `factory-later` on a repo registered mid-drive) and
`LINEAR_WEBHOOK_SECRET`, then runs `bun linear.ts`: fourteen checks
over real HTTP with Linear-shaped bodies, a fresh `Linear-Delivery` on every post, signed the way
Linear signs one. Every check is required.

1. A Linear issue created with `factory` (and `Bug`) starts a session, and the answer names it.
2. The session is bound to the rule's repo and base ref and titled with the issue.
3. Its first message is exactly the rule's template rendered from the issue's title and description.
4. Linear's retry — new header, later `webhookTimestamp` — is `replayed: true`.
5. A second mapped label added to the same issue later is a replay.
6. An edit is `skipped` with `action "update" is not "create"`.
7. An issue labelled `Bug, Frontend` is `skipped` with `no rule matches labels [Bug, Frontend]`.
8. An issue filed unlabelled, then labelled `factory`, starts its session on the label.
9. A `Comment` delivery carrying `data.issue` is `200 skipped`, naming `Comment:create`.
10. An `IssueSLA` delivery whose `data` names no id is `200 skipped`, naming `IssueSLA:set`.
11. Adding `Bug` to an issue that already carries `factory` is `skipped` as an `update`.
12. An issue whose rule's repo is unregistered is skipped, then starts its session when the repo is
    registered and the label is re-added.
13. A wrong `Linear-Signature` is `401`.
14. The `factory` repo has exactly two sessions — one per labeled issue — and the later repo one.

**What proves it works.** `.verify/evidence/lob-164/` (`linear.log`, `observed.json`, `api.log`):
14/14 from the `agent/LOB-164` worktree on 2026-10-27 (API on `:9520`, faux, the worktree's own
database on 5442). `./webhook.sh` was re-run in the same place (12/12) because the route it drives
changed shape. `packages/core/src/Linear.test.ts` proves the key and the seam without HTTP.

**Non-vacuity.** A mutation run of `Linear.test.ts`, recorded here rather than kept: keying a mapped
delivery on `Linear-Delivery` turns five cases red (among them "opens exactly one session for a
labeled issue…"); dropping the label-added path, four; keying an edit by the issue, three; dropping
the entity-type check, two; dropping the `keyedByWork` mark on a mapped key, two (among them "starts
the issue once its rule's repo is registered…").

**Deliberately absent.** Linear's 60-second `webhookTimestamp` window (see
`docs/testing-third-parties.md`: retries arrive an hour later, and the issue-keyed row is the replay
guard). A write-back to the issue (`NoWriteBack`): a comment or agent activity naming the session is
LOB-14's follow-on, not this mapping. Team → repo mapping: a rule is a label, and a team that wants
its own repo gives its issues its own label.
