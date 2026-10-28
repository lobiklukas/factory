# Jira adapter (LOB-189)

**What it is.** The second adapter on the trigger seam: `packages/core/src/Jira.ts` turns a Jira
Cloud issue webhook into a `TriggerEvent` (`jiraEvent`), derives the delivery id Jira does not send
(`jiraRequestId` / `jiraDelivery`), and fills the seam's write-back port with Jira's comment API
(`JiraWriteBack`). Everything after normalization — the dedupe claim, the `create`-only filter, the
label → `{repo, baseRef, prompt}` mapping, the session, the claim release — is part 1's
(`TriggerService.ts`) and is not reimplemented here.

**How a user reaches it.** `jiraEvent` reads a real `jira:issue_created` payload: `issue.key` is what
a write-back addresses (`FAC-1`), `fields.summary` is the session's title, `fields.description`
(plain text **or** ADF — the editor decides) is the prompt body, and `fields.labels` pick the
mapping rule, exactly as a Linear label does. The write-back posts
`POST {baseUrl}/rest/api/3/issue/{key}/comment` with Basic `email:api-token` auth and an ADF
document naming the session.

**How a user reaches it.** `POST /webhooks/jira` (LOB-259), armed by `JIRA_WEBHOOK_SECRET`: register
an admin webhook in Jira with that secret and Jira signs `X-Hub-Signature: sha256=<hex HMAC of the
body>`, which `verifyJiraSignature` checks (a missing header, a digest of another body and a digest
without the `sha256=` prefix are each `401`, and record nothing). With no secret the route is `503`.
The comment back on the issue needs `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` (all three,
`jiraConfigFromEnv`) and optionally `JIRA_SESSION_URL_BASE`; without them the route still opens
sessions and writes nothing back.

**How the skill drives it.** `./jira.sh` boots `./jira-fake.ts`, boots the **real API** pointed at it
(`adapter-lib.sh`), and runs `bun jira.ts`, which signs deliveries the way Jira does and posts them at
the API over HTTP, reading sessions back through the RPC client. Only Jira is a loopback fake: the
route, the signature check, the seam, the session layer and Postgres are real. Sixteen checks, then
the API is booted again with the secret unset:

1. a signed `jira:issue_created` delivery is processed (200) and names a session;
2. the session's title is the issue's summary, in the rule's repo, and
3. its first message is the rendered rule;
4. the write-back posted exactly one comment, on `FAC-1`, as an ADF document naming and linking the
   session;
5. the call read the issue first, then posted once, to Jira's own path, with Basic auth;
6. the same body again is `replayed`, with no second session and no second comment;
7. a `jira:issue_updated` delivery is skipped, with Jira's own event name in the reason;
8. a label no rule maps is skipped, naming the labels that arrived;
9. neither skip created a session or a comment;
10. a missing, a wrong and an unprefixed signature are each `401` with their reasons, and
11. a refused delivery records nothing and opens nothing;
12. a signed body with no issue is `400 bad-payload`;
13. a delivery whose comment landed but whose acknowledgement was lost is `500 write-back`;
14. its retry is processed and reuses the session;
15. the retry reads the issue's comments and posts no second one; and
16. sends the prompt once: the settled session holds exactly one user message (LOB-218);
17. (`unconfigured`) with the secret unset the route is `503 not-configured`, naming
    `JIRA_WEBHOOK_SECRET`, and records and opens nothing.

**What proves it works.** `.verify/evidence/lob-259/` (`jira-configured.log`, `jira-unconfigured.log`,
`jira-*-observed.json`, `jira-ledger.json`, the API logs): 16/16 and 2/2 on Postgres 5442 and faux
model. `packages/core/src/Jira.test.ts` proves what the drive does not: the payload reading (ADF
flattening, a payload with no fields, an update keeping its own name), the derived delivery id (same
body → same id, re-stamped body → new id), the all-three-or-none config gate, the signature verdicts,
the request shape, and a `403` becoming a `write-back` error. `apps/api/src/Api/AdapterWebhooks.test.ts`
serves the route in-process over a recording seam: the `503`, the `401`s, the `400`s, the replay.

**Non-vacuity.** With the write-back's read-before-post removed (`if (already && false) return;`),
the lost-acknowledgement case fails: the retry posts a second comment and the drive reports
`comments=2` (14/16, exit 1). The read is what makes "one comment" survive a lost response, not the
seam's dedupe — the seam's claim was already given back by then. With the seam's send keyed on a
fresh id per attempt instead of the delivery's (`TriggerService.ts`, LOB-218), the prompt check fails
with `prompts=2` (16/17, exit 1): the request id on `send` is what makes "one message" survive the
same retry. The count is read once the session is idle with an empty inbox — a prompt re-sent while
the first run is busy waits there as a follow-up, so an immediate read reported `prompts=1` either
way.

**The delivery id is derived, and that is the limit.** Linear sends a delivery id header; Jira Cloud
does not, and the seam's dedupe is a row keyed by that id. So the adapter derives
`jira:{action}:{issue key}:{timestamp}` — a replayed **body** is one delivery, and a redelivery that
re-stamps the payload is not. Closing that needs a route that takes a delivery header.

**One write-back per source.** The seam has one `TriggerWriteBack`, and the routes share it, so the
clients sit behind `TriggerWriteBackBySource` (`apps/api/src/Api/TriggerAdapters.ts`): an event is
answered by the client of the system it came from and by no other, so a GitHub issue can never get a
Jira comment. The generic and Sentry sources write nothing.

**The read-then-post window.** The comment is looked for in Jira's default page of an issue's
comments (50). A session's comment on an issue with a longer thread than that could be missed and
posted twice; the check is not atomic with the post, so two _concurrent_ posts for one session are
prevented by the seam's single claim, not by this read. Both are recorded in
`docs/testing-third-parties.md`.

**A write-back failure fails the delivery.** A refused comment is a `write-back` `TriggerError`, so
the seam gives the claim back and the sender's retry runs the work instead of reading
`replayed: true` about a session whose link nobody was told. Safe because the session's request id is
`trigger:<delivery id>`, so the retry reuses the session a failed attempt opened, and the seam sends
its prompt under the same key, which Pi Durable admits once, so the retry does not tell the session
twice (LOB-218).
