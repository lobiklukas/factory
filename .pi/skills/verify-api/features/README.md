# Feature map — session API

One file per user-facing feature of the session surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified run: **2026-10-06**, from the `ralph/LOB-57` worktree with the
human's `factory-postgres-1` holding 5442, API on `:9400` (not the usual `:9200`),
`MODEL_BACKEND=faux`. `bun drive.ts` **29/29**, `./sigterm.sh` **10/10**, `./degraded.sh` **11/11**. `./up.sh` started
while 5442 was taken, and so did the two scripts that own their own API instance (`sigterm.sh`,
`degraded.sh`) on the same precondition — which is what LOB-57 is about. The degraded run used
`PG_PORT=5499` against a throwaway container of its own rather than stopping the human's database;
the owner-selection path it exercises is the same code. Evidence: `.verify/evidence/lob-57/`
(`32-api-drive-final.log` with `32-api-drive-final-observed.json`, `19-sigterm.log`,
`22-degraded.log`). The earlier session-list run for LOB-93 is in `.verify/evidence/lob-93/`. The `bun drive.ts` half was re-run from the `ralph/LOB-104` worktree on 2026-10-06 (`:9400`, faux, Postgres on 5442): **29/29**, evidence `.verify/evidence/lob-104/verify-api/`.
`./sigterm.sh` and `./degraded.sh` were not re-run there, so the two statuses below rest on the
LOB-57 run. The Postgres precondition they and `./up.sh` share changed in LOB-104 (it asks the port
again after a compose that reported success) and LOB-106 (it asks the port after a failed one too,
and the port alone decides), and those changes are covered by
`packages/storage-postgres/src/postgres-up.test.ts` rather than by a drive: with 5442 answering, a
drive returns at the precondition's first probe and never reaches the compose line. The `bun
drive.ts` half was re-run from the `ralph/LOB-106` worktree on 2026-10-06 (`:9400`, faux, Postgres on
5442): **29/29**, evidence `.verify/evidence/lob-106/verify-api/`. The `bun drive.ts` half was
re-run from the `ralph/LOB-140` worktree on 2026-10-07 (`:9400`, faux): **29/29** on a database
created empty for the run (two sessions, which is the case the paging check used to fail on) and
**29/29** against the shared `factory_ralph` (2 883 rows in `session_activity`), evidence
`.verify/evidence/lob-140/`.

The approval checks (LOB-148) were run from the `ralph/LOB-148` branch on 2026-10-24 (API on `:9400`,
faux, Postgres on 5442): `bun drive.ts` with the approval block added, evidence
`.verify/evidence/lob-148/verify-api/`. `./sigterm.sh` and `./degraded.sh` were not re-run there.

The reset checks (LOB-181) were run from the `ralph/LOB-181` worktree on 2026-10-24 (API on `:9400`,
faux, Postgres on 5442): **32/32**, evidence `.verify/evidence/lob-181/`. `./sigterm.sh` and
`./degraded.sh` were not re-run there; neither touches the reset path.

The compaction checks (LOB-185) were run from the `ralph/LOB-185` worktree on 2026-10-24 (API on
`:9400`, faux, Postgres on 5442): **33/33**, evidence `.verify/evidence/lob-185/`. `./sigterm.sh` and
`./degraded.sh` were not re-run there; neither touches the compaction path.

The trigger checks (LOB-188) were run from the `ralph/LOB-188` worktree on 2026-10-24 (API on
`:9400`, faux, Postgres on 5442): **12/12** via `./webhook.sh`, evidence
`.verify/evidence/lob-188/`. They are a separate drive from `bun drive.ts` — the trigger routes are
plain HTTP, not RPC — and `./sigterm.sh` and `./degraded.sh` were not re-run there.

The stale-claim and in-flight checks (LOB-216) were added to `./webhook.sh` and run from the
`agent/LOB-216` worktree on 2026-10-27 (API on `:9540`, faux, the worktree's own database on 5442):
**14/14**, evidence `.verify/evidence/lob-216/webhook/`. The same drive against the seam from before
LOB-216 failed the reclaim check (`replayed: true` to an orphaned claim).

The lifecycle-action checks (LOB-235) were added to `./webhook.sh` and run from the
`agent/LOB-235` worktree on 2026-10-27 (API on `:9520`, faux, the worktree's own database on 5442):
**17/17**, evidence `.verify/evidence/lob-235/webhook/`. The same drive against the adapter from
before LOB-235 failed its first new check: a generic `push` on the `docs` label was recorded
`processed` with `rule "docs" mapped it to …`.

The Sentry receiver checks (LOB-81) were run from the `agent/LOB-81` worktree on 2026-10-27 (API on
`:9510`, faux, the worktree's own database on 5442): `./sentry.sh` **21/21** (13 checks on the first
process, 4 on the restarted one, 4 shell checks), evidence `.verify/evidence/lob-81/`, with a mutation
run failing it (`mutation-key-by-request-id/`). `./webhook.sh` (17/17) and `./linear.sh` (14/14) were
re-run there too, because the route they drive gained the refusal log and the shared signature
verdict. See `sentry.md`.

The Slack adapter checks (LOB-191) were run from the `ralph/LOB-191` worktree on 2026-10-24
(`DATABASE_URL` the worker's own database on 5442, faux, the loopback Slack fake on `:9410`):
`./slack.sh` **18/18**, evidence `.verify/evidence/lob-191/`. They run no API instance — the driver
builds the seam, the session layer and the adapter in-process, as `./jira.sh` and
`./github-issues.sh` do — so `./up.sh`, `./sigterm.sh` and `./degraded.sh` were not part of it.

The GitHub issues adapter checks (LOB-190) were run from the `ralph/LOB-190` worktree on 2026-10-24
(faux, Postgres on 5442): **19/19** via `./github-issues.sh`, evidence
`.verify/evidence/lob-190/`. Like `./jira.sh` it starts no API process: the driver builds the seam
and the fake listens on the port the run reserves for this surface.

The approval-restart checks (LOB-52) were run from the `agent/LOB-52` worktree on 2026-10-27 (API
on `:9501`, faux, the worktree's own database on 5442): `./approval-restart.sh` **22/22**, evidence
`.verify/evidence/lob-52/api/approval-restart-*`; `bun drive.ts` (`:9500`) **52/52** and
`./sigterm.sh` (`:9502`) re-run there, because the policy hook every tool call passes through
changed. See [approvals.md](approvals.md).

The Linear adapter checks (LOB-164) were run from the `agent/LOB-164` worktree on 2026-10-27 (API
on `:9520`, faux, the worktree's own database on 5442): `./linear.sh` **14/14**, evidence
`.verify/evidence/lob-164/`, and `./webhook.sh` re-run there **12/12** because the Linear route it
also posts to changed. See [linear.md](linear.md).

The Linear write-back checks (LOB-15) were run from the `agent/LOB-15` worktree on 2026-10-27
(faux, the worktree's own database on 5442, the loopback Linear fake on `:9512` and GitHub fake on
`:9513`): `./linear-writeback.sh` **12/12**, evidence `.verify/evidence/lob-15/`, with the
no-marker mutation run failing 3 of them. The GitHub fake now answers a PR's `url` and `html_url`
as GitHub does, so `./pr-once.sh`, `./docs-run.sh` and `./docs-trigger.sh` were re-run there too,
all passing. See [linear-writeback.md](linear-writeback.md).

The docs-run checks (LOB-228) were run from the `ralph/LOB-228` worktree on 2026-10-25
(`DATABASE_URL` the worker's own `factory_ralph` on 5442, faux, the loopback GitHub fake on `:9410`):
`./docs-run.sh` **13/13**, evidence `.verify/evidence/lob-228/`. Like `./pr-once.sh` it starts no API
process — the driver builds the service in-process — so `./up.sh`, `./sigterm.sh` and `./degraded.sh`
were not part of it.

The docs-trigger checks (LOB-197) were run from the `ralph/LOB-197` worktree on 2026-10-25
(`DATABASE_URL` the worker's own `factory_ralph` on 5442, faux, the loopback GitHub fake on `:9400`):
`./docs-trigger.sh` **17/17** (14 driver checks, 3 shell checks), evidence
`.verify/evidence/lob-197/`. Like `./docs-run.sh` it starts no API process. See `docs-trigger.md`,
which names the one caller it does not add.

The docs trigger's callers (LOB-234) were run from the `agent/LOB-234` worktree on 2026-10-27 (API
on `:9550`, faux, the worktree's own database on 5442): `./docs-trigger-http.sh` **15/15** (12
driver checks on the `on` boot, 1 on the `off` boot, 2 boot-log checks; re-run after the review added
the interval lower bound, the docs-PR merge skip and the redelivery after registering), evidence
`.verify/evidence/lob-234/`, with two mutation runs failing it (`mutation-no-daemon/`,
`mutation-no-push-route/`). `./docs-trigger.sh` and `./linear-writeback.sh` were re-run there too,
because the module and the GitHub route they drive changed. See `docs-trigger.md`.

The curation checks (LOB-206) were run from the `ralph/LOB-206` worktree on 2026-10-24 (API on
`:9410`, faux, Postgres on 5442, `DATABASE_URL=…/factory_ralph_2`): `bun drive.ts` **47/47** with
the curation block added, evidence `.verify/evidence/lob-206/verify-api/`. `./sigterm.sh` and
`./degraded.sh` were not re-run there; neither touches the curation path.

The mission checks (LOB-230) were run from the `ralph/LOB-230` worktree on 2026-10-24 (API on `:9400`,
faux, Postgres on 5442, `DATABASE_URL=…/factory_ralph`): `bun drive.ts` with the mission block added,
evidence `.verify/evidence/lob-230/verify-api/`. `./sigterm.sh` and `./degraded.sh` were not re-run
there; neither touches the mission path. See `mission.md`, which names what the case does not prove
(resume across a kill — LOB-231).

The mission checks were re-run for LOB-233 (the document names the phase its checkpoint is in)
from the `agent/LOB-233` worktree on 2026-10-27 (API on `:9560`, faux, Postgres on 5442,
`DATABASE_URL=…/factory_agent_lob_233`): `bun drive.ts` **52/52**, evidence
`.verify/evidence/lob-233-r3/` (after the review fixes; `lob-233-final/` before them). Some runs
there, on clean `origin/main` as well as on the branch, failed the four live-stream checks together
(`the stream opens with a live snapshot` saw `mode=historical`, then no entries, run state or
answer); a re-run passed each time, so that race is not this issue's and not a regression from it.
The drive cannot stop a mission between two of its commits, so the claim itself is proven in
`packages/harness/src/mission.test.ts` — see `mission.md`.

The `verify` tool checks (LOB-78) were run from the `agent/LOB-78` worktree on 2026-10-27
(`DATABASE_URL` the worker's own `factory_agent_lob_78` on 5442, faux): `./verify-tool.sh` **13/13** (re-run after the second review: the declared command once per call, and the `VERIFY_NO_DATABASE` check in `pass`),
evidence `.verify/evidence/lob-78/api/`. Like `./docs-run.sh` it starts no API process. `bun drive.ts`
was re-run there too (API on `:9550`, faux): **52/52**, evidence `.verify/evidence/lob-78/verify-api/`
— every session now has the tool installed, and nothing the drive asserts changed.

The PR evidence checks (LOB-79) were run from the `agent/LOB-79` worktree on 2026-10-27
(`DATABASE_URL` the worktree's own `factory_agent_lob_79` on 5442, faux, the fake GitHub on
`API_PORT=9540`): `./pr-evidence.sh` **10/10**, evidence `.verify/evidence/lob-79/api/`. Like
`./pr-once.sh` it starts no API process.

The spec-document checks (LOB-72) were run from the `agent/LOB-72` worktree on 2026-10-27
(`DATABASE_URL` the worktree's own `factory_agent_lob_72` on 5442, faux, no port bound): `./spec.sh`
**9/9** (8 driver checks across two processes, 1 shell check that they were two), evidence
`.verify/evidence/lob-72/`. Like `./pr-once.sh` it starts no API process — the driver opens the
harness in-process — so `./up.sh`, `./sigterm.sh` and `./degraded.sh` were not part of it.

The budget-cap checks (LOB-163) were run from the `agent/LOB-163` worktree on 2026-10-27
(`DATABASE_URL` the worktree's own `factory_agent_lob_163` on 5442, faux priced at `FAUX_COST=0.01`,
`SESSION_BUDGET=1`, API on `BUDGET_PORT=9570`): `./budget.sh` **19/19** (12 driver checks, 7 shell
checks), evidence `.verify/evidence/lob-163/api/`. `bun drive.ts` was re-run there too (API on
`:9571`, faux): **52/52**, evidence `.verify/evidence/lob-163/verify-api/` — every session now has
the hook installed and a fork writes its parent's cap, and nothing the drive asserts changed. See
[budget.md](budget.md), which names what the drive does not reach (forks and replays, the dashboard
row).

The PR-step RPC checks (LOB-213) were run from the `agent/LOB-213` worktree on 2026-10-27
(`DATABASE_URL` the worktree's own `factory_agent_lob_213` on 5442, faux, API on `PR_RPC_PORT=9520`,
the loopback GitHub fake on `PR_RPC_GITHUB_PORT=9521`): `./pr-rpc.sh` **12/12** (7 driver checks, 5
shell checks), evidence `.verify/evidence/lob-213/api/`, with the no-handler mutation run failing it.
See [pr-rpc.md](pr-rpc.md).

The pages-surface checks (LOB-220) were run from the `agent/LOB-220` worktree on 2026-10-27
(`DATABASE_URL` the worktree's own `factory_agent_lob_220` on 5442, faux priced at `FAUX_COST=0.01`,
API on `PAGES_PORT=9570`): `./pages.sh` **15/15** (12 driver checks, 3 shell checks), evidence
`.verify/evidence/lob-220/api/`, with three mutation runs (no dedupe, a free repeat, no page fold in
the rebuild) each failing it, in `.verify/evidence/lob-220/mutation/`. See [pages.md](pages.md).

The replay checks (LOB-215) were added to `bun drive.ts` and run from the `agent/LOB-215` worktree
on 2026-10-27 (API on `:9550`, faux with `faux/faux-2` published by `up.sh`, the worktree's own
database on 5442): **58/58** (52 before, 6 replay checks), evidence `.verify/evidence/lob-215/`,
with the no-replay-document mutation run failing exactly the log check (57/58). See
[replay.md](replay.md).

| Feature                  | Status  | File                                       |
| ------------------------ | ------- | ------------------------------------------ |
| Create a session         | passing | [create.md](create.md)                     |
| Repo binding             | passing | [repo-binding.md](repo-binding.md)         |
| Session list             | passing | [session-list.md](session-list.md)         |
| Watch a live session     | passing | [live-stream.md](live-stream.md)           |
| Reset a session          | passing | [reset.md](reset.md)                       |
| Compact on demand        | passing | [compact.md](compact.md)                   |
| Fold a released session  | passing | [fold.md](fold.md)                         |
| Fork a session           | passing | [fork.md](fork.md)                         |
| Replay a session         | passing | [replay.md](replay.md)                     |
| Request limits           | passing | [limits.md](limits.md)                     |
| Probes and readiness     | passing | [probes.md](probes.md)                     |
| Shutdown and recovery    | passing | [lifecycle.md](lifecycle.md)               |
| Errors over the wire     | passing | [errors.md](errors.md)                     |
| One PR across a kill     | passing | [pr-once.md](pr-once.md)                   |
| Inbound triggers         | passing | [trigger.md](trigger.md)                   |
| Jira adapter             | passing | [jira.md](jira.md)                         |
| GitHub issues adapter    | passing | [github.md](github.md)                     |
| Slack adapter            | passing | [slack.md](slack.md)                       |
| Linear adapter           | passing | [linear.md](linear.md)                     |
| Sentry receiver          | passing | [sentry.md](sentry.md)                     |
| Linear write-back        | passing | [linear-writeback.md](linear-writeback.md) |
| Approvals                | passing | [approvals.md](approvals.md)               |
| Curate a session's pages | passing | [curate.md](curate.md)                     |
| A mission                | passing | [mission.md](mission.md)                   |
| A docs run               | passing | [docs-run.md](docs-run.md)                 |
| A docs run on a trigger  | passing | [docs-trigger.md](docs-trigger.md)         |
| The `verify` tool        | passing | [verify-tool.md](verify-tool.md)           |
| PR evidence block        | passing | [pr-evidence.md](pr-evidence.md)           |
| The spec document        | passing | [spec.md](spec.md)                         |
| A budget cap             | passing | [budget.md](budget.md)                     |
| The PR step over RPC     | passing | [pr-rpc.md](pr-rpc.md)                     |
| The pages surface        | passing | [pages.md](pages.md)                       |

## Deliberately absent

- **Steering (`whenBusy`) as its own check.** Queueing is Pi Durable's job and is covered by
  `packages/core`'s suite at the service level. The RPC payload carries `whenBusy`; what the drive
  proves here is that a message is admitted and answered.
- **Multi-replica fan-out (D12).** Live streaming is in-process: the replica that owns a session
  streams it. `SessionBus` (`packages/bus`) does not exist yet, so a session owned by another
  process reads as historical here. A second replica is not verifiable until it does.
- **A migration that has not been applied.** `/readyz` names a missing migration in principle, and
  `degraded.sh` proves the database-down branch; dropping a migration row to prove the middle branch
  would corrupt the ledger this repo's suites share.
- **Isolation, sandboxes, worktrees.** Nothing in this surface touches a cluster; sessions run in a
  scratch directory under `SESSION_ROOT` (M6 owns per-session git worktrees).
