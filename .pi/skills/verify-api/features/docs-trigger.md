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
`mutation-no-repeat/`: `docsSchedule` returning its first `tick` instead of repeating it on
`Schedule.spaced(everyMs)` leaves one session where the interval should start several, and "the
schedule fires once per interval, on a shortened clock" fails with `1 tick(s) in 1200ms`.

**What it does not prove.** (1) The schedule is not started by `apps/api`: this drive runs the clock
itself, and the daemon that would run it in a deployment is a caller this issue does not add — the
same "the step has no caller" shape as the PR step's, filed rather than pretended. (2) A failed
delivery is logged and the _next_ interval retries the next tick; the failed interval is not replayed,
which is the seam's design (a tick is named by its interval) and is not exercised here. (3) The
GitHub push route is not part of this drive: the delivery is handed to the seam directly, so what is
proven is the trigger, not the signature check in front of a route — `features/trigger.md` covers the
route machinery that a future `POST /webhooks/github` would reuse. (4) Nothing here pushes a branch,
so "no write to the default branch" is a claim about what the control plane asked GitHub to do, which
is exactly what the ledger counts.
