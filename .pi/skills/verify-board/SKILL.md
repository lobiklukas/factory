---
name: verify-board
description: Drive and prove the factory board — create a card, move it, and assert the three refusals (undeclared transition, stale revision, a run crossing a human gate) through `factory board ls|show|move|comment|start` in apps/cli against a real control plane in a real tmux terminal, then read the board back in the dashboard; includes the ask on the task across a restart. Use when asked to verify, test, or show evidence that the board works from the command line, or after changing apps/cli, packages/domain, packages/core's TaskService, or apps/api.
---

# Verify the board

Proves the board's CLI surface the way a person uses it: a real terminal, a real control plane, a
real Postgres, and the text and exit codes read back. Board state lives in rows, so nothing here is
mocked — `seed.ts` creates the board through `TaskService`, the drive creates its card through the
API's `createTask` (the door a trigger uses), moves it with the command a human would type, and reads
the result back in the dashboard.

This is the skill every later board issue extends; LOB-49's children **must not** create a second
one. The API behind it is proven by `.pi/skills/verify-api` (`features/board.md`), the sessions CLI by
`.pi/skills/verify-cli`, the dashboard by `.pi/skills/verify-web`. All of them start their own
instance of `apps/api` and record it in `.verify/run/api.pid`, so run them one at a time.

## What it proves

| Feature                          | Check in the driver                                                                   | Why it matters                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| create a card (B2, LOB-84)       | `create.ts`: `createTask` opens it in `intake` at r1, `getTask` reads it              | a trigger's card is a real row the board reads back                  |
| `board ls` (B9, LOB-61)          | every lane printed, in definition order, exit 0                                       | the lane order is the definition's, not the DB's                     |
| a card in its lane               | the created card is the row under `intake`                                            | lanes and cards come from one read, so they agree                    |
| `board show`                     | revision and title printed, exit 0                                                    | one card as the server has it                                        |
| `board move` (B5)                | a declared move prints the new column and revision, exit 0                            | the write path is real, at the revision it expected                  |
| refusal: a stale revision (B3)   | the service's message verbatim, non-zero exit                                         | a script can tell a refusal from a success                           |
| refusal: an undeclared move (B5) | names both columns verbatim, non-zero exit                                            | the refusal is typed, not generic prose                              |
| `board start` (B1)               | a `ses_…` id, and the card's column on stdout, exit 0                                 | a run is one session, bound to the card                              |
| refusal: a run at a gate (B5)    | that session as `--actor` on `planning → building`: code + message verbatim           | only a person crosses plan approval, and the refusal names the gate  |
| the refusals wrote nothing       | `board show` after them: the last accepted column and revision                        | a refused move is not a half-applied one                             |
| the dashboard agrees (LOB-84)    | `web.mjs`: lane, pane revision, and `building` marked `plan approval`                 | the browser shows what the CLI left, and offers a person the gate    |
| the ask on the task (B7)         | `ask.sh`: busy, then parked; block + question; restart; answer; next prompt           | a run that needs a person ends, and the answer reaches the next run  |
| `requires[]` on exit (B8)        | `requires.sh`: refused with no evidence, refused over another surface's, then through | a refusal names the requirement; evidence is a condition of the move |

Every check is required: `drive.sh`, `ask.sh` and `requires.sh` each exit non-zero when one
fails, and `drive.sh` folds `create.ts`'s and `web.mjs`'s exit codes into its own.

## Launch

```sh
./up.sh          # api on :9400, web on :3400, faux model, one board seeded
./doctor.sh      # read-only; fails loudly when Postgres on 5442 is down
./down.sh        # stops only what up.sh started, plus the drive's tmux server
```

`up.sh` needs Postgres on host port 5442 — the cards _are_ rows. It asks the port before it asks
compose (`docker compose up -d --wait postgres`), because compose derives its project name from the
directory it runs in and a ralph worktree asking for 5442 a second time fights the human's container
(LOB-57). It waits for **`/readyz`**, not `GET /`: the API binds its server before its migrations are
applied (LOB-21), so `/` answers a moment before a card can be read.

