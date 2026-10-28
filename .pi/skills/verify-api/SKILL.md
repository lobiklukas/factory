---
name: verify-api
description: Drive and prove the factory session API (apps/api + packages/core) with the real Effect RPC client. Use when asked to verify, test, or show evidence that sessions, session streaming, or the RPC surface work, or after changing packages/domain, packages/core, apps/api, or packages/harness.
---

# Verify the session API

Proves the session surface by driving it with **the same Effect RPC client a CLI or the dashboard
uses**. `curl` proves a route is mounted and nothing else: it cannot tell you that a stream lost its
last event, that a tagged error crossed the wire, or that both ends agree on a schema. Unit tests
in `packages/core` cover policy; this skill covers the contract over HTTP.

The driver is a client, not a browser. The browser path is `.pi/skills/verify-web`.

## What it proves

| Feature                                 | Check in the driver                                                                                                                                                                                                                                                                                                         | Why it matters                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Create a session (D7)                   | `createSession`, and a retried `requestId`                                                                                                                                                                                                                                                                                  | one log per session; retries must not leak logs                                    |
| Repo binding (A1)                       | `registerRepo`, then `repo`/`baseRef`/`workspace`                                                                                                                                                                                                                                                                           | a session names the repo it works on                                               |
| Repo registry (LOB-253)                 | `listRepos`/`getRepo` answer the row with its checkout facts; unknown → `RepoNotFound`; a non-git path refused                                                                                                                                                                                                              | a picker reads it; a bad checkout is never stored                                  |
| No local checkout (LOB-263)             | `drive.ts`: a session on a path-less repo opens with `workspace.warning` naming `factory repo add … --path`; a checked-out repo and a scratch session carry none; `createBoard`/`getBoard` carry it until a path is registered. `no-checkout.sh`: the boot log names each `TRIGGER_RULES` label and repo without a checkout | a run that cannot produce a diff says so when it is bound, not three columns later |
| Session list (A2)                       | `listSessions` sees the new session, paged                                                                                                                                                                                                                                                                                  | the list is a server read, not a client guess                                      |
| Send a message                          | `sendMessage` → `placement: run`, title set                                                                                                                                                                                                                                                                                 | a message admits durably and names the session                                     |
| Watch a live session (D8)               | snapshot first, then entries, then run state                                                                                                                                                                                                                                                                                | the UI's live path, including `busy → idle`                                        |
| Read the transcript                     | `getSession` → the `bash` tool result                                                                                                                                                                                                                                                                                       | the run really happened, usage is attributed                                       |
| Fold a released session (D8)            | the same session reads `historical`, same entries                                                                                                                                                                                                                                                                           | a paused session is served by folding the log                                      |
| Fork a session (LOB-180)                | `forkSession` → the parent's prefix, then a fork-only message                                                                                                                                                                                                                                                               | a fork is its own log, not a rewrite of the parent                                 |
| Replay a session (LOB-215)              | `replaySession` onto `faux/faux-2` → the source's first prompt, each usage keyed by its own model, the source unchanged, the link in the replay's log, the comparison on both (LOB-199); refusals typed                                                                                                                     | a replay is the same task on another model                                         |
| A fold's stream ends                    | exactly one `snapshot` event                                                                                                                                                                                                                                                                                                | complete is distinguishable from dropped                                           |
| Request limits (LOB-21)                 | an oversized message → `invalid_input`                                                                                                                                                                                                                                                                                      | a refusal is typed, not a truncation or a crash                                    |
| Transport cap (LOB-21)                  | a 2 MiB body → 413, and `/livez` still answers                                                                                                                                                                                                                                                                              | the configured cap, not Bun's 128 MiB default                                      |
| Probes (LOB-21)                         | `/livez` 200; `/readyz` 200 naming every check                                                                                                                                                                                                                                                                              | liveness is cheap; readiness is a live answer                                      |
| Degraded readiness (LOB-21)             | Postgres down → `/livez` 200, `/readyz` 503, typed `storage` error; back → 200, same pid                                                                                                                                                                                                                                    | an outage is not a crash loop                                                      |
| SIGTERM mid-run (LOB-21)                | the owners are released, and the interrupted session folds and continues; its branch and worktree keep the commit and the edit, and a discard is what removes them (LOB-268)                                                                                                                                                | a killed run is resumable, not lost                                                |
| One PR across a kill (LOB-179)          | `pr-once.sh`: the step dies inside its GitHub call, the replay adopts the PR, one PR entry                                                                                                                                                                                                                                  | a lost acknowledgement is not a second PR                                          |
| Typed errors over the wire              | unknown id → `SessionError{code: "not_found"}`                                                                                                                                                                                                                                                                              | callers can branch on `code`, not on text                                          |
| Interrupt wakes, then stops             | `interruptSession` → idle                                                                                                                                                                                                                                                                                                   | steering wakes a session before acting on it                                       |
| Reset a session (LOB-181)               | `resetSession` with and without a handoff: the past, then the `reset` entry                                                                                                                                                                                                                                                 | a new context is a marker, not a truncation                                        |
| Compact on demand (LOB-185)             | `compactSession` → a task id, then the summary entry, nothing dropped from the transcript                                                                                                                                                                                                                                   | long sessions summarize on demand, not by luck                                     |
| Approvals (LOB-50)                      | `requestApproval` → pending, a retry is one row, survives the fold → `decideApproval` empties it                                                                                                                                                                                                                            | a gated action waits for a person, durably                                         |
| An approval across a kill (LOB-52)      | `approval-restart.sh`: a gated call parks idle on one approval, SIGKILL, a fresh process folds it pending, a retry re-asks nothing, approved it runs once, and the next run asks again                                                                                                                                      | an ask survives the process, and is asked once                                     |
| A mission (LOB-230)                     | `startMission` → an id, then `getSession().mission` reports `verify` with `entered`, live and folded                                                                                                                                                                                                                        | a mission's phase is the session's state, not a call                               |
| A mission's fan-out (LOB-193)           | two `workers` live, owned, two conversations, `waiting` failFast; a failing worker stops its sibling's running check; a check outside the policy is refused                                                                                                                                                                 | a failing subtask stops its siblings, per policy                                   |
| A mission across a kill (LOB-231)       | `mission-restart.sh`: SIGTERM while the checkpoint is `implement` and both workers are on a tool call; a fresh process resumes it at boot, unasked, in `implement`, and the same workers finish                                                                                                                             | a mission resumes in the phase it died in                                          |
| A run across a kill (LOB-25)            | `run-restart.sh`: SIGKILL (or `KILL_SIGNAL=TERM`) while a run is on a tool call; a fresh process resumes it at boot, unasked: the same submission, the call settled as interrupted, an answer, a retry that submits nothing                                                                                                 | a run continues after its process dies                                             |
| Per-worker cost (LOB-194)               | `mission-cost.sh`: two workers report two separate costs (two requests each) whose sum is the session's total and the list's `costTotal`; the same breakdown from the fold and from a restarted API; a mission with no workers reports none                                                                                 | a finished mission says what each worker spent                                     |
| A docs trigger (LOB-197)                | `docs-trigger.sh`: a push starts one docs session on `factory/doc-<id>`, the schedule one per interval, the ledger no write to main                                                                                                                                                                                         | a docs run starts without a person, off the trunk                                  |
| Docs trigger callers (LOB-234)          | `docs-trigger-http.sh`: `DOCS_SCHEDULE_MS=400` ticks sessions, unset none; a signed push processed, a redelivery replayed, another branch 400, a bad signature 401                                                                                                                                                          | a deployment starts docs runs with no script                                       |
| The `verify` tool (LOB-78)              | `verify-tool.sh`: exit 0 with output, exit 3 with the tail, no evidence for a skill-less surface, the declared command first                                                                                                                                                                                                | a run's verification is a record, not prose                                        |
| PR evidence (LOB-79)                    | `pr-evidence.sh`: the body names the skill, its exit code and a bounded excerpt; a truncation is marked; no evidence is said                                                                                                                                                                                                | the PR states what was verified, from the record                                   |
| A Linear issue (LOB-164)                | `linear.sh`: a labeled issue opens one session on its rule's repo, the issue as its prompt; a retry, an edit open none; a stored route added over RPC routes the next delivery, a card route files one card in intake and no session (LOB-254), the boot log names rules and armed routes                                   | work arrives from Linear exactly once                                              |
| Sentry alerts (LOB-81, LOB-82)          | `sentry.sh`: one session per alert and per open Sentry issue, titled with environment and release; a filtered level, environment or release a skip naming the field; a blank prompt gets the default; 401s logged without the payload; a 429 burst; a restart keeps both                                                    | an alert opens work once, across a restart, and no faster than the cap             |
| Linear write-back (LOB-15)              | `linear-writeback.sh`: started → In Progress, the PR attached and commented → In Review, a no-change run explained, merge → Done; a card's run's PR reaches the issue it was filed from (LOB-254)                                                                                                                           | the loop closes in Linear, once per event                                          |
| The spec document (LOB-72)              | `spec.sh`: `gaps` absent is refused naming the field, `gaps: []` commits, a second process reads it back                                                                                                                                                                                                                    | the specifier's gaps are declared, not implied                                     |
| A budget cap (LOB-163)                  | `budget.sh`: a one-cent cap stops the run after its tool and before the reply, the stop on the stream, the snapshot, the log and `factory run`; a later run stops at once                                                                                                                                                   | a capped session cannot spend past its limit                                       |
| The PR step over RPC (LOB-213)          | `pr-rpc.sh`: `openPullRequest` over the RPC client answers `opened`, a repeat `already-open`, the link read back, one request in the fake's ledger; refusals typed                                                                                                                                                          | a client opens the PR, not only an in-process caller                               |
| The pages surface (LOB-220)             | `pages.sh`: `curateSession` writes one page, `listPages` reads it, a repeat writes none for exactly one call's price; deleted rows come back from the log                                                                                                                                                                   | a page is a log fact, and learning nothing is cheap                                |
| The review agent (LOB-36)               | `review.sh`: a signed `pull_request` starts a read-only reviewer at the head, on its own model; one `COMMENT` naming the bug, as its own token; a redelivery none; a push a second                                                                                                                                          | a PR is reviewed once per head, not as its author                                  |
| A long session's history (LOB-243)      | `history.sh`: released, `getSession` carries the newest 200 entries and `earlier`; `readSessionHistory` pages back to the first entry, joined they are the transcript; `factory watch` says what it did not print; `factory history --all` prints it                                                                        | a historical read costs what it shows, and the rest is one call away               |
| Proposed child issues (LOB-201)         | `decompose.sh`: a specifier's spec → `proposeDecomposition` commits one proposal per criterion, `getSession` reads them back, a rerun of the same spec reconciles into them (LOB-203), and no other row in the database moves                                                                                               | a spec becomes proposals, and nothing else is made                                 |
| Approving proposals (LOB-202)           | `approve-proposals.sh`: `approveProposals` creates only the approved proposals in a loopback Linear, under the delegating issue and in its team, with the edges whose ends exist, and nothing twice — a rerun of the same spec included (LOB-203)                                                                           | approved proposals become tracker issues, once                                     |
| The model backend (LOB-258)             | `backend-boot.sh`: faux by `MODEL_BACKEND`; forced anthropic with no credential or no federation token file exits non-zero, naming why; a dummy token boots anthropic, value unlogged                                                                                                                                       | a wrong backend fails the boot, not the first request                              |
| What the server runs (LOB-269)          | `server-info.sh`: `getServerInfo` answers faux by `MODEL_BACKEND`, `faux/faux-1`, the `ROLE_MODELS` rows, gate, budget and armed routes; no dummy credential in the raw body or the log; a session names `faux/faux-1` on create, get and list                                                                              | a client can ask which backend and model it is on                                  |
| Control-plane identity (LOB-20)         | `identity.sh`: no credential or a wrong one is `Unauthenticated` for `listSessions` and the `watchSession` stream; amy's create, decide, card create and move, and the CLI's move record `amy` over a body's `mallory`; `listSpend` by those; a signed delivery needs no credential                                         | the actor is the one the control plane authenticated                               |
| Jira, Slack and GitHub issues (LOB-259) | `jira.sh`, `slack.sh`, `github-issues.sh`: signed deliveries at `/webhooks/jira`, `/webhooks/slack` and the issue events of `/webhooks/github` open one session and one comment; an unset secret answers 503                                                                                                                | three more sources arrive over HTTP, each armed by its own secret                  |
|                                         |                                                                                                                                                                                                                                                                                                                             |                                                                                    |     |     |     | 579ff10 |

