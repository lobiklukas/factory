---
name: verify-cli
description: Drive and prove the factory CLI (`factory run` / `watch` / `history` / `ls` / `status` / `send` / `withdraw` / `approvals` / `approve` / `deny` / `repo` / `skill` / `discard` / `replay` / `fork` / `reset` / `compact` / `spend` / `pr` / `outcomes` in apps/cli; `pr` is proven by verify-board's build phase, `outcomes` by verify-api's `outcomes.sh`) in a real tmux terminal against a real control plane. Use when asked to verify, test, or show evidence that the CLI works, or after changing apps/cli, packages/domain, or apps/api.
---

# Verify the CLI

Proves the command line by running it the way a person does — in a tmux terminal, against a real
API over HTTP, reading back the text it printed and the exit code it returned. Calling the RPC
client from a test process proves the client and nothing about the command: argument parsing, when
the stream ends, what the transcript looks like on a terminal, and the code a script would branch
on all live outside the client.

Three surfaces exist in this repo. This skill covers the **CLI** (`apps/cli`). The API it talks to
is proven by `.pi/skills/verify-api`; the dashboard by `.pi/skills/verify-web`. All three start their
own instance of `apps/api` and record it in `.verify/run/api.pid`, so run them one at a time.

## What it proves

| Feature                                                                       | Check in the driver                                                                                                       | Why it matters                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `factory run` (D9)                                                            | creates, streams, and prints the answer, exit 0                                                                           | the whole write path in one command                                     |
| The run's session is named                                                    | `session ses_…` on stdout, and `workspace <path>`                                                                         | the server's own answer, not a client guess                             |
| The tool call is real                                                         | a `[tool:bash]` line carrying the faux tool's output                                                                      | the transcript can only exist if the tool ran                           |
| `factory ls` (LOB-6)                                                          | the new session is a row, with its title, exit 0                                                                          | the list is a server read, not a local registry                         |
| The model, in `run` and `ls` (LOB-272)                                        | `model faux/faux-1` and `warning: faux backend` in `run`; a MODEL column                                                  | a scripted answer is not mistaken for a real one                        |
| `factory status` (LOB-272)                                                    | `backend faux`, `selected-by MODEL_BACKEND`, the boot's `reason`, exit 0                                                  | the operator can ask which model backend is running and why             |
| The PR column (LOB-65)                                                        | a seeded PR's URL in its row; `-` for the run's row                                                                       | the operator sees the link without a browser                            |
| `factory watch`, live (D8)                                                    | `mode: live`, then the same answer                                                                                        | a session this process owns streams                                     |
| `factory watch`, historical                                                   | `mode: historical` after the idle sweep, same answer                                                                      | the fold path, and the label that tells them apart                      |
| Typed errors                                                                  | unknown id → `error: not_found`, non-zero exit                                                                            | a script can branch on `code`, not on prose                             |
| `factory withdraw` (LOB-166)                                                  | `./withdraw.sh`: a queued follow-up leaves the queue and the transcript                                                   | withdrawing is a write, not a hidden row                                |
| `--when-busy steer` (LOB-167)                                                 | `./steer.sh`: the steer joins the running run, which answers it once                                                      | a steer is not a follow-up with a different label                       |
| `--when-busy reject` (LOB-167)                                                | `./steer.sh`: `error: busy`, non-zero, nothing queued; idle → `run`                                                       | a script can refuse to queue behind a running run                       |
| `factory budget` (C23)                                                        | `verify-api/budget.sh`, `verify-board/budget.sh`: the cap is committed, the stop cleared, a later run goes on             | a run the cap stopped can be continued without a new session            |
| `factory interrupt` (C8)                                                      | `./interrupt.sh`: a busy run stops, no `faux-ok`; idle → `not running`, 0                                                 | an operator stops a run going wrong without killing the API             |
| `factory repo` (LOB-253)                                                      | `./repo.sh`, run by `drive.sh`: add, re-add, refusals, `ls`, `show`                                                       | an operator binds a checkout without writing code                       |
| `factory skill` (D7)                                                          | `./skill.sh`, run by `drive.sh`: `ls`, `show`, two puts, refusals                                                         | a skill is edited without a migration, as a new version                 |
| `factory approve` (LOB-53)                                                    | `./approve.sh`, run by `drive.sh`: a parked approval decided, resumed                                                     | the answer reaches the run, not only the row                            |
| `factory discard` (LOB-268)                                                   | `./discard.sh`: worktree and branch gone, repeat names the first release                                                  | the only way an operator ends a session's work                          |
| `factory fork` / `reset` / `compact` / `spend` (C15)                          | `./session.sh`: a fork's transcript, `--ids`, a reset marker, a summary, the totals                                       | the session controls the dashboard has, from a shell                    |
| `factory replay` (LOB-200)                                                    | `./replay.sh`: a replay on another model prints both models and the deltas                                                | an operator compares two models on the same task, in a shell            |
| `factory repo add --url`, `repo sync`, `doctor` (LOB-265)                     | `./clone.sh`: a URL-only repo cloned, a worktree of it, a typed failure                                                   | a repo with no checkout on this machine still gets worktrees            |
| `factory doctor` (E8)                                                         | `./preflight.sh`: faux warns and exits 1, `--allow-faux` 0, Postgres down fails                                           | a first-run operator is told what is missing and how to fix it          |
| `factory run --model`, `DEFAULT_MODEL` (LOB-274)                              | `./model.sh`: the `model` line, the requests' model, refusals, a refused boot                                             | an operator picks a model per task, a deployment its default            |
| `factory triggers ls` (T4)                                                    | `./triggers.sh`: rows, reason verbatim, `--status`/`--source`, cursor                                                     | an operator sees why a labelled issue started nothing                   |
| `factory mcp` (S-local-agent-handoff-mcp)                                     | `./mcp.sh`: an MCP client creates a card and reads its status; `claude mcp get` connects                                  | a local agent delegates and follows work without a terminal             |
| `factory handoff` (S-local-agent-handoff-mcp)                                 | `./mcp.sh`: the run starts on `factory/<id>` with the local diff committed; too big → no card                             | local work in progress moves to a factory session intact                |
| `factory history` (LOB-243)                                                   | not here: verify-api `./history.sh`, against a session grown past the window                                              | a terminal reads the whole of a long session, page by page              |
| `factory pr` (LOB-86)                                                         | not here: verify-board `./drive.sh`'s build phase, against a GitHub fake                                                  | the link is the forge's answer, never assumed                           |
| `factory board block\|unblock\|attention\|runs` (LOB-264)                     | not here: verify-board `./drive.sh`'s triage phase                                                                        | the card and its runs are the server's, never a local guess             |
| `factory board vocabulary` / `define` / `definition show --json` (F5, F7, F8) | not here: verify-board `./definitions.sh` (vocabulary against the RPC) and `./define.sh` (show --json round trip, author) | the file an author edits is the file `define` takes, and names its keys |
| `factory board add` (LOB-261)                                                 | not here: verify-board `./drive.sh`'s add phase (features/add.md)                                                         | the card is the server's row, read back, never a local guess            |
| `factory run --open-pr` (F17)                                                 | `./open-pr.sh`: the PR opens at the settle against a GitHub fake; none without the flag or a change                       | a person's session can opt in to "delegate, get a PR"                   |
| `factory show` (F19, F20)                                                     | `./repo-context.sh`: the `context` line (file read, size, skills, truncation); AGENTS.md wins over CLAUDE.md              | an operator reads what a run was told                                   |

