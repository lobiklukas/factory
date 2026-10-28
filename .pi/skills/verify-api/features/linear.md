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
`{{labels}}`, `{{source}}` and `{{action}}`. `TRIGGER_RULES` is read once, when the API boots and is
validated and logged then; a stored route (`addTriggerRoute`) is read per delivery and wins over it
([trigger.md](trigger.md), LOB-266).

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

**A card rule puts the issue on the board (LOB-254).** A rule or stored route with
`"mode": "card"` opens no session: the delivery files one card on the repo's board, in its
definition's initial column (`intake` in the default pipeline), titled with the issue, with the
description verbatim as the card's body, `linear:<issue id>` as its external ref and the issue's
`url` as its link (only an `http(s)` one), through `TriggerCardsFromTaskService` →
`TaskService.file`. The answer carries `taskId` and no `sessionId`. The card is keyed by its
external ref, not the delivery: a second, distinct delivery about the issue answers the card already
on the board (`already on the board as card …`), and `file` takes an advisory lock on the board and
the ref so two at once cannot both file one. A repo with no board is a recorded skip,
`repo X has no board (create one with \`factory board create --repo X\`)`, which the issue-wide key
reclaims once the board exists, as it does an unregistered repo. The rule's `prompt` is unused: the
card's runs are told its body (LOB-260). The run starts from the card (B12), and the write-back
follows the run ([linear-writeback.md](linear-writeback.md)).

**What the board refuses is a decision, not a failure.** A description over the card body's cap
(32,000 characters) is cut to the cap with a marker, and the reason says so, rather than refused. A
card the board refuses for its input (a base ref git would not take) is a recorded skip naming the
field ("the board refused the card's baseRef"), not a 500 for Linear to retry. Filing the card
acknowledges nothing on the issue, nor on any other source.

**How the skill drives it.** `./linear.sh` boots the skill's API instance (`API_PORT`, default
`9415`) with two per-run rules (`factory`, and `factory-later` on a repo registered mid-drive) and
`LINEAR_WEBHOOK_SECRET`, then runs `bun linear.ts`: the checks below
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
    15–17. A stored route routes, names itself, replays, and is removed (LOB-266).
15. A card-mode route (LOB-254, added over RPC) on a repo with no board skips the issue, naming the
    repo and `factory board create`.
16. Once the board exists (`createBoard` over RPC), the issue's next delivery files exactly one card
    in `intake` with `linear:<id>`, the description as its body and the issue's link, and the repo has
    no session.
17. Linear's retry of that delivery is a replay, and the board still holds one card.
18. (T4) `listTriggerDeliveries` — what an operator reads when a labelled issue started nothing —
    holds this run's own deliveries with the seam's exact words: the unregistered repo's skip
    (`repo <later repo> is not registered`, read before the repo is registered), the unmapped
    issue's skip (`no rule matches labels [Bug, Frontend]`), the processed delivery naming its
    session, source (`linear`) and routing reason, and the filed card's delivery naming its card
    and no session. `status: "skipped"` returns only skips and `source: "generic"` none of this
    run's Linear rows. The forged delivery of check 13 left no row: the list's length is the same
    before and after it.

**What proves it works.** LOB-254: 22/22 (the card checks among them) from the `agent/LOB-254`
worktree on 2026-10-28 (API on `:9612`, the worktree's own database), evidence in
`.verify/evidence/lob-254-linear/`. `packages/core/src/TriggerService.test.ts` ("a card rule") proves
the card path on Postgres, including the second delivery that waits on the first filing's lock.
Earlier: `.verify/evidence/lob-164/` (`linear.log`, `observed.json`, `api.log`):
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

**A reply in an agent session answers the card's question (T5).** An `AgentSessionEvent` with
action `prompted` — a person writing in the thread of the agent session the factory posted an
`elicitation` in — is a reply, not an issue: its delivery id is `linear:<activity id>:reply`, and
the seam records the text as the `answer` comment on the card filed from that issue if one is
blocked `needs_input` (the delivery is `processed`, naming the card), and a recorded skip otherwise.
Other agent-session events (`created`) are answered `200` and skipped as any other entity. The
question's half, and the blocker gate (an issue with an open `blockedBy` relation is skipped
`blocked by <id>` until the blocker is Done), are in [linear-writeback.md](linear-writeback.md).
`./linear.sh` drives the reply over HTTP (checks 22–24: skipped when no card waits, a reply answers
the parked card verbatim, a redelivery and a second reply record nothing) and finds it in
`listTriggerDeliveries`.
