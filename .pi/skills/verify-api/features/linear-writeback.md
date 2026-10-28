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
and the real write-back. Twenty-two checks, every one required (the T5 ones are 17–22 below):

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
17. A mapped issue with an open `blockedBy` relation is skipped with `blocked by <id>` and files no
    card (T5).
18. Once the blocker is Done in Linear, the same delivery files the card; a redelivery of that is a
    replay.
19. A run's `ask` on a Linear-sourced card parks it `needs_input` and posts exactly one agent
    activity of type `elicitation`, carrying the question verbatim, in an agent session opened on
    the issue.
20. The ask replayed (the ask write-back called again with the ledger's ask id) posts nothing.
21. A reply event (`AgentSessionEvent` `prompted`) lifts `needs_input` as the card's verbatim
    `answer` comment, written by `trigger:linear`, and cost no request to Linear.
22. A redelivered reply, and a second reply once the wait is answered, record nothing.

That the checks are not vacuous is a mutation run: with the marker check removed from
`LinearSync.ts`, checks 6, 8 and 9 fail (two comments each). Evidence in `.verify/evidence/lob-15/`;
the card path's in `.verify/evidence/lob-254/` (16/16 on 2026-10-28). Without the card join in
`issueOfSession`, check 15 fails (the issue is
never read), and `LinearSync.test.ts`'s "follows a card's run" turns red.

Checks 10 and 11 are signed `pull_request` bodies through `handleGitHubPullRequestWebhook`, the code
the route runs; the route itself is a thin wrapper over it (headers in, status and JSON out).

**A question goes back to Linear, and an issue with open blockers does not start (T5).** Two more
things the Linear adapter does, in `packages/core/src/LinearElicitation.ts`:

- _The question._ When a run on a card filed from a Linear issue (`linear:<id>`) calls `ask`, the
  card parks `needs_input` as always (B7) and the question is also posted into Linear as one agent
  activity of type `elicitation` (`agentActivityCreate`, content `{type: "elicitation", body}`) in
  the agent session the factory holds on that issue. The first question opens it
  (`agentSessionCreateOnIssue`); `linear_agent_sessions` keeps it, so every later question on the
  issue is one more activity in the same thread. `linear_elicitations` (keyed by the ask id,
  `<session>:<tool call>`) is the ledger: written after Linear accepted the activity, so a replayed
  ask posts nothing and an ask whose post failed is posted by its replay. It is a mirror — the
  question is on the card first and a Linear that is down is a logged line, not a failed ask
  (`AskWriteBack`, bounded by `SESSION_WRITE_BACK_BUDGET`). The two mutations are **not retried**
  inside the request (unlike the read-before-write operations above): a timeout or a lost
  acknowledgement cannot be told from a miss, and a retry would post the question twice. The
  recovery is the ask's replay and the ledger. At-least-once, with the duplicate confined to a crash
  between Linear accepting the activity and the ledger row. Posts are serialized per issue, so a slow
  Linear on one issue does not hold another issue's question past the write-back budget.
- _The reply._ The person answers in the thread and Linear sends an `AgentSessionEvent` of action
  `prompted` carrying their text. The Linear route reads it as a reply (`TriggerEvent.reply`, keyed
  by the activity: `linear:<activity id>:reply`) and the seam hands it to the board: if a card filed
  from that issue is blocked `needs_input` **and the event is in the agent session the factory asked
  in** (`linear_agent_sessions`; a message in any other session on the issue is a recorded skip
  naming it), the text becomes its `answer` comment, verbatim, by
  `trigger:linear` — which lifts the block — and the delivery is `processed` naming the card. The
  text is the event's; nothing reads a comment back from Linear (docs/board.md B7: answers are
  events, never re-read editable comments). A reply with no card waiting is a recorded skip, which
  is also what a redelivered one reads as.
- _The blockers._ For a delivery a rule maps and whose repo is registered, the seam asks Linear for
  the issue's inverse relations (`query FactoryBlockers`) and skips it with `blocked by ENG-41,
ENG-43` while any `blocks` blocker is not `completed` or `canceled`. The skip is keyed by the
  issue (`keyedByWork`), so a delivery that arrives once the blockers are done reclaims it and files
  the card. The skip is answered `200`, so Linear does not retry it, and Linear sends no event when
  a blocker changes state: **a person must re-add the label** (or the issue be created again) once
  the blockers are done. Nothing recomputes on its own when a blocker merges: that is the
  dependency-ready dispatcher (LOB-42), not built. A blocker read that
  fails fails the delivery (`tracker-read`, `500`): Linear retries it, and nothing starts on a guess.
  Without `LINEAR_API_KEY` there is nothing to read and no gate.

**What the deployment needs for T5.** The agent operations are for an _app actor_: the OAuth app's
token (set `LINEAR_API_KEY` to `Bearer <token>`, as above), not a personal API key: Linear's agent API
is for an app actor, so with a personal key expect `agentSessionCreateOnIssue` and
`agentActivityCreate` to fail (unverified live), and every elicitation is then only a logged line. The app's webhook must also have the _Agent session events_ category enabled so
`prompted` replies arrive. Known limits, follow-ups on the umbrella: a `created` event (the app was
mentioned or an issue was delegated to it) is answered `200` and skipped, where Linear expects an
activity within 10 seconds, and the delegated session is not adopted as the thread the question
goes to (the factory opens its own); the answer is recorded as `trigger:linear`, not as the person
who wrote it.

**Not built: re-review.** LOB-15 asks that the review be its own item and that a new commit on a
reviewed PR invalidate it. The first half holds — no review state is in the map, and a new commit
writes nothing to the issue. The second needs a review record, which the factory does not keep yet;
it belongs with the review item (LOB-36, whose acceptance already covers a `synchronize` event
invalidating the previous verdict) and is not done here. The criterion is **partially met**.