Every check is required: the driver exits non-zero when one fails.

**With auth on (LOB-20).** Export `FACTORY_API_TOKEN` (16+ characters) before a script and the API it
boots requires it on every RPC; every driver's client (`harness.ts`'s `protocolFor`, and its
`authHeaders()` for a raw `fetch`) and the CLI send the same variable, and the checks that read an
approval's actor expect the token's (`recordedActor`: `FACTORY_API_ACTOR`, `operator` by default).
Unset, the API runs with auth off and every driver behaves as before; every script binds
`HOST=127.0.0.1`, the only kind of address an open control plane boots on without
`FACTORY_API_AUTH=off`.

## Launch

Run on an isolated port so it never competes with a dev server, and with the faux model backend so
the run is offline, deterministic, and free.

```sh
./up.sh          # api on :9200, pid in .verify/run/, model backend faux
./down.sh        # stops only what up.sh started
```

`up.sh` needs Postgres on host port 5442; the session log _is_ Postgres, so without it there is
nothing worth driving. It does not start one blindly: the shared `.pi/skills/lib/postgres.sh` asks
the port first and runs `docker compose up -d --wait postgres` only when nothing answers — compose
names its project after the directory it runs in, so a ralph worktree asking for 5442 a second time
while another project's container holds it is a hard failure (LOB-57). With no database and no way
to start one, `up.sh` exits non-zero and prints the command to run. It waits for **`/readyz`**, not
`GET /`: the server binds before its migrations are applied (LOB-21), so `/` answers a moment before
a session can be created. It fails loudly with the log path (`.verify/run/api.log`).