Every check is required: `drive.sh` exits non-zero when one fails.

## Launch

```sh
./up.sh          # api on :9300, pid in .verify/run/, model backend faux
./doctor.sh      # read-only; exits non-zero when the instance is not worth driving
./down.sh        # stops only what up.sh started, plus the drive's tmux server
./withdraw.sh    # self-contained: its own API on :9310 (WITHDRAW_PORT) with a sleeping faux turn
./approve.sh     # self-contained: its own gated API on :9330 (APPROVE_PORT); drive.sh runs it last
./steer.sh       # self-contained: its own API on :9320 (STEER_PORT) with the sleeping faux script
./discard.sh     # self-contained: its own API on :9340 (DISCARD_PORT) and a checkout it registers
./replay.sh      # self-contained: its own API on :9360 (REPLAY_PORT), a checkout, and a second faux model
./session.sh     # self-contained: its own API on :9390 (SESSION_PORT), a checkout it registers, FAUX_COST
./clone.sh       # self-contained: its own API on :9350 (CLONE_PORT) and a loopback git forge on :9351
./open-pr.sh     # self-contained: its own API on :9392 (OPEN_PR_PORT) and a GitHub fake on :9393 (OPEN_PR_GITHUB_PORT)
./repo-context.sh # self-contained: its own API on :9394 (CONTEXT_PORT) and fixture checkouts
./repo.sh        # needs ./up.sh's instance (API_URL/API_PORT); drive.sh runs it before approve.sh
./skill.sh       # needs ./up.sh's instance (API_URL/API_PORT); drive.sh runs it after repo.sh
./preflight.sh   # self-contained: `factory doctor` against its own APIs on :9480 (DOCTOR_PORT), :9481, :9482
./model.sh       # self-contained: its own API on :9370 (MODEL_PORT) and a refused boot on :9371
./triggers.sh    # self-contained: its own API on :9395 (TRIGGERS_PORT) booted with a webhook secret and rules
./interrupt.sh   # self-contained: its own API on :9380 (INTERRUPT_PORT) with the sleeping faux script
```

