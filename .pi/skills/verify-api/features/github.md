# GitHub issues/labels adapter (LOB-190)

**What it is.** The third adapter on the trigger seam: `packages/core/src/GitHub.ts` turns a GitHub
`issues` webhook into a `TriggerEvent` (`githubEvent`), derives the delivery id
(`githubRequestId` / `githubDelivery`), and fills the seam's write-back port with GitHub's
issue-comment API (`GitHubWriteBack`). Everything after normalization — the dedupe claim, the
`create`-only filter, the label → `{repo, baseRef, prompt}` mapping, the session, the claim
release — is part 1's (`TriggerService.ts`) and is not reimplemented here.

**The repo comes from the payload.** A GitHub installation serves many repositories and the same
label means a different repo in each, so `githubEvent` puts `repository.full_name` on the event
(`TriggerEvent.repo`, lowercased to `RepoSlug`'s contract) and `resolveMapping` lets the event win
over the rule's `repo`. The drive makes that observable: its rule names a **decoy** repo, and the
session still opens in the payload's.

**How a user reaches it.** GitHub posts an `issues` delivery with `action` `opened` (the issue was
created carrying the label) or `labeled` (the label was added later). Both normalize to `create`;
`unlabeled` and every other action keep GitHub's own name, so the seam refuses them and the reason
reads `action "unlabeled" is not "create"`. The write-back posts
`POST /repos/{owner}/{repo}/issues/{number}/comments` with the installation token from the
credential seam (`CredentialProvider`, the same one `pr.ts` uses), a `{ body }` markdown payload
naming the session.

**The idempotency key is the issue, not the delivery.** Creating an issue with a label makes GitHub
send **two** deliveries — `opened` and one `labeled` per label — with two `X-GitHub-Delivery`
values, and one more for every label added later. Keying the dedupe on the delivery would open a
session per delivery, so `githubRequestId(event, rules)` is `github:{repo}#{number}:mapped` as soon
as any rule claims the payload: **one issue is one unit of work**, the `opened`/`labeled` pair
collapses, a redelivery collapses, and a second label opens nothing even when another rule claims it
(two rules on one issue would be two answers to one question, and the seam maps one of them anyway).
A delivery **no rule claims** is keyed by the labels it carried (`…:unmapped:{labels}`), so an issue
opened unlabelled records its skip without swallowing the delivery that labels it later. The rules
are the seam's, so a route builds its delivery with `githubDeliveryFor(rules)` — the same value it
hands `TriggerServiceLive` — rather than a second copy.

**How a user reaches it.** `POST /webhooks/github` (LOB-259) — the same route, the same
`GITHUB_WEBHOOK_SECRET` and `X-Hub-Signature-256` as the `pull_request` and `push` events — now also
reads `issues` and `issue_comment` (subscribe the webhook to both). Two things start work: a **label**
(an issue `opened` or `labeled`, the rule's label picks the work) and an **`@factory` mention**, a
comment _created_ on an issue whose text mentions `GITHUB_MENTION` (default `@factory`). The mention
is the same ask, so the event carries the handle without its `@` (`factory`) as one more label and a
rule on `factory` claims it; its key is the issue's, so labelling and then mentioning is one session.
The prompt's `{{body}}` is the issue's body followed by `Comment from <login>:` and the comment.
Everything else is `202` and ignored _before_ the seam, so it records no delivery: an `edited`,
`closed` or `unlabeled` issue event, a comment that is not a mention, a comment on a pull request
and a bot's comment (the factory's own is posted as one; a loop is what getting that wrong costs).
An `edited` delivery is ignored rather than recorded because it would share the issue's key and its
skip would answer the label added next as a replay. A mapped delivery is also `keyedByWork` (as
Linear's is), so a skip for a repo nobody had registered is reclaimed by the next delivery under the
same key once the operator registers it. With no secret the issue path is `503`, like the rest of the
route. Who _may_ ask is not decided here: any commenter on a repository the webhook watches can,
until the trust gate (S:trigger-trust-gating, planned) lands.

**How the skill drives it.** `./github-issues.sh` boots `./github-issues-fake.ts`, boots the **real
API** with `GITHUB_API_URL` pointed at it (`adapter-lib.sh`), and runs `bun github-issues.ts`, which
signs deliveries the way GitHub does and posts them at the API over HTTP, reading sessions back
through the RPC client. Only GitHub is a loopback fake. Fifteen checks, then the API is booted again
with the secret unset:

1. a signed `opened` issue carrying the label is processed and names a session;
2. the session's repo is the payload's, not the rule's decoy;
3. the session's title is the issue's, and its first message is the rendered rule;
4. the write-back posted exactly one comment, on the payload's issue, naming the session and
   linking to it;
5. it read the issue first, then posted once, to GitHub's own path, with the token and
   `X-GitHub-Api-Version: 2022-11-28`;
6. GitHub's `labeled` twin, a redelivery and a second label are replays — one session, one comment;
7. two rules, either label first, cannot start two sessions on one issue;
8. an `unlabeled` and an `edited` delivery are `202` ignored and record no delivery;
9. an issue opened with no mapped label is skipped, and labelling it afterwards starts a session
   (the later label is new work);
10. a pull-request payload on the issues event is `400 bad-payload`;
11. an `@factory` comment on an issue with no label opens one session and one comment, a second
    mention is a replay, a bot's mention and a comment with no mention are `202`;
12. that session's prompt carries the issue and the comment that asked;
13. a missing and a wrong signature are `401` and record no delivery;
14. a delivery whose comment landed but whose acknowledgement was lost is `500 write-back`;
15. its retry is processed, reads the issue's comments, posts no second comment and reuses the
    session;
16. (`unconfigured`) with the secret unset an issue delivery and a mention are `503`, naming
    `GITHUB_WEBHOOK_SECRET`, and record and open nothing.

**What proves it works.** `.verify/evidence/lob-259/` (`github-issues-configured.log`,
`github-issues-unconfigured.log`, `github-issues-*-observed.json`, `github-issues-ledger.json`, the API
logs): 15/15 and 2/2 on Postgres 5442 and faux model. `packages/core/src/GitHub.test.ts` proves what
the drive does not: the payload reading (a PR payload, a missing repository, a bad slug, bare string
labels), the intent key (the rule's label, the label order, the unlabelled case, a second label, a
second rule), `githubIssueIntake` (which events start work, the mention as a handle and not a longer
word or an address, a custom handle, a bot, a pull request), `handleGitHubIssueWebhook` (`503`, `401`,
`400`, `202`, the seam's answers, `500`), the request shape (method, path, `Bearer`, `Accept`,
`X-GitHub-Api-Version`, `{ body }`), the read-before-post skip, a `403` becoming a `write-back` error,
and an event with no repo failing rather than guessing one. `apps/api/src/Api/GitHubWebhook.test.ts`
serves the route in-process over the real seam and a `node:http` loopback GitHub.

**Non-vacuity.** Keying on the label set instead of the issue — the shape this adapter had before
review — makes the drive fail three checks (15/18 at the time, exit 1): the second label opens a
second session (`replayed=false sessions=2`), and the counts after it shift with that.

**One issue, one session.** The rule that makes the key simple has a cost, recorded in
`docs/testing-third-parties.md`: a second label added to an issue that already started a session
starts nothing, even if another rule claims it, and re-adding a label that already started work is
a replay rather than new work. An issue is the unit of work on this surface; an operator who wants
two tasks from one issue wants two issues.

**The comment is the factory's own, and only on issues.** The write-back is `GitHubWriteBack` behind
`TriggerWriteBackBySource` (`apps/api/src/Api/TriggerAdapters.ts`), posted with the credential seam's
token (`GITHUB_TOKEN` or the App); with none, the delivery fails at the comment (`500 write-back`,
the cause named) after the session was opened, and GitHub's redelivery finds the session and posts
the comment. The comment links the session when `GITHUB_SESSION_URL_BASE` is set.

**The read-then-post window.** The comment is looked for in GitHub's default page of an issue's
comments (30). A session's comment on an issue with a longer thread could be missed and posted
twice; the check is not atomic with the post, so two _concurrent_ posts for one session are
prevented by the seam's single claim, not by this read. Both are recorded in
`docs/testing-third-parties.md`.