Four settings in `up.sh` exist for the sake of proof, not for production:

- `MODEL_BACKEND=faux` — pi-ai's scripted provider. The session runs a real `bash` tool call and the
  answer is derived from that tool's output, so the tool path is real; the _model_ is not. A drive
  run must never depend on a key, a network, or a model's mood.
- `SESSION_IDLE_TIMEOUT_MS=2000` — so a drive run can reach the historical-fold read path. At the
  deployment default (15 minutes) you would wait 15 minutes to prove D8's other half.
- `MAX_REQUEST_BODY_BYTES=1048576` — the transport cap `drive.ts` proves by sending 2 MiB. The
  default is the same 1 MiB; setting it here ties the check to a value this script owns.
- `ROLE_MODELS=replay-target=$REPLAY_MODEL` (`faux/faux-2` when unset) — a second faux model for
  the replay check (LOB-215). The role table is the only lever that publishes a `faux/<id>` beside
  `faux/faux-1`, and no session on this instance runs the `replay-target` role, so the row changes
  the catalog and nothing else. It is appended to a `ROLE_MODELS` the caller set, not replacing it,
  and `REPLAY_MODEL` is the variable `drive.ts` reads too, so one override reaches both.

### Lifecycle and degradation — their own scripts

Two LOB-21 claims cannot be driven against the instance `up.sh` owns, because each one kills it or
takes the database away. Each script owns its own API instance on its own port, leaves nothing
running, and writes its own evidence:

