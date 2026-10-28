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

The dev task's environment (LOB-257) was proved by `API_VIA_TURBO=1 ./webhook.sh`, run from the
`agent/LOB-257` worktree on 2026-10-28 (API on `:9510`, started through `turbo run dev
--filter=@repo/api` in Strict Mode, the worktree's own database on 5442): **17/17**, evidence
`.verify/evidence/lob-257/webhook/`. The same drive against `apps/api/turbo.json` from before
LOB-257 failed the first check with `503 not-configured (TRIGGER_SECRET)`: Strict Mode had stripped
the secret (`webhook-before/`).

The Sentry receiver checks (LOB-81) were run from the `agent/LOB-81` worktree on 2026-10-27 (API on
`:9510`, faux, the worktree's own database on 5442): `./sentry.sh` **22/22** (14 checks on the first
process, 4 on the restarted one, 4 shell checks; re-run after the cap moved past normalization), evidence `.verify/evidence/lob-81/`, with a mutation
run failing it (`mutation-key-by-request-id/`). `./webhook.sh` (17/17) and `./linear.sh` (14/14) were
re-run there too, because the route they drive gained the refusal log and the shared signature
verdict. See `sentry.md`.

The Sentry mapping checks (LOB-82: the filter, the title, the issue bound to its session, the default
prompt) were run from the `agent/LOB-82` worktree on 2026-10-28 (API on `:9530`, faux, the worktree's
own database on 5442): `./sentry.sh` **33/33** (23 checks on the first process, 6 on the restarted
one, 4 shell checks), evidence `.verify/evidence/lob-82/`, with a mutation run that skips the
fingerprint claim failing it (`mutation-no-binding/`). See `sentry.md`.

The Sentry link-back checks (LOB-83: one note on the alert's Sentry issue naming the session, once
across a redelivery, a lost acknowledgement, a bound second alert and an API restart; a 503 or a silent
Sentry never fails the delivery) were run from the `agent/LOB-83` worktree on 2026-10-28 (API on
`:9560`, the fake Sentry REST API on `:9561`, faux, the worktree's own database on 5442): `./sentry.sh`
**51/51** (12 checks in the `linkback` phase, 25 on the first process, 9 on the restarted one, 5 shell
checks), evidence `.verify/evidence/lob-83/`, with a mutation run that skips the read-before-post
failing it (`mutation-no-read-before-post/`). See `sentry.md`.

The Jira, Slack and GitHub-issues adapters are served over HTTP (LOB-259) and their drives were run
from the `agent/LOB-259` worktree on 2026-10-28 (faux, Postgres on 5442, the worktree's own database):
`./jira.sh` **16/16 + 2/2**, `./slack.sh` **19/19 + 2/2** and `./github-issues.sh` **15/15 + 2/2**,
evidence `.verify/evidence/lob-259/`. Each boots its own API (`adapter-lib.sh`) pointed at a loopback
fake of the third party — twice, the second time with the route's secret unset, which is the `2/2` —
and posts signed deliveries at it; `./up.sh`, `./sigterm.sh` and `./degraded.sh` were not part of it.
`./docs-trigger-http.sh`, `./review.sh` and `./linear-writeback.sh` were re-run there (all green)
because `POST /webhooks/github` and the session layer's write-back changed under them: the push and
`pull_request` paths are the same code, and Linear's mirror of the PR step now runs beside Slack's.
See [jira.md](jira.md), [slack.md](slack.md) and [github.md](github.md).

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

The review agent (LOB-36) was run from the `agent/LOB-36` worktree on 2026-10-28 (API on `:9560`,
forge on `:9561`, faux, the worktree's own database on 5442): `./review.sh` **13/13**, evidence
`.verify/evidence/lob-36/`. `./docs-trigger-http.sh` and `./linear-writeback.sh` were re-run there,
because the GitHub route they drive now hands a `pull_request` to the review too. See `review.md`.

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

The mission fan-out checks (LOB-193) were run from the `agent/LOB-193` worktree on 2026-10-27 (API
on `:9530`, faux, Postgres on 5442, `DATABASE_URL=…/factory_agent_lob_193`): `bun drive.ts`
**64/64** with the fan-out block added (two workers held live and joined; a failing worker under
`failFast` stopping its sibling's running check, whose beat is written before the mark the failing
worker waits on, and leaving the mission in `implement`; a check that writes outside the worktree
refused by the session's policy), re-run after the review fixes, evidence
`.verify/evidence/lob-193-r2/verify-api/`.
The abort reason on the aborted worker, `allSettled`, and the join reading only once both workers
are terminal are proven from the task graph in `packages/harness/src/mission.fanout.test.ts` — see
`mission.md`.

The per-worker cost checks (LOB-194) were run from the `agent/LOB-194` worktree on 2026-10-28
(`MISSION_COST_PORT=9581`, a priced faux, `DATABASE_URL=…/factory_agent_lob_194` on 5442):
`./mission-cost.sh` **10/10** (7 driver checks across the run and the reopen, 3 shell checks),
evidence `.verify/evidence/lob-194/api/`. See [mission.md](mission.md).

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

The cost-prediction checks (LOB-38) were run from the `agent/LOB-38` worktree on 2026-10-28
(`DATABASE_URL` naming the worktree's own server on 5442, and the script minting and dropping its own
`factory_verify_cost_<random>` database there; faux priced at `FAUX_COST=0.01`; API on
`COST_PORT=9551`): `./cost.sh` **28/28** (11 driver checks, 2 capped-session checks, 15 shell checks),
evidence `.verify/evidence/latest/api/cost*`. See [cost.md](cost.md).

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

The decomposition checks (LOB-201) were run from the `agent/LOB-201` worktree on 2026-10-27
(`DATABASE_URL` the worktree's own `factory_agent_lob_201` on 5442, a scratch database minted on it,
faux with `FAUX_SPEC`, API on `DECOMPOSE_PORT=9521`): `./decompose.sh` **11/11** (8 driver checks,
3 shell checks), evidence `.verify/evidence/lob-201/api/`. See [decompose.md](decompose.md).

The approval checks (LOB-202) were run from the `agent/LOB-202` worktree on 2026-10-28
(`DATABASE_URL` the worktree's own `factory_agent_lob_202` on 5442, a scratch database minted on it,
faux with `FAUX_SPEC` and `FAUX_DECOMPOSITION`, the API on `APPROVE_PORT=9681` and the loopback Linear
on `APPROVE_LINEAR_PORT=9682`): `./approve-proposals.sh` **11/11** (8 driver checks, 3 shell checks),
evidence `.verify/evidence/lob-202/api/`. See [approve-proposals.md](approve-proposals.md).

The replay checks (LOB-215) were added to `bun drive.ts` and run from the `agent/LOB-215` worktree
on 2026-10-27 (API on `:9550`, faux with `faux/faux-2` published by `up.sh`, the worktree's own
database on 5442): **58/58** (52 before, 6 replay checks), evidence `.verify/evidence/lob-215/`,
with the no-replay-document mutation run failing exactly the log check (57/58). See
[replay.md](replay.md).

The replay comparison checks (LOB-199) were added to the same block and run from the
`agent/LOB-199` worktree on 2026-10-27 (API on `:9540`, the worktree's own database on 5442):
**61/61** (3 comparison checks), evidence `.verify/evidence/lob-199/`. With the source's comparison
write removed, the drive times out on "the source's replay comparison" (36/37), in
`.verify/evidence/lob-199/mutation/`. Under heavy machine load the four live-stream checks can see a
`historical` first snapshot: `SESSION_IDLE_TIMEOUT_MS=2000` releases the session before the watch
attaches. That happens on clean `main` too (2 of 3 fresh runs failed there that day). After the review fixes (the comparison is now recovered from the logs and forks are measured by
the task they copied), the drive was rerun on `:9540`: **61/61**, evidence
`.verify/evidence/lob-199/review/`. A first rerun at load average 88 failed only those four
live-stream checks.

The workspace-lifecycle checks (LOB-268) were added to `./sigterm.sh` and run from the
`agent/LOB-268` worktree on 2026-10-28 (`SIGTERM_PORT=9540`, faux, the worktree's own database on
5442): **22/22** (15 driver checks across the two phases, 7 shell checks of the process and of the
branch and worktree on disk while no process ran), evidence `.verify/evidence/lob-268/api/`. With the
old teardown put back into the owner's release, seven checks fail — the branch is gone after the
shutdown, and the restarted read cuts a fresh one at the base. See [lifecycle.md](lifecycle.md).

The mission-restart checks (LOB-231) were run from the `agent/LOB-231` worktree on 2026-10-28
(`API_PORT=9640`, faux, a scratch database minted on the worktree's own server on 5442):
`./mission-restart.sh` **21/21** (12 driver checks across the two phases, 9 shell checks of the
process, the boot's log, and the row the next boot reads with the session root it is marked under;
re-run after review scoped the boot's resume to its own root), evidence `.verify/evidence/lob-231/api/`.
With the boot's resume query made to find nothing, the verify phase times out waiting for the
resumed workers and four checks fail, in `.verify/evidence/lob-231/mutation-no-boot-resume/`. See
[mission.md](mission.md).

The run-restart checks (LOB-25) were run from the `agent/LOB-25` worktree on 2026-10-28 (faux, a
scratch database minted on the worktree's own server on 5442): `./run-restart.sh` **17/17** under
`SIGKILL` (`RUN_RESTART_PORT=9511`, evidence `.verify/evidence/lob-25/api/`) and **17/17** under
`KILL_SIGNAL=TERM` (`RUN_RESTART_PORT=9512`, evidence `.verify/evidence/lob-25-term/api/`): the
run on its tool call, the signal, no shutdown line under `SIGKILL`, the row the next boot reads, the
same submission resumed at boot with its call settled as interrupted, and the boot's and the
reopen's resume lines. Re-run after review scoped the reopen's resume to the root conversation's
submissions. No drive mutation was run; the root scoping is mutation-checked in `packages/harness`'s
`resume.test.ts`. See [lifecycle.md](lifecycle.md).

The admission-control checks (LOB-70) were run from the `agent/LOB-70` worktree on 2026-10-28
(`DATABASE_URL` the worktree's own `factory_agent_lob_70` on 5442, faux, the API on
`ADMISSION_PORT=9500` with `SESSION_MAX_CONCURRENT=2` and `SESSION_IDLE_TIMEOUT_MS=3000`):
`./admission.sh` **11/11** (8 driver checks, 3 shell checks), evidence
`.verify/evidence/latest/api/admission*.json`. See [limits.md](limits.md).

| Feature                  | Status  | File                                         |
| ------------------------ | ------- | -------------------------------------------- |
| Create a session         | passing | [create.md](create.md)                       |
| Repo binding             | passing | [repo-binding.md](repo-binding.md)           |
| Session list             | passing | [session-list.md](session-list.md)           |
| Watch a live session     | passing | [live-stream.md](live-stream.md)             |
| Reset a session          | passing | [reset.md](reset.md)                         |
| Compact on demand        | passing | [compact.md](compact.md)                     |
| Fold a released session  | passing | [fold.md](fold.md)                           |
| Cross-process streaming  | passing | [fold.md](fold.md) (`follow.sh`)             |
| A long session's history | passing | [history.md](history.md)                     |
| Fork a session           | passing | [fork.md](fork.md)                           |
| Replay a session         | passing | [replay.md](replay.md)                       |
| Request limits           | passing | [limits.md](limits.md)                       |
| Probes and readiness     | passing | [probes.md](probes.md)                       |
| Shutdown and recovery    | passing | [lifecycle.md](lifecycle.md)                 |
| Errors over the wire     | passing | [errors.md](errors.md)                       |
| One PR across a kill     | passing | [pr-once.md](pr-once.md)                     |
| Inbound triggers         | passing | [trigger.md](trigger.md)                     |
| Jira adapter             | passing | [jira.md](jira.md)                           |
| GitHub issues adapter    | passing | [github.md](github.md)                       |
| Slack adapter            | passing | [slack.md](slack.md)                         |
| Linear adapter           | passing | [linear.md](linear.md)                       |
| Sentry receiver          | passing | [sentry.md](sentry.md)                       |
| Sentry link-back         | passing | [sentry.md](sentry.md)                       |
| Linear write-back        | passing | [linear-writeback.md](linear-writeback.md)   |
| Approvals                | passing | [approvals.md](approvals.md)                 |
| Curate a session's pages | passing | [curate.md](curate.md)                       |
| A mission                | passing | [mission.md](mission.md)                     |
| A docs run               | passing | [docs-run.md](docs-run.md)                   |
| A docs run on a trigger  | passing | [docs-trigger.md](docs-trigger.md)           |
| The `verify` tool        | passing | [verify-tool.md](verify-tool.md)             |
| PR evidence block        | passing | [pr-evidence.md](pr-evidence.md)             |
| The spec document        | passing | [spec.md](spec.md)                           |
| A budget cap             | passing | [budget.md](budget.md)                       |
| The PR step over RPC     | passing | [pr-rpc.md](pr-rpc.md)                       |
| The pages surface        | passing | [pages.md](pages.md)                         |
| Propose child issues     | passing | [decompose.md](decompose.md)                 |
| Approve proposals        | passing | [approve-proposals.md](approve-proposals.md) |
| The model backend        | passing | [model-backend.md](model-backend.md)         |
| What the server runs     | passing | [server-info.md](server-info.md)             |
| Metrics to a collector   | passing | [metrics.md](metrics.md)                     |
| Control-plane identity   | passing | [identity.md](identity.md)                   |
| Cost prediction          | passing | [cost.md](cost.md)                           |

The model-backend checks (LOB-258) were run from the `agent/LOB-258` worktree on 2026-10-28
(`BACKEND_BOOT_PORT=9542`, the worktree's own database on 5442, no repo-root `.env`):
`./backend-boot.sh` **18/18** (faux by `MODEL_BACKEND`, a forced anthropic refused with no
credential and with a federation token file that does not exist, a dummy OAuth token, a dummy
bearer token through turbo), evidence `.verify/evidence/lob-258/api/`.
With `ANTHROPIC_AUTH_TOKEN` dropped from `apps/api/turbo.json`'s `passThroughEnv`, the turbo boot's
`auth token passed through` check fails (`.verify/evidence/lob-258/mutation-no-passthrough/`). See [model-backend.md](model-backend.md).

The server-info checks (LOB-269) were run from the `agent/LOB-269` worktree on 2026-10-28
(`API_PORT=9620`, the worktree's own database on 5442): `./server-info.sh` **17/17**
(`getServerInfo` under faux with a role table, the raw body and the log free of three dummy
credentials, and `faux/faux-1` on a session's create, get and list row), evidence
`.verify/evidence/latest/api/server-info.json`. With the owner open's write of `sessions.model`
removed, the list-row check fails (`.verify/evidence/lob-269/mutation-no-model-write/`). See
[server-info.md](server-info.md).

The metrics checks (LOB-69) were run from the `agent/LOB-69` worktree on 2026-10-28
(`API_PORT=9540`, `OTLP_RECEIVER_PORT=9541`, the worktree's own database on 5442, `MOTEL_URL` unset):
`./metrics.sh` **10/10** (9 driver checks — the drive, the wire, and each metric of the documented set
with its unit, read from a loopback OTLP/HTTP receiver — and the boot log naming the endpoint),
evidence `.verify/evidence/lob-69/api/`. With the endpoint left out of the boot, the receiver is sent
nothing and the set check fails (`.verify/evidence/lob-69/mutation-no-endpoint/`). See
[metrics.md](metrics.md).

The identity checks (LOB-20) were run from the `agent/LOB-20` worktree on 2026-10-28
(`API_PORT=9520`, the worktree's own database on 5442): `./identity.sh` **15/15** plus the shell's
two (unauthenticated `listSessions` and `watchSession` refused with `missing` and `invalid`; amy's
`createSession`, `decideApproval`, `createTask`, `moveTask` and the CLI's `board move` all recorded
`amy` over a body naming `mallory`; `listSpend` by the authenticated actors; a signed delivery with no
credential accepted as `trigger:generic`), evidence `.verify/evidence/latest/api/identity.json`. With
the `createSession` handler passing the body through, or the middleware serving every call as auth
off, `apps/api/src/Rpc/Auth.test.ts` fails (2 and 7 cases). See [identity.md](identity.md).

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
- **Isolation, sandboxes.** Nothing in this surface touches a cluster; sessions run in a
  directory under `SESSION_ROOT` — a linked git worktree when the repo is registered with a
  checkout, which `./sigterm.sh` registers (LOB-268), and a scratch directory otherwise.