`preflight.sh` is separate because doctor's answers depend on the deployment: it boots a faux API on a
scratch database, a second whose database is unreachable, and points the CLI at a port nothing
listens on, under `.verify/run/cli-doctor/`. See `features/doctor.md`.

`triggers.sh` is separate because the deliveries it reads need a signing secret and a label → repo rule, both
deployment settings: it boots its own API under `.verify/run/cli-triggers/`, posts signed generic webhooks
with `curl` (nothing leaves loopback) and reads them back with `factory triggers ls`. See `features/triggers.md`.

`model.sh` is separate because the models a server serves are deployment settings: it boots its own
API with `DEFAULT_MODEL=faux/faux-cheap` and `ROLE_MODELS=specifier=faux/faux-spec`, under
`.verify/run/cli-model/`, and a second one with a `DEFAULT_MODEL` outside the catalog, which must
refuse to boot. See `features/model.md`.

`repo.sh` needs no deployment setting, so it drives the instance `up.sh` started with a tmux server
of its own under `.verify/run/cli-repo/`. Its "not a git work tree" fixture is a temp directory, not
one under `.verify/`: a subdirectory of a checkout is inside that checkout's work tree and the
registry accepts it. See `features/repo.md`.

`approve.sh` is separate for the same kind of reason: an approval exists only once a gated call asks,
and the gate is a deployment setting (`APPROVAL_REQUIRED=sleep`, with the faux command the gated one
and `FAUX_EVERY_TURN=true`), so it boots its own API under `.verify/run/cli-approve/` rather than gate
the instance `up.sh` started. `drive.sh` calls it as its last block, so one drive covers both; set
`APPROVE_PORT` into your port block when you run the drive. See `features/approve.md`.

`withdraw.sh` is separate from `drive.sh` because a message only queues behind a run in flight: it
boots its own API with `FAUX_COMMAND="sleep 15 && echo faux-ok"` (`WITHDRAW_SLEEP_S`), its own
session root and tmux server under `.verify/run/cli-withdraw/`, and stops all of it on exit. See
`features/withdraw.md`.