```sh
./sigterm.sh     # api on :9400 (SIGTERM_PORT) — a busy session with a commit, SIGTERM, a fresh process resumes it on the same branch
./approval-restart.sh  # api on :9416 — a gated call parks on an approval, SIGKILL, a fresh process re-asks nothing
./mission-cost.sh     # api on :9430 (MISSION_COST_PORT), a priced faux — two workers' costs add up to the session's, live, folded and after a restart (features/mission.md)
./mission-restart.sh  # api on :9418 (MISSION_RESTART_PORT or API_PORT), its own database minted on DATABASE_URL's server — SIGTERM mid-implement, a fresh process resumes the mission at boot (features/mission.md)
./run-restart.sh      # api on :9430 (RUN_RESTART_PORT or API_PORT), its own database minted on DATABASE_URL's server — SIGKILL mid-run (KILL_SIGNAL=TERM for the graceful path), a fresh process resumes the run at boot (features/lifecycle.md)
./degraded.sh    # api on :9500 — Postgres stopped: /livez 200, /readyz 503, typed errors; then back
./pr-once.sh     # fake GitHub on :9411 — SIGKILL between the PR call and its acknowledgement
./webhook.sh     # api on :9400 — signed trigger deliveries: one session, replays, skips, 401, 413, a stale claim reclaimed, 503 in-flight, a generic `push` refused
API_VIA_TURBO=1 ./webhook.sh  # the same drive with the API started the way `bun run dev` starts it (turbo, Strict Mode): TRIGGER_SECRET and the other webhook variables must be declared in apps/api/turbo.json or every route is 503 (LOB-257)
./jira.sh        # api on :9424, fake Jira on :9412 — POST /webhooks/jira: one session, one comment, the retry, 401s, 503 unconfigured (features/jira.md)
./github-issues.sh  # api on :9426, fake GitHub on :9413 — issues and @factory comments on POST /webhooks/github: one session, one comment (features/github.md)
DATABASE_URL=… ./backend-boot.sh  # api on :9426 (BACKEND_BOOT_PORT), booted five times — the model backend from pi-ai's auth modes; a forced anthropic that cannot authenticate refused (features/model-backend.md)
./slack.sh       # api on :9425, fake Slack on :9414, fake GitHub on :9427 — POST /webhooks/slack: the handshake, one session, one threaded reply, the PR link in the thread (features/slack.md)
./linear.sh      # api on :9415 — Linear issue webhooks: one session per labeled issue, skips named
./sentry.sh      # api on :9423, booted twice — Sentry alerts: one session per issue, filter skips, default prompt, 401s, 429 burst, a restart (features/sentry.md)
./linear-writeback.sh  # fake Linear on :9416, fake GitHub on :9417 — the issue's states, PR and failure comments
./docs-trigger.sh  # fake GitHub on :9410 — a push and a schedule start docs runs on factory/doc-<id>
./docs-trigger-http.sh  # api on :9422, booted twice — the schedule daemon and the signed GitHub push route (features/docs-trigger.md)
./verify-tool.sh # no port — the `verify` tool over five fixture repos (features/verify-tool.md)
./pr-evidence.sh # fake GitHub on :9411 — the PR body's evidence block from the run's record (features/pr-evidence.md)
./spec.sh        # no port — the spec document: refused without gaps, committed with [], read by a second process
./budget.sh      # api on :9419 — a priced faux: a capped run stops at its limit and says so (features/budget.md)
./pr-rpc.sh      # api on :9420, fake GitHub on :9421 — openPullRequest over RPC: opened, then already-open, one request (features/pr-rpc.md)
./pages.sh       # api on :9422, a priced faux — curate, list, repeat for one call, delete the rows and rebuild them (features/pages.md)
./review.sh      # api on :9200, fake GitHub on :9201 — a pull_request starts the reviewer; one comment as its own identity (features/review.md)
./decompose.sh   # api on :9424, a faux specifier — a spec becomes proposed child issues, and nothing else is written (features/decompose.md)
DATABASE_URL=… ./server-info.sh  # api on :9200 (API_PORT), via up.sh — getServerInfo and each session's model; no credential's value in the answer (features/server-info.md)
DATABASE_URL=… ./identity.sh     # api on :9200 (API_PORT), via up.sh with a token table — unauthenticated calls refused, every write records the credential's actor (features/identity.md)
./approve-proposals.sh   # api on :9428, loopback Linear on :9429 — approved proposals become child issues, once (features/approve-proposals.md)
DATABASE_URL=… ./metrics.sh  # api on :9200 (API_PORT), OTLP receiver on API_PORT+1 (OTLP_RECEIVER_PORT) — the documented metric set reaches a loopback collector, never motel (features/metrics.md)
```

