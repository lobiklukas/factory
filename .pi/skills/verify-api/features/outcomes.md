# Outcome metrics

**What it is.** The outcome metrics (LOB-44, `docs/metrics.md` § Outcome metrics): lead time, cycle
time, defect pressure, recovery, adoption and cost over a window, every value with its window, its
denominator and its source. One read of the index tables (`getOutcomes`), never a fold of a log and
never a read of GitHub or Linear. A merge is the factory's own record: the `pull_request` webhook
commits `factory.merge` to the PR's sessions (and the revert a later `Reverts owner/repo#N` PR names
to that PR's), indexed in `sessions.pr_merged_at` and `pr_reverted_at`.

**How a user reaches it.** `factory outcomes [--since <iso>] [--until <iso>] [--repo owner/name]
[--json]` — the last thirty days when no window is named. The webhook is `POST /webhooks/github`,
signed with `GITHUB_WEBHOOK_SECRET`, which GitHub already calls for the Linear mirror and the
workspace release.

**How the skill drives it.** `./outcomes.sh` boots the API (`./up.sh`, faux) with a webhook secret
and `GITHUB_API_URL` at a loopback port nothing listens on. `outcomes.ts` registers a repo of the
run's own, creates a Linear-delegated session and a direct one over RPC, links the first to PR 1,
and posts a signed merge of PR 1, its redelivery, and a signed merge of PR 2 whose body says
`Reverts <repo>#1`. It checks the merge and the revert on the session's row and in its log
(`readSessionLog`'s `merge`), that the redelivery committed nothing, then runs the CLI —
`factory outcomes --json` and the table — and checks the report: the window on every value, the
delegation's lead time equal to the merge minus the session's creation over one issue, one reverted
merge of one, one Linear and one direct session of two, and the cost equal to
`session_activity.cost_total`. The shell checks the API log says it recorded the merge.

**Observable end state.** `.verify/evidence/latest/api/outcomes.json` (every check, the report, the
log's merge record), `outcomes-report.txt` (the CLI's table) and `outcomes-api.log`. With the route's
merge record removed, the drive times out waiting for the merge and the log check fails
(`.verify/evidence/lob-44/mutation-no-record/`).

**What it does not prove.** Every metric's arithmetic over a realistic history — cards, overlapping
runs, re-runs, follow-ups, approvals, other repos and windows — is the gate's
(`packages/core/src/outcomes.test.ts`, against a hand-computed oracle); the rebuild of the merge
columns from the log is `apps/api/src/Api/GitHubWebhook.test.ts`'s. That GitHub sends `merged_at`,
`merge_commit_sha` and the revert body as the fake does is the GitHub row of
`docs/testing-third-parties.md`. Numbers over real sessions are the follow-up report issue.
