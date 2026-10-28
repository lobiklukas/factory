# Session → Linear write-back (LOB-15)

**What it is.** The outbound half of the Linear trigger ([linear.md](linear.md)): the issue a
session was delegated from learns what the session did, with no person touching Linear. A small,
declarative map (docs/board.md B11), outbound-only and idempotent:

| When                           | What the issue gets                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| the delivery opens the session | moved to the started state (`In Progress`)                                                                          |
| the PR step opens the PR       | the PR as an attachment, one comment with the link, the session and its verification evidence, moved to `In Review` |
| the PR step refuses or fails   | one comment naming why (over the cap, no change, an error); no state move                                           |
| the PR merges                  | moved to `Done`                                                                                                     |
| the PR closes unmerged         | one comment saying so                                                                                               |
| a new commit lands on the PR   | nothing — the issue's state is the task's, not the review's                                                         |

**A card filed from the issue is followed through its runs (LOB-254).** A card-mode delivery
([linear.md](linear.md)) opens no session and moves nothing: it files a card whose external ref is
`linear:<issue id>`. A run started on the card is bound to the issue through the card
(`task_runs` → `tasks.external_ref`), so its PR, its failure and its merge land on the issue exactly
as rows 2–5 above say, one comment per run's PR (the marker is the run's session id).

`packages/core/src/LinearSync.ts` (`LinearIssueSyncLive` over Linear's GraphQL API; the trigger
seam's `LinearTriggerWriteBack`; the session layer's `LinearSessionWriteBack`; the PR lifecycle
reader `githubPullRequestLifecycle`, `syncPullRequestLifecycle`, and the signed GitHub webhook
handler `handleGitHubPullRequestWebhook`) and
`packages/core/src/SessionWriteBack.ts` (the port `SessionService.openPullRequest` reports its exit
to, and `pullRequestReport`, the one reading of that exit). Wired in `apps/api/src/Api/LinearSync.ts`
(one `LinearIssueSync` for the whole process, provided beside Postgres) and served at
`POST /webhooks/github` by `apps/api/src/Api/GitHubWebhook.ts`.

**How a user reaches it.** Set `LINEAR_API_KEY` beside the Linear webhook's settings. The states are
Linear's default names unless `LINEAR_STATE_STARTED`, `LINEAR_STATE_IN_REVIEW` and
`LINEAR_STATE_DONE` name a team's own; `LINEAR_SESSION_URL_BASE` makes the comment link the session.
No key: no write-back, and the boot log says `linear write-back: off`. The merge and the unmerged
close arrive from GitHub: point a repository webhook (`pull_request` events, content type JSON) at
`POST /webhooks/github` and set `GITHUB_WEBHOOK_SECRET` to its secret; unset, the route answers
`503` to everything, and a wrong `X-Hub-Signature-256` is `401`. A body over
`GITHUB_WEBHOOK_MAX_BODY_BYTES` (1 MiB by default) is `413` before it is read whole — a declared
`Content-Length` over the cap is refused unread, and a chunked body as soon as it passes it.

**Which link is the PR.** GitHub answers a PR with two: `url` is the API resource
(`api.github.com/repos/o/r/pulls/7`) and `html_url` the page (`github.com/o/r/pull/7`). The PR step
records the page — it is what the attachment, the comment and the dashboard link to, and what a
`pull_request` webhook's `html_url` names, which is how a merge finds its session. The webhook also
matches the API resource, for a session recorded before the step read the right field.

**Why a retry writes nothing twice.** Every operation reads the issue first — state, team states,
comments, attachments — and writes only what is missing: a comment carries a marker line
(`factory:<session>:pr`, `factory:<session>:failed:<step>:<digest of the reason>` — so the same
failure again posts nothing, and a different failure of the same step still explains itself), the attachment is keyed by the PR URL,
and a state moves forward only (never back from `In Review` to `In Progress`, never out of a
`completed` or `canceled` state a person chose). A transient Linear failure (transport, a
request that outlives its 5-second bound, `429`, `5xx`, and Linear's rate limit — HTTP `400` with
`RATELIMITED`) is retried twice; a refusal is not. Operations on one issue take that issue's lock;
other issues do not wait on it.