`seed.ts` writes the board: one `board_instances` row over the seeded `default` definition version 1
(`SEED_CARD=0`, so no card). It prints one JSON line into `.verify/run/board.json`, which `doctor.sh`
and `drive.sh` read. The drive's card is its own, created by `create.ts` over the API at the start of
every drive, so the drive can run twice against one instance — even after a drive that failed
part-way, because the checks find the drive's card by id in its lane rather than as the lane's only
card; `ask.sh` calls `seed.ts` without
`SEED_CARD=0` and gets a board and a card from the service (so `task_events` gets its `created` row).
`MODEL_BACKEND=faux` keeps `board start` offline: the session, its worktree and its `factory.task`
document are real; only the model behind it is scripted.

The dashboard (`apps/web`'s `bun run dev`, pid in `.verify/run/web.pid`) points at this API, whose
`ALLOWED_ORIGINS` names the web origin. `up.sh` waits for both. Override the ports with `API_PORT` and
`WEB_PORT` (and pass the same values to `doctor.sh` and `drive.sh`; `drive.sh` reads the web port
`up.sh` recorded in `.verify/run/web-port` when `WEB_PORT` is unset).

`up.sh` refuses to start when `API_PORT` or `WEB_PORT` is already held, and its readiness loop
requires both recorded pids alive: Vite runs with `strictPort`, so on a held port ours exits while
the holder keeps answering. `doctor.sh` likewise checks that the API's port and the dashboard's port
are owned by the recorded pid or a descendant of it (Vite is a child of `bun run dev`).

`doctor.sh` checks the database **first and unconditionally**, from the port in `DATABASE_URL`: a
missing API is never a reason to stop before saying Postgres is down, and a down Postgres is a
non-zero exit with a line on stderr. `packages/storage-postgres/src/verify-board-doctor.test.ts`
runs the real script against a closed port and an answering one.

## Drive

```sh
./drive.sh       # requires the instance from ./up.sh
./ask.sh         # standalone: starts, kills and restarts its own API on ASK_PORT (default 9401)
./requires.sh    # standalone: its own API on REQUIRES_PORT (default 9402), three runs on one card
```

`requires.sh` (LOB-80) walks a card on the newest `default` definition into `review` and proves the
column's `verified` requirement from the terminal: refused with no evidence, refused again when the
card's latest change (`api`) is unverified even though an earlier run verified `web`, and let through
once `api` passes. Its runs are real sessions bound to the card, verified by the real `verify` tool
over a fixture repo; `requires.ts` seeds the card and reads each run's `verify` record back. See
`features/requires.md`.

`ask.sh` (LOB-73) is two processes on purpose: the run asks in the first, the API is sent SIGTERM,
and the answer and the next run happen in the second — the question and the block are rows, so a
restart between ask and answer must lose neither. Its two non-CLI facts (is the session busy, what
was the next run's recorded prompt) are probed by `ask.ts`. See `features/ask.md`.

Environment: `API_URL` (default `http://localhost:9400`), `WEB_URL` (default the recorded web port),
`EVIDENCE_DIR`.

The phases, in order: **create** (`create.ts`, over RPC) → `ls` → `show` → a declared move to
`specifying` → the **stale** refusal (the revision the card had before that move) → the **undeclared**
refusal (`specifying → done`) → `start` (the run, `ses_…`) → a person's move to `planning` → the
**human-gate** refusal (`planning → building` with `--actor <that ses_…>`) → `show` again (the
refusals wrote nothing) → **web** (`web.mjs` in headless Chrome: the card's lane, the pane's revision,
`building` offered and marked `plan approval`).

It runs `factory` in a **private tmux server** (`.verify/run/board-tmux.sock`), so it cannot touch a
tmux session you are using. Each command is typed into the pane and followed by a sentinel the shell
prints (`printf '\n__done_%s:%s\n' marker $?`), so the driver waits for the command to finish rather
than for a delay, and it reads the exit code the sentinel carried. The pane is cleared between
commands: an assertion must not match an earlier command's output.

## Evidence

Written to `.verify/evidence/latest/board/` (override with `EVIDENCE_DIR`), gitignored:

- `create.json` — the created card, its `getTask` read-back, and the create phase's checks
- `ls.txt`, `show.txt`, `move.txt`, `move-stale.txt`, `move-undeclared.txt`, `start.txt`,
  `move-planning.txt`, `move-gate.txt`, `show-after.txt` — raw panes, one per phase
- `web.json`, `web-board.png` — the dashboard phase's checks, the lanes and pane as rendered, the
  server's `getTask` it was compared with, and the screenshot
- `observed.json` — every check with its detail, the board id, the card id and the session id.
  `drive.sh` deletes `create.json`, `web.json`, `web-board.png` and `observed.json` before it starts,
  so a phase that dies before writing cannot leave an earlier run's passing file behind
- `ask-observed.json`, `ask-{busy,parked,told}.json`, `ask-*.txt`, `ask-api.log` — `ask.sh`'s checks,
  its probes' facts, the CLI outputs and both processes' log
- `requires-observed.json`, `requires-{web,api-unverified,api-verified}.json`, `requires-*.txt`,
  `requires-api.log` — `requires.sh`'s checks, each run's decoded `verify` record, the CLI outputs

Proof standards for this surface:

- **Drive the real binary.** `bun run apps/cli/src/index.ts` — the entry point `bun run build`
  packages as the `factory` bin. `Command.run` parses the flags, so a flag that does not exist or a
  subcommand that is not wired fails here.
- **Lane order is compared, not eyeballed.** The driver extracts the lane names from the lane lines
  and compares the whole string with the definition's order (`intake … canceled`); a definition that
  reorders lanes reddens the check.
- **A refusal is the service's words.** The stale-revision, undeclared-transition and human-gate
  checks match the exact `message` the service produced (`task … is at revision 2, not 1: someone
moved it first`; `human_gate_required: the move planning → building crosses the plan approval
gate, which only a person can make`), so a command that swallowed the refusal and printed its own
  prose fails. The pane runs under a UTF-8 locale (`tmux -u`) because the gate's message carries `→`.
- **The gate's actor is the run's id.** The human-gate move is made with the session id `board start`
  printed, not an invented `ses_…`. The service only asks that the actor be a well-formed session id
  (`isRunActor`); it does not look the session up.
- **Exit codes are part of the contract.** A refused move must exit non-zero, or a script cannot
  branch on it.
- **A green unit test is not evidence for a command line.** `packages/core`'s `TaskService` cases
  prove the service; the parser, the lane rendering and the exit code only exist here.

## Cleanup

```sh
./down.sh        # kills only the recorded pid, plus the private tmux server
```

Never kill by process name. Cleanup does not touch `.verify/evidence/` and does not delete the
seeded rows: deleting a card's history is not cleanup, and re-running `./up.sh` seeds a new board.

## Gotchas

- **`--expect-revision` has no default.** The move is the optimistic-concurrency token (B3), so the
  command refuses to guess. The driver threads the revision it read into every move and asserts the
  number it got back.
- **The actor decides the gates.** `--actor` defaults to `cli`, a person. A session id is a run, and
  a run cannot cross `planning → building` or `review → done` (B5) — that is a different refusal
  (`human_gate_required`), not a bug. The drive proves it with the run's own id and does not cross
  the gate as a person afterwards: that half is `packages/core`'s `TaskService` case, and stopping
  in `planning` leaves the dashboard phase a card whose next move is the gate the run was refused.
- **`board start` sends nothing unless asked.** Without `--prompt` the run opens and waits; `ask.sh`
  passes one so the run takes a turn.
- **The faux asks only once per card.** `FAUX_ASK` makes the script call `ask` when the run was
  offered the tool and its prompt has no `task_thread` yet, so the run after an answer replies instead.
- **`board start` does not move the card.** The lane a run works in is where the card already sits;
  the card moves when a person moves it, with the run's evidence in hand.
- **5442 is a shared port.** `up.sh` asks the port instead of running compose blind; the regression is
  covered by `packages/storage-postgres/src/postgres-up.test.ts`, which drives the shared
  `.pi/skills/lib/postgres.sh` with a fake `docker` and a real listener.
- **The web phase needs Chrome.** `web.mjs` launches the installed Chrome (`channel: "chrome"`) through
  the root's `@playwright/test`, as `verify-web` does; no browser is downloaded.
- **One owner per log.** Do not open a `PostgresStorage` in owner mode against the same database while
  the API is running; `board start` would race it.

## Feature map

Start at `features/README.md`.