`steer.sh` is separate for the same reason, and boots its API with the sleeping faux script instead
of a sleeping command: `FAUX_SLEEP_MS=8000` (`STEER_SLEEP_MS`) makes the model nap before each step
of a turn, so the steer and the refused reject both land before the tool round, whatever the tool
does. Its state is under `.verify/run/cli-steer/`. See `features/steer.md`.

`interrupt.sh` is separate for the same reason: an interrupt only lands while a run is in flight.
It boots its API with `FAUX_SLEEP_MS=15000` (`INTERRUPT_SLEEP_MS`), so `factory interrupt` lands in
the nap before `bash`, then runs it again on the idle session and on an unknown id, and sends a
follow-up. Its state is under `.verify/run/cli-interrupt/`. See `features/interrupt.md`.

`discard.sh` is separate because a discard removes a linked worktree and a branch, and the instance
`up.sh` started registers no checkout to cut one from: it creates a repository under
`.verify/run/cli-discard/checkout`, registers it over the RPC (no CLI verb registers a checkout yet),
and runs the session on it. See `features/discard.md`.

`replay.sh` is separate because a replay needs a repo-bound session with a checkout and a _second
model_ to run on, and under faux a model is a script: it boots its own API with
`ROLE_MODELS=builder=faux/faux-alt` (which publishes the model), `FAUX_MODEL_SCRIPTS` (its own answer,
`alt-ok`) and `FAUX_COST=0.01` (so the cost delta is a number, not zero). Its state is under
`.verify/run/cli-replay/`. See `features/replay.md`.

`session.sh` is separate because a repo-bound session needs a checkout to cut a worktree from and
`spend` needs a model that reports a cost: it boots its own API with `FAUX_COST=0.01`, registers a
checkout it creates, and drives fork, reset, compact and spend in tmux, reading entry ids back over
the RPC for what the CLI does not print. Its state is under `.verify/run/cli-session/`. See
`features/session.md`.

`clone.sh` is separate because it needs a forge to clone from and a token to clone with: it starts a
loopback `git http-backend` behind a Basic-auth gate (`../lib/git-remote.ts`, `CLONE_REMOTE_PORT`) and
boots its own API with a throwaway `GITHUB_TOKEN`, so a clone that did not send the credential fails.
Its state is under `.verify/run/cli-clone/`. See `features/clone.md`.

`up.sh` needs Postgres on host port 5442 — the session log _is_ Postgres. It does not start one
blindly: the shared `.pi/skills/lib/postgres.sh` asks the port first and runs `docker compose up -d
--wait postgres` only when nothing answers, because compose names its project after the directory it
runs in and a ralph worktree asking for 5442 a second time fails while another project's container
holds it (LOB-57). With no database and no way to start one it exits non-zero, printing the command
to run. It waits for **`/readyz`**, not `GET /`: the API binds its server before its migrations are
applied (LOB-21), so `/` answers a moment before a session can be created.

Two settings exist for the sake of proof, not production:

- `MODEL_BACKEND=faux` — pi-ai's scripted provider. The session runs a real `bash` tool call and the
  answer is derived from that tool's output, so the tool path is real; the _model_ is not. No key, no
  network, same transcript every run.
- `SESSION_IDLE_TIMEOUT_MS=5000` — short on purpose. The drive watches a session twice: while this
  API process still owns it (`mode: live`) and after the idle sweep has released it
  (`mode: historical`). `up.sh` records the value in `.verify/run/cli-idle-ms`, so `drive.sh` waits
  the window that was actually configured.

## Drive

```sh
./drive.sh       # requires the instance from ./up.sh
```

Environment: `API_URL` (default `http://localhost:9300`), `EVIDENCE_DIR`, and the same
`DATABASE_URL` `up.sh` ran with — the PR-column check seeds a session through it with
`.pi/skills/lib/seed-pr.ts`. `PR_SEED_GITHUB_PORT` pins the seed's loopback GitHub fake to a port
(the default, `0`, lets the OS choose one).

