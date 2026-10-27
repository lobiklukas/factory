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

**How the skill drives it.** `./jira.sh` boots `./jira-fake.ts` on the run's `API_PORT` and runs
`bun jira.ts`, which builds the **real** seam, the real `SessionService` and the real write-back
client over the run's Postgres — only Jira is a loopback fake. Seventeen checks:

1. a `jira:issue_created` delivery starts a session and names it;
2. the session's title is the issue's summary, and its first message is the rendered rule;
3. the write-back posted exactly one comment, on `FAC-1`, naming the session;
4. the comment body is an ADF document, and the call read the issue first, then posted once, to
   Jira's own path, with Basic auth;
5. the same payload again is a replay, and
6. it creates no second session and no second comment;
7. a `jira:issue_updated` delivery is skipped, with Jira's own event name in the reason;
8. a label no rule maps is skipped, naming the labels that arrived;
9. neither skip created a session or a comment;
10. a payload with no `issue` does not normalize to a delivery at all;
11. a delivery whose comment landed but whose acknowledgement was lost fails as `write-back`;
12. the retry reads the issue's comments before it posts;
13. the retry posts no second comment — the issue still carries exactly one;
14. the retry is processed and reuses the session the failed attempt opened;
15. and the retry sends the prompt once: the settled session holds exactly one user message
    (LOB-218).

**What proves it works.** `.verify/evidence/lob-189/` (`jira.log`, `jira-observed.json`,
`jira-ledger.json`): 17/17 on Postgres 5442 and faux model (`.verify/evidence/lob-218/` for the
run that added the prompt check). `packages/core/src/Jira.test.ts` (13 cases) proves what the
drive does not: the payload reading (ADF flattening, a payload with no fields, an update keeping its
own name), the derived delivery id (same body → same id, re-stamped body → new id), the
all-three-or-none config gate, the request shape, and a `403` becoming a `write-back` error.

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

**Nothing is wired into `apps/api` yet.** The issue's third criterion is that the adapter touches no
file the other adapters own and that the gate stays green with no Jira adapter enabled, so there is
no `POST /webhooks/jira` route: `Webhook.ts` (the Linear and generic adapters) is unmodified, and
`jiraConfigFromEnv` is what a deployment (or the coming route) uses to decide whether the adapter
exists at all — all three of `baseUrl`, `email`, `apiToken` or none.

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