`pr-once.sh` is the third of those, and it starts no API process: the window it proves is a kill
inside the step's GitHub call, so each driver process builds the real `SessionService` itself,
against the run's `DATABASE_URL` and its own session root, and is the process killed. The step's RPC
member (`openPullRequest`, LOB-213) is driven separately by `pr-rpc.sh`, which starts an API with
`GITHUB_API_URL` pointing at its own fake. Its HTTP endpoint is the fake GitHub, which listens on the
run's `API_PORT` (9411 when unset; `PR_ONCE_PORT` overrides it for a second concurrent run) — the
port the run reserves for this surface, spent on the only server the script needs. The PR client
reaches it through `GITHUB_API_URL` (the key the App token flow already reads), so nothing here can
reach `github.com`. Three processes run in sequence: one is killed with `SIGKILL`
while the fake holds its create request open (the acknowledgement was never committed), one replays
the step and must land on the PR GitHub already has, and one is a genuinely second session, which
must open a second PR. The ledger is a file precisely so that it outlives the process that was
killed. That the checks are not vacuous is a hand mutation run recorded in
`.verify/evidence/lob-179/`: with the recorded-document read removed from `prStep.ts`, the replay's
repeat posts again and the script exits non-zero. See `features/pr-once.md`.

The diff cap (LOB-227) is deliberately not driven here: this script's sessions are bound to a bare
slug, so they have no checkout whose branch could be measured, and the drive would have to cut a
git worktree to exercise the cap at all. It is proved in `packages/core`'s suite instead, and
`features/pr-once.md` records why and where.

