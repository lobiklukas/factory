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

The Slack adapter checks (LOB-191) were run from the `ralph/LOB-191` worktree on 2026-10-24
(`DATABASE_URL` the worker's own database on 5442, faux, the loopback Slack fake on `:9410`):
`./slack.sh` **18/18**, evidence `.verify/evidence/lob-191/`. They run no API instance — the driver
builds the seam, the session layer and the adapter in-process, as `./jira.sh` and
`./github-issues.sh` do — so `./up.sh`, `./sigterm.sh` and `./degraded.sh` were not part of it.

The GitHub issues adapter checks (LOB-190) were run from the `ralph/LOB-190` worktree on 2026-10-24
(faux, Postgres on 5442): **19/19** via `./github-issues.sh`, evidence
`.verify/evidence/lob-190/`. Like `./jira.sh` it starts no API process: the driver builds the seam
and the fake listens on the port the run reserves for this surface.

The docs-run checks (LOB-228) were run from the `ralph/LOB-228` worktree on 2026-10-25
(`DATABASE_URL` the worker's own `factory_ralph` on 5442, faux, the loopback GitHub fake on `:9410`):
`./docs-run.sh` **13/13**, evidence `.verify/evidence/lob-228/`. Like `./pr-once.sh` it starts no API
process — the driver builds the service in-process — so `./up.sh`, `./sigterm.sh` and `./degraded.sh`
were not part of it.

The curation checks (LOB-206) were run from the `ralph/LOB-206` worktree on 2026-10-24 (API on
`:9410`, faux, Postgres on 5442, `DATABASE_URL=…/factory_ralph_2`): `bun drive.ts` **47/47** with
the curation block added, evidence `.verify/evidence/lob-206/verify-api/`. `./sigterm.sh` and
`./degraded.sh` were not re-run there; neither touches the curation path.

The mission checks (LOB-230) were run from the `ralph/LOB-230` worktree on 2026-10-24 (API on `:9400`,
faux, Postgres on 5442, `DATABASE_URL=…/factory_ralph`): `bun drive.ts` with the mission block added,
evidence `.verify/evidence/lob-230/verify-api/`. `./sigterm.sh` and `./degraded.sh` were not re-run
there; neither touches the mission path. See `mission.md`, which names what the case does not prove
(resume across a kill — LOB-231).

| Feature                  | Status  | File                               |
| ------------------------ | ------- | ---------------------------------- |
| Create a session         | passing | [create.md](create.md)             |
| Repo binding             | passing | [repo-binding.md](repo-binding.md) |
| Session list             | passing | [session-list.md](session-list.md) |
| Watch a live session     | passing | [live-stream.md](live-stream.md)   |
| Reset a session          | passing | [reset.md](reset.md)               |
| Compact on demand        | passing | [compact.md](compact.md)           |
| Fold a released session  | passing | [fold.md](fold.md)                 |
| Fork a session           | passing | [fork.md](fork.md)                 |
| Request limits           | passing | [limits.md](limits.md)             |
| Probes and readiness     | passing | [probes.md](probes.md)             |
| Shutdown and recovery    | passing | [lifecycle.md](lifecycle.md)       |
| Errors over the wire     | passing | [errors.md](errors.md)             |
| One PR across a kill     | passing | [pr-once.md](pr-once.md)           |
| Inbound triggers         | passing | [trigger.md](trigger.md)           |
| Jira adapter             | passing | [jira.md](jira.md)                 |
| GitHub issues adapter    | passing | [github.md](github.md)             |
| Slack adapter            | passing | [slack.md](slack.md)               |
| Approvals                | passing | [approvals.md](approvals.md)       |
| Curate a session's pages | passing | [curate.md](curate.md)             |
| A mission                | passing | [mission.md](mission.md)           |
| A docs run               | passing | [docs-run.md](docs-run.md)         |

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
