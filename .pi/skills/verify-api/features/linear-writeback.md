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
`503` to everything, and a wrong `X-Hub-Signature-256` is `401`.

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
process-wide PR gate is released, so a slow Linear holds up no other session's PR.

**How the skill drives it.** `./linear-writeback.sh` starts two loopback fakes — Linear's GraphQL
API (`linear-api-fake.ts`, port `LINEAR_WRITEBACK_PORT`, default `API_PORT` or `9416`) and GitHub's
PR endpoint (`github-fake.ts`, the next port) — and runs `bun linear-writeback.ts`: the real
`TriggerService`, the real `SessionService` with its PR step in a real worktree of a throwaway repo,
and the real write-back. Eleven checks, every one required:

1. A delegated issue opens a session and moves Todo → In Progress.
2. The PR step opens a PR, and the issue carries it as an attachment.
3. One comment carries the PR link, the session link and the verification evidence.
4. The issue reaches In Review.
5. A retried PR step (`already-open`) and Linear's redelivery write nothing more.
6. A run that changed nothing leaves one comment saying why, and the issue stays In Progress.
7. The same failure reported again leaves no second comment.
8. A comment that landed and lost its acknowledgement (the fake answers 500 after applying it) is
   not posted twice.
9. A new commit (`synchronize`) writes nothing to the issue.
10. The merge moves the issue to Done; a merge event with a forged signature is refused first.
11. Every request carried the configured key, verbatim.

That the checks are not vacuous is a mutation run: with the marker check removed from
`LinearSync.ts`, checks 5, 7 and 8 fail (two comments each). Evidence in `.verify/evidence/lob-15/`.

Checks 9 and 10 are signed `pull_request` bodies through `handleGitHubPullRequestWebhook`, the code
the route runs; the route itself is a thin wrapper over it (headers in, status and JSON out).

**Not built: re-review.** LOB-15 asks that the review be its own item and that a new commit on a
reviewed PR invalidate it. The first half holds — no review state is in the map, and a new commit
writes nothing to the issue. The second needs a review record, which the factory does not keep yet;
it belongs with the review item (LOB-36) and is not done here.
