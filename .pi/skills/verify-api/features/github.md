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

**How the skill drives it.** `./github-issues.sh` boots `./github-issues-fake.ts` on the run's
`API_PORT` and runs `bun github-issues.ts`, which builds the **real** seam, the real
`SessionService` and the real write-back client over the run's Postgres — only GitHub is a loopback
fake. Eighteen checks:

1. an `opened` issue carrying the label starts a session and names it;
2. the session's repo is the payload's, not the rule's decoy;
3. the session's title is the issue's, and its first message is the rendered rule;
4. the write-back posted exactly one comment, on the payload's issue, naming the session and
   linking to it;
5. it read the issue first, then posted once, to GitHub's own path, with the App token and
   `X-GitHub-Api-Version: 2022-11-28`;
6. GitHub's `labeled` twin is a replay — one session;
7. re-running the `opened` delivery is a replay — one session, one comment;
8. a second label the same rule claims is a replay too, not a second session;
9. two rules, either label first, cannot start two sessions on one issue;
10. an `unlabeled` delivery is skipped, with GitHub's own action in the reason;
11. an issue opened with no mapped label is skipped;
12. labelling that same issue afterwards starts a session (the later label is new work);
13. a pull-request payload does not normalize to a delivery at all;
14. a delivery whose comment landed but whose acknowledgement was lost fails;
15. the retry reads the issue's comments before it posts;
16. the retry posts no second comment — the issue still carries exactly one;
17. the retry is processed and reuses the session the failed attempt opened.

**What proves it works.** `.verify/evidence/lob-190/` (`github-issues.log`,
`github-issues-observed.json`, `github-issues-ledger.json`): 19/19 on Postgres 5442 and faux model.
`packages/core/src/GitHub.test.ts` (21 cases) proves what the drive does not: the payload reading
(a PR payload, a missing repository, a bad slug, bare string labels), the intent key (the rule's
label, the label order, the unlabelled case, a second label, a second rule), the request shape (method, path, `Bearer`,
`Accept`, `X-GitHub-Api-Version`, `{ body }`), the read-before-post skip, a `403` becoming a
`write-back` error, and an event with no repo failing rather than guessing one.

**Non-vacuity.** Keying on the label set instead of the issue — the shape this adapter had before
review — makes the drive fail three checks (15/18 at the time, exit 1): the second label opens a
second session (`replayed=false sessions=2`), and the counts after it shift with that.

**One issue, one session.** The rule that makes the key simple has a cost, recorded in
`docs/testing-third-parties.md`: a second label added to an issue that already started a session
starts nothing, even if another rule claims it, and re-adding a label that already started work is
a replay rather than new work. An issue is the unit of work on this surface; an operator who wants
two tasks from one issue wants two issues.

**Nothing is wired into `apps/api` yet.** Like the Jira adapter, this one adds no route:
`apps/api/src/Api/Webhook.ts` (the Linear and generic adapters) is unmodified and nothing is
enabled until a `/webhooks/github` route calls `githubDelivery` — which would also be the place to
verify `X-Hub-Signature-256`.

**The read-then-post window.** The comment is looked for in GitHub's default page of an issue's
comments (30). A session's comment on an issue with a longer thread could be missed and posted
twice; the check is not atomic with the post, so two _concurrent_ posts for one session are
prevented by the seam's single claim, not by this read. Both are recorded in
`docs/testing-third-parties.md`.
