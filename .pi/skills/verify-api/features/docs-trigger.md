# A docs run that starts without a person (LOB-197, part 3 of LOB-37)

**What it is.** A documentation run that no one clicked: a **push** to the default branch, or an
**interval schedule**, is a delivery to the same trigger seam the Linear, generic, GitHub issue and
Jira adapters deliver to (LOB-188) — so it is deduped by delivery id and refused by the same rules —
and the session it starts works on `factory/doc-<delivery id>`, never on the default branch.

**How a user reaches it.** They don't; that is the point. The pieces a user can see:
`docsTriggerRules(repo)` registers the `docs` label, `docsPushDelivery` normalizes a GitHub `push`
payload (only a push to the configured default branch is a delivery; a deletion, another branch and a
payload that is not a push are refused), `docsSchedule` is the clock, and
`DocsSessionsFromSessionService` is the seam's session port filled with `SessionService.create` on the
docs branch. The branch is persisted on the session's index row and committed into its
`factory.session` document, so the workspace, the PR step and the teardown all read the same branch.
The App installation token is the identity the run's PR is opened with (`CredentialProvider`, LOB-51);
nothing else about a service account is modelled here.

**How the skill drives it.** `./docs-trigger.sh` — one driver process that builds the real service
in-process (as `./pr-once.sh` and `./docs-run.sh` do; no API instance is started) against a loopback
GitHub fake whose ledger is a file on disk. The repo is a real git checkout with one `main` commit,
under this script's own `SESSION_ROOT`, and the repo slug carries a per-run suffix so another suite's
rows cannot answer "how many docs runs did this prove?":

1. **push** — one `push` delivery naming the checkout's HEAD, then the same delivery again. Exactly
   one session, the second answer `replayed: true`; the run's `workspace.branch` is
   `factory/doc-<delivery id>` and `git rev-parse --abbrev-ref HEAD` inside the worktree says the
   same, so the branch is one git cut and not a string the service reported; the rule's prompt is the
   session's first message; the driver commits a docs file and calls the real PR step, which opens
   one PR from that branch against `main`.
2. **schedule** — the real `docsSchedule` forked on a shortened clock (400 ms) and interrupted: one
   session per interval, each on its own `factory/doc-schedule-<interval>` branch (the branch is named
   after the interval the tick covers, so two wakes inside one interval cannot start two runs). Then
   the same clock with `everyMs` unset: nothing arrives at all.
3. **ledger** — every request GitHub received, read from the fake: one `POST` for the PR and nothing
   else, no request that writes a ref, a file or a merge, and no PR whose head is `main`.

**What proves it works.** Evidence is local, not tracked (`.verify/` is gitignored, as for every
drive in this skill). `.verify/evidence/lob-197/api/`: `docs-trigger.json` (the driver's own
14 checks and what each phase saw), `docs-trigger-process.json` (the script's 3 shell checks),
`docs-trigger-ledger.json` (every request and the one PR), `docs-trigger-fake.log`.

**Non-vacuity.** Two hand mutation runs, each in its own directory beside the green one (its
`run.log`, and the `api/docs-trigger-process.json` that run wrote). `mutation-no-branch/`: dropping
`branch` from `DocsSessionsFromSessionService` (so the port calls `sessions.create` with no branch)
makes the run open on `factory/<session-id>` and then fail the PR step, because the head the driver
asked for is a branch no worktree is on — eight checks fail, the branch pair first.
`mutation-no-repeat/`: `docsSchedule` returning its first `tick` instead of repeating it leaves one session where the interval should start several, and "the
schedule fires once per interval, on a shortened clock" fails with `1 tick(s) in 1200ms`.

**Its callers (LOB-234).** `apps/api` starts both without a drive script, and
`./docs-trigger-http.sh` proves it over real HTTP against two booted APIs (`up.sh`'s isolation, port
9422 by default). The `on` boot sets `DOCS_SCHEDULE_MS=400`, `DOCS_SCHEDULE_REPO` and
`GITHUB_WEBHOOK_SECRET`: before the repo is registered the daemon starts nothing; once it is,
`factory/doc-schedule-<interval>` sessions appear, one per interval (distinct intervals, each a
multiple of 400 ms, no more than the wall clock allows and no fewer than its whole intervals less two —
the clock sleeps to the next interval boundary rather than `everyMs` after each tick, so a tick's own
duration does not push the next one past an interval; `DocsTrigger.test.ts` pins it exactly on a test
clock); a signed `push` to the default branch on
`POST /webhooks/github` answers `{status: "processed", sessionId}` on `factory/doc-push-…`, GitHub's
redelivery (a fresh `X-GitHub-Delivery`) answers `replayed: true`, a push to another branch is
`400 not-default-branch`, the merge commit of a `factory/doc-*` pull request (`Merge pull request #N
from owner/factory/doc-…`) is `200 skipped` so merging a docs PR does not start the next pass, a push
to a repo not yet registered is skipped and GitHub's redelivery of it after registering starts its one
run (a push delivery is `keyedByWork`), a wrong `X-Hub-Signature-256` and the digest without its `sha256=` prefix
are `401`, a `ping` still reaches the `pull_request` handler (`202`), and the push repo holds exactly
one session. The `off` boot leaves `DOCS_SCHEDULE_MS` unset with its repo registered: no schedule
session. Both boots' logs say which they were. The route's handler and the daemon's
`runDocsSchedule` are also cases in `packages/core/src/DocsTrigger.test.ts`, on the real seam and
Postgres. Evidence: `.verify/evidence/lob-234/` (`docs-trigger-http-{on,off}.json` and `.log`,
`api-{on,off}.log`); two mutation runs beside it — `mutation-no-daemon/` (the daemon layer left out
of the boot: the schedule check and the boot-log check fail) and `mutation-no-push-route/` (the
route never dispatches `push`: every push answer is the `pull_request` handler's `202`, four checks
fail).

**What it does not prove.** (1) `./docs-trigger.sh` runs the clock itself; that the API runs it is
`./docs-trigger-http.sh`'s claim, above. (2) A failed
delivery is logged and the _next_ interval retries the next tick; the failed interval is not replayed,
which is the seam's design (a tick is named by its interval) and is not exercised here. (3) The
GitHub push route is not part of this drive (the delivery is handed to the seam directly); it is
`./docs-trigger-http.sh`'s, which in turn opens no PR. (4) Nothing here pushes a branch,
so "no write to the default branch" is a claim about what the control plane asked GitHub to do, which
is exactly what the ledger counts. (5) A docs PR merged by **squash or rebase** leaves no trace of its
`factory/doc-*` branch in the pushed commit, so `isDocsRunMerge` does not recognize it and that merge
starts one more docs pass. Each round still needs a person to merge, so it cannot run away; telling
those merges apart needs the PR the commit came from (GitHub's commits-to-PRs lookup), which is not
built. (6) The schedule's guarantee is exact while a tick is shorter than its interval; an interval
that begins and ends while a slow tick is still running is not delivered (at most once per interval,
never a backlog of stale passes).