`degraded.sh` stops the container that publishes 5442 — by the name `docker ps --filter publish=5442`
reports, because the compose project owning the port is not necessarily the one this directory would
name (LOB-57) — and **always** starts it again (a trap, so a failure half way through cannot leave
the database down). It refuses before it stops anything when the port answers but no container
publishes it. Run it when nothing else in the repo needs the database; `PG_PORT` selects the port it
looks at, and `DATABASE_URL` must name the same database — the API it starts reads `DATABASE_URL`,
which is how it can be run against a database of its own.

## Doctor

```sh
./doctor.sh      # read-only; exits non-zero when the instance is not worth driving
```

Checks the recorded pid is alive, that the port is owned by _that_ pid, and that the API answers.
Run it whenever anything looks off — do not trust a drive run against an instance that fails it.

## Drive

```sh
bun drive.ts     # requires the instance from ./up.sh
```

Environment: `API_URL` (default `http://localhost:9200`), `EVIDENCE_DIR`, `DATABASE_URL` (the
database the API writes — the replay check reads the replay's log there through a reader-mode
storage, because no RPC answers the link it records; required, and never defaulted, so a drive
cannot read the shared `factory` database; no migrator runs from the drive) and `REPLAY_MODEL`
(default `faux/faux-2`; `up.sh` reads the same variable, so set it for both). The last line it prints
is the run count, `N/N checks passed`.

The driver runs in two phases and needs no restart in between: it drives a session while the API
owns it, then waits (read-free — a read counts as use and keeps the owner open) for the idle sweep
to release the owner, and reads the same session again as a fold. That is D8's live/historical pair
proven on one session id.

## Evidence