**What a failure does.** Nowhere does a mirror fail the work. At the trigger, a failed or slow
(over 4 seconds) state move is logged and the delivery still succeeds: failing it would give the
claim back, and Linear's redelivery would send the rule's prompt to the same session again — every
time, for a permanent failure. The PR step's report moves the issue past _started_ anyway. At the PR
step, a failed mirror is logged and does not change the step's answer — the PR is the product, the
issue a mirror — and the next report of the same step completes it. The report runs after the
process-wide PR gate is released, so a slow Linear holds up no other session's PR, and the session
layer bounds it (`SESSION_WRITE_BACK_BUDGET`, 10 seconds) and logs any failure or defect it raises,
so a slow or broken tracker cannot stall or fail the step's own answer.

**How the skill drives it.** `./linear-writeback.sh` starts two loopback fakes — Linear's GraphQL
API (`linear-api-fake.ts`, port `LINEAR_WRITEBACK_PORT`, default `API_PORT` or `9416`) and GitHub's
PR endpoint (`github-fake.ts`, the next port) — and runs `bun linear-writeback.ts`: the real
`TriggerService`, the real `SessionService` with its PR step in a real worktree of a throwaway repo,
and the real write-back. Sixteen checks, every one required:

1. A delegated issue opens a session and moves Todo → In Progress.
2. The session records the PR's page, not GitHub's API resource. The fake answers both fields, as
   GitHub does, and the merge event below carries both, spelled by the drive rather than read back
   from the factory.
3. The PR step opens a PR, and the issue carries it as an attachment.
4. One comment carries the PR link, the session link and the verification evidence.
5. The issue reaches In Review.
6. A retried PR step (`already-open`) and Linear's redelivery write nothing more.
7. A run that changed nothing leaves one comment saying why, and the issue stays In Progress.
8. The same failure reported again leaves no second comment.
9. A comment that landed and lost its acknowledgement (the fake answers 500 after applying it) is
   not posted twice.
10. A new commit (`synchronize`) writes nothing to the issue.
11. The merge moves the issue to Done; a merge event with a forged signature is refused first.
12. A mapped issue under a card rule (LOB-254) files exactly one card in `intake` — `linear:<id>`,
    the description as its body, the issue's link — and opens no session.
13. Filing the card writes nothing to Linear: the issue moves when the card's run opens its PR.
14. A replay of that delivery and a second, distinct delivery for the same issue file no second card.
15. A run started on the card (as `factory board start --task` starts one) opens its PR, and the
    issue reaches In Review with the PR attached and exactly one comment carrying its link; a retried
    PR step adds none.
16. Every request carried the configured key, verbatim.

That the checks are not vacuous is a mutation run: with the marker check removed from
`LinearSync.ts`, checks 6, 8 and 9 fail (two comments each). Evidence in `.verify/evidence/lob-15/`;
the card path's in `.verify/evidence/lob-254/` (16/16 on 2026-10-28). Without the card join in
`issueOfSession`, check 15 fails (the issue is
never read), and `LinearSync.test.ts`'s "follows a card's run" turns red.

Checks 10 and 11 are signed `pull_request` bodies through `handleGitHubPullRequestWebhook`, the code
the route runs; the route itself is a thin wrapper over it (headers in, status and JSON out).

**Not built: re-review.** LOB-15 asks that the review be its own item and that a new commit on a
reviewed PR invalidate it. The first half holds — no review state is in the map, and a new commit
writes nothing to the issue. The second needs a review record, which the factory does not keep yet;
it belongs with the review item (LOB-36, whose acceptance already covers a `synchronize` event
invalidating the previous verdict) and is not done here. The criterion is **partially met**.
