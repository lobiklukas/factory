---
name: verify-board
description: Drive and prove the factory board from the CLI (`factory board ls|show|move|comment|start` in apps/cli) against a real control plane in a real tmux terminal, including the ask on the task across a restart. Use when asked to verify, test, or show evidence that the board works from the command line, or after changing apps/cli, packages/domain, packages/core's TaskService, or apps/api.
---

# Verify the board

Proves the board's CLI surface the way a person uses it: a real terminal, a real control plane, a
real Postgres, and the text and exit codes read back. Board state lives in rows, so nothing here is
mocked — the skill's `seed.ts` creates a card through `TaskService`, and the drive then moves it
with the command a human would type.

This is the skill every later board issue extends; LOB-49's children **must not** create a second
one. The API behind it is proven by `.pi/skills/verify-api` (`features/board.md`), the sessions CLI by
`.pi/skills/verify-cli`, the dashboard by `.pi/skills/verify-web`. All of them start their own
instance of `apps/api` and record it in `.verify/run/api.pid`, so run them one at a time.

## What it proves

| Feature                  | Check in the driver                                                         | Why it matters                                                      |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `board ls` (B9, LOB-61)  | every lane printed, in definition order, exit 0                             | the lane order is the definition's, not the DB's                    |
| a card in its lane       | the seeded card is the row under `intake`                                   | lanes and cards come from one read, so they agree                   |
| `board show`             | revision and title printed, exit 0                                          | one card as the server has it                                       |
| `board move` (B5)        | a declared move prints the new column and revision, exit 0                  | the write path is real, at the revision it expected                 |
| a stale revision (B3)    | the service's message verbatim, non-zero exit                               | a script can tell a refusal from a success                          |
| an undeclared move (B5)  | names both columns verbatim, non-zero exit                                  | the refusal is typed, not generic prose                             |
| `board start` (B1)       | a `ses_…` id, and the card's column on stdout, exit 0                       | a run is one session, bound to the card                             |
| the ask on the task (B7) | `ask.sh`: busy, then parked; block + question; restart; answer; next prompt | a run that needs a person ends, and the answer reaches the next run |

Every check is required: `drive.sh` and `ask.sh` each exit non-zero when one fails.

## Launch

```sh
./up.sh          # api on :9400, faux model, one board and one card seeded
./doctor.sh      # read-only; fails loudly when Postgres on 5442 is down
./down.sh        # stops only what up.sh started, plus the drive's tmux server
```

`up.sh` needs Postgres on host port 5442 — the cards _are_ rows. It asks the port before it asks
compose (`docker compose up -d --wait postgres`), because compose derives its project name from the
directory it runs in and a ralph worktree asking for 5442 a second time fights the human's container
(LOB-57). It waits for **`/readyz`**, not `GET /`: the API binds its server before its migrations are
applied (LOB-21), so `/` answers a moment before a card can be read.

`seed.ts` is the only writer of the drive's fixtures: one `board_instances` row over the seeded
`default` definition version 1, and one card through the real `TaskService` (so `task_events` gets
its `created` row). It prints one JSON line into `.verify/run/board.json`, which `doctor.sh` and
`drive.sh` read. `MODEL_BACKEND=faux` keeps `board start` offline: the session, its worktree and its
`factory.task` document are real; only the model behind it is scripted.

## Drive

```sh
./drive.sh       # requires the instance from ./up.sh
./ask.sh         # standalone: starts, kills and restarts its own API on ASK_PORT (default 9401)
```

`ask.sh` (LOB-73) is two processes on purpose: the run asks in the first, the API is sent SIGTERM,
and the answer and the next run happen in the second — the question and the block are rows, so a
restart between ask and answer must lose neither. Its two non-CLI facts (is the session busy, what
was the next run's recorded prompt) are probed by `ask.ts`. See `features/ask.md`.

Environment: `API_URL` (default `http://localhost:9400`), `EVIDENCE_DIR`.

It runs `factory` in a **private tmux server** (`.verify/run/board-tmux.sock`), so it cannot touch a
tmux session you are using. Each command is typed into the pane and followed by a sentinel the shell
prints (`printf '\n__done_%s:%s\n' marker $?`), so the driver waits for the command to finish rather
than for a delay, and it reads the exit code the sentinel carried. The pane is cleared between
commands: an assertion must not match an earlier command's output.

## Evidence

Written to `.verify/evidence/latest/board/` (override with `EVIDENCE_DIR`), gitignored:

- `ls.txt`, `show.txt`, `move.txt`, `move-stale.txt`, `move-undeclared.txt`, `start.txt` — raw panes
- `observed.json` — every check with its detail, the board id, the card id and the session id
- `ask-observed.json`, `ask-{busy,parked,told}.json`, `ask-*.txt`, `ask-api.log` — `ask.sh`'s checks,
  its probes' facts, the CLI outputs and both processes' log

Proof standards for this surface:

- **Drive the real binary.** `bun run apps/cli/src/index.ts` — the entry point `bun run build`
  packages as the `factory` bin. `Command.run` parses the flags, so a flag that does not exist or a
  subcommand that is not wired fails here.
- **Lane order is compared, not eyeballed.** The driver extracts the lane names from the lane lines
  and compares the whole string with the definition's order (`intake … canceled`); a definition that
  reorders lanes reddens the check.
- **A refusal is the service's words.** The stale-revision and undeclared-transition checks match the
  exact `message` the service produced (`task … is at revision 2, not 1: someone moved it first`), so
  a command that swallowed the refusal and printed its own prose fails.
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
  (`human_gate_required`), not a bug.
- **`board start` sends nothing unless asked.** Without `--prompt` the run opens and waits; `ask.sh`
  passes one so the run takes a turn.
- **The faux asks only once per card.** `FAUX_ASK` makes the script call `ask` when the run was
  offered the tool and its prompt has no `task_thread` yet, so the run after an answer replies instead.
- **`board start` does not move the card.** The lane a run works in is where the card already sits;
  the card moves when a person moves it, with the run's evidence in hand.
- **5442 is a shared port.** `up.sh` asks the port instead of running compose blind; the regression is
  covered by `packages/storage-postgres/src/postgres-up.test.ts`, which drives the shared
  `.pi/skills/lib/postgres.sh` with a fake `docker` and a real listener.
- **One owner per log.** Do not open a `PostgresStorage` in owner mode against the same database while
  the API is running; `board start` would race it.

## Feature map

Start at `features/README.md`.