Written to `.verify/evidence/latest/` relative to the current working directory (so running `bun drive.ts` from `.pi/skills/verify-api` lands in `.pi/skills/verify-api/.verify/evidence/latest/`). Override with `EVIDENCE_DIR` (e.g. `EVIDENCE_DIR=/path/to/repo/.verify/evidence/latest bun drive.ts`), gitignored. Note that
`.pi/skills/verify-web` writes to the same directory: the last drive run wins, so run them in the
order you want the evidence to end in.

- `observed.json` — every check with its detail, the stream's event log, the transcript, the session
  id, the API URL, and the probe bodies
- `session.txt` — the transcript as text, for reading
- `sigterm-arm.json` / `sigterm-verify.json` — from `./sigterm.sh`: the arm phase (a run genuinely in
  flight) and the verify phase (the same session folded and continued), each with its transcript as
  text (`sigterm-arm-transcript.txt`, `sigterm-verify-transcript.txt`)
- `sigterm-process.json`, `sigterm-api.log` — what the process did: the exit, the shutdown log lines,
  and the pid that served the phase
- `mission-restart-arm.json` / `mission-restart-verify.json` — from `./mission-restart.sh`: the
  mission's task, its workers and its document before the signal (implement, both workers on a tool
  call) and after the restart (resumed by the boot, then settled in verify)
- `mission-cost-run.json` / `mission-cost-reopen.json`, `mission-cost-process.json`, `mission-cost-api.log` —
  from `./mission-cost.sh`: the breakdown the driver read live, folded and after the API restarted, with
  its checks, and the script's own
- `mission-restart-process.json`, `mission-restart-api.log` — what the process did: the exit, the
  shutdown and boot-resume log lines, and the row the next boot reads, set while nothing ran
- `run-restart-arm.json` / `run-restart-verify.json` — from `./run-restart.sh`: the run on its tool
  call before the kill, and the same run resumed by the boot and settled, with its transcript
- `run-restart-process.json`, `run-restart-api.log` — what the process did: the signal and exit, no
  shutdown line under SIGKILL, the row the next boot reads, and the boot's resume lines
- `degraded-down.json`, `degraded-up.json`, `degraded-process.json`, `degraded-api.log` — from
  `./degraded.sh`: the probes with Postgres stopped and back, and the process facts (one pid served
  both phases)
- `pr-once-reopen.json`, `pr-once-second.json`, `pr-once-process.json`, `pr-once-ledger.json`,
  `pr-once-fake.log` — from `./pr-once.sh`: what each surviving process saw, the script's own checks,
  and the fake's ledger of every request and every PR that exists. There is no `pr-once-arm.json`:
  that phase is killed inside its call and writes nothing, which is the state it exists to reach
- `budget.json`, `budget-transcript.txt`, `budget-cli.txt`, `budget-process.json`, `budget-api.log`
  — from `./budget.sh`: the driver's checks with the stream's event log and each session's budget,
  the transcripts, what `factory run --budget` printed, the script's own checks, and the API log
- `pr-rpc.json`, `pr-rpc-ledger.json`, `pr-rpc-process.json`, `pr-rpc-api.log` — from `./pr-rpc.sh`:
  both answers and the refusals as the RPC client decoded them, the fake's ledger, the script's own
  checks, and the API log
- `pages.json`, `pages-process.json`, `pages-api.log` — from `./pages.sh`: each curation's answer,
  the pages at every step (curated, repeated, deleted, rebuilt), the spend after each call, the log's
  page-entry counts, the rebuild's report, and the script's own checks
- `decompose.json`, `decompose-process.json`, `decompose-api.log` — from `./decompose.sh`: the spec,
  the proposals, every table's fingerprint (row count and content `md5`) before and after the call,
  the log's new commits, and the script's own checks
- `approve-proposals.json`, `approve-proposals-process.json`, `approve-proposals-api.log`,
  `approve-proposals-linear-ledger.json`, `approve-proposals-linear-fake.log` — from
  `./approve-proposals.sh`: each approval's answer, the fake Linear's whole ledger (every request,
  the issues made, the relations), and the script's own checks
- `pr-evidence.json`, `pr-evidence-<scenario>.md`, `pr-evidence-ledger.json`, `pr-evidence.log` —
  from `./pr-evidence.sh`: each scenario's sent body, decoded records and committed evidence, the
  checks, and the fake's ledger