It runs `factory` in a **private tmux server** (`tmux -S .verify/run/cli-tmux.sock`), so it cannot
touch a tmux session you are using. Each command is typed into the pane and followed by a sentinel
the shell itself prints (`printf '\n__done_%s:%s\n' run $?`), so the driver waits for the command to
finish rather than for a delay, and it captures the exit code the sentinel carried. The pane is
cleared between commands: an assertion must not be able to match an earlier command's output.

## Evidence

Written to `.verify/evidence/latest/cli/` (override with `EVIDENCE_DIR`), gitignored:

- `run.txt`, `ls.txt`, `ls-pr.txt`, `watch-live.txt`, `watch-historical.txt`, `watch-unknown.txt` —
  the raw panes; `pr-seed.txt` — what the seed printed
- `observed.json` — every check with its detail, the session id, the API URL, and the idle window

Proof standards for this app:

- **Drive the real binary.** `bun run apps/cli/src/index.ts` — the same entry point `bun run build`
  packages as the `factory` bin. `Command.run` parses the arguments, so a flag that does not exist,
  a missing required argument, or a subcommand that is not wired fails here.
- **Require the answer, not the start.** The `run` check waits for `answer: faux-ok (re: verify-cli
probe)`, which can only exist once the tool call ran, the transcript committed, and the stream
  delivered it. A session id on stdout alone proves nothing.
- **Both read-path labels on one session id.** Live and historical are the same session watched
  before and after the idle sweep — the label is the whole point of `watch` (D8), and a fold that
  ended without a label would look like a dropped stream.
- **Exit codes are part of the contract.** `factory watch <unknown>` must exit non-zero with
  `error: not_found` on stderr, or a script cannot tell a refusal from an empty transcript.
- **A green unit test is not evidence for a command line.** There are none for `apps/cli`: the
  argument parser, the stream's end condition, and the terminal rendering are exactly what a unit
  test would mock away.

## Cleanup

```sh
./down.sh        # kills only the recorded pid, plus the private tmux server
```

Never kill by process name. Cleanup does not touch `.verify/evidence/` and does not delete session
logs from Postgres — the rows and commits are append-only history, and re-running the drive mints
new ids.

## Gotchas

- **The idle window is the clock for the historical check.** If `drive.sh` reports `mode: live`
  where it expected `mode: historical`, the owner was touched recently — check
  `SESSION_IDLE_TIMEOUT_MS` in `up.sh` against the `sleep` in the driver.
- **`--api` beats the environment.** The driver passes `--api` on every command, so a stray
  `FACTORY_API_URL` in your shell cannot redirect a drive run at another control plane.
- **`sendMessage` returns before the answer exists.** `factory run` sends, then attaches; the
  transcript arrives on the stream. If the run finished before the attach, the stream is a fold and
  still prints the whole answer — that is the design, not a race to fix.
- **One owner per log.** Pi Durable allows one owner per log, and `SessionService` gates acquisition.
  Do not open a `PostgresStorage` in owner mode against the same database while the API is running.
- **`factory` in `dist/` is stale unless you built it.** Drive the source entry point; `bun run
build` is part of the repo's gates, not of this drive.
- **5442 is a shared port, and compose is not the way to ask about it.** `docker compose up -d
--wait postgres` from a plain shell in a ralph worktree derives the project name `factory-ralph`
  (compose uses `COMPOSE_PROJECT_NAME` when it is set — `.pi/ralph/loop.sh` sets it for its sessions
  — and the directory name otherwise) and fights whatever already holds 5442: it fails with "port is
  already allocated" and leaves a `Created` container behind, while the database you need is up and
  healthy. `up.sh` asks the port instead
  (LOB-57); the regression is covered by
  `packages/storage-postgres/src/postgres-up.test.ts`, which drives this `up.sh` with a fake `docker`
  and a real listener.

## Feature map

Start at `features/README.md`.