Proof standards for this app:

- **Drive the real client.** The driver imports `SessionRpc` from `packages/domain`, builds the same
  `RpcClient` the dashboard builds, and speaks the same NDJSON protocol. If a schema, a stream
  declaration, or an error type is wrong, this fails and curl would not.
- **Attach before you act.** The live-stream check subscribes _before_ `sendMessage`, so the first
  event is the state before the message and every later event is a genuine delta. Subscribing after
  the work is done proves nothing about streaming.
- **Name what proves it.** The faux answer is derived from the `bash` tool's output and echoes the
  prompt (`faux-ok (re: verify-api probe)`), so the transcript text can only exist if the tool really
  ran in this session.
- **Compare the two read paths.** The fold check compares the folded entries to the live ones it
  replaced. Two code paths, one session, and a mismatch is exactly the bug D8 is about.
- **A green unit test is not evidence for this surface.** `packages/core`'s suite calls the service
  in-process. It cannot see a lost stream event or a schema mismatch across the wire.

## Cleanup

```sh
./down.sh        # kills only the recorded pid; removes .verify/run/api.pid and .verify/run/sessions/, leaves .verify/run/api.log
```

Never kill by process name. Cleanup does not touch `.verify/evidence/` and does not delete session
logs from Postgres — the session rows and commits are append-only history, and re-running the drive
just mints new ids.

## Gotchas

- **The RPC stream's error channel is its own thing.** `watchSession` is declared `stream: true`, so
  its failures arrive as stream errors, not connection errors. A client that ignores the stream's
  error channel sees a truncated transcript and no reason.
- **`sendMessage` returns before the answer exists.** It admits the message durably (that is the
  point) and the answer arrives on the stream. Waiting for the answer means watching the stream or
  polling `getSession` until `live.busy` is false.
- **Idle owners are released, not paged out.** A session owned by this process streams from memory;
  once released, the next read folds the log. If a check expects `mode: "live"` and gets
  `"historical"`, something touched the idle timeout — check `SESSION_IDLE_TIMEOUT_MS`.
- **Two owners of one log is a footgun, not a race.** Pi Durable allows one owner per log, and a
  second owner's append collides and poisons that instance. The controller is `SessionService`'s
  acquisition gate; do not open a `PostgresStorage` in owner mode yourself while the API is running.
- **The CLI is proven elsewhere.** `apps/cli`'s `run`/`watch`/`ls` are driven in a real terminal by
  `.pi/skills/verify-cli`; this skill covers the contract they speak. A bug in one is often a bug in
  the other, so run both when the session surface changes.
- **5442 is a shared port, and compose is not the way to ask about it.** `docker compose up -d
--wait postgres` from a plain shell in a ralph worktree derives the project name `factory-ralph`
  (compose uses `COMPOSE_PROJECT_NAME` when it is set — `.pi/ralph/loop.sh` sets it for its sessions
  — and the directory name otherwise) and fights whatever already holds 5442: it fails with "port is
  already allocated" and leaves a `Created` container behind, while the database you need is up and
  healthy. Ask the port instead (that is
  what `ensure_postgres` does). It asks the port again after every compose attempt, whether that
  attempt reported success or failure (LOB-104, LOB-106): a start that leaves nothing answering is a
  loud failure here rather than a 30-second `/readyz` loop in `up.sh`, and a compose that failed only
  because another agent's start won the port is not a refusal — the port decides. The regressions are
  covered by
  `packages/storage-postgres/src/postgres-up.test.ts`, which drives every verify-* script (its
  `CALLERS` list) with a fake `docker` and a real listener, and by a `PG_PORT` pointing at nothing,
  which reproduces the failure path without touching 5442. `.pi/ralph/loop.sh` also sources the helper
  (its `ensure_db`) and is not guarded: its `docker_env` probes `docker info` directly, so it is out of
  that test's scope.

## Feature map

Start at `features/README.md`.
