---
name: verify-cli
description: Drive and prove the factory CLI (`factory run` / `watch` / `ls` in apps/cli) in a real tmux terminal against a real control plane. Use when asked to verify, test, or show evidence that the CLI works, or after changing apps/cli, packages/domain, or apps/api.
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

| Feature                     | Check in the driver                                  | Why it matters                                     |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `factory run` (D9)          | creates, streams, and prints the answer, exit 0      | the whole write path in one command                |
| The run's session is named  | `session ses_…` on stdout, and `workspace <path>`    | the server's own answer, not a client guess        |
| The tool call is real       | a `[tool:bash]` line carrying the faux tool's output | the transcript can only exist if the tool ran      |
| `factory ls` (LOB-6)        | the new session is a row, with its title, exit 0     | the list is a server read, not a local registry    |
| `factory watch`, live (D8)  | `mode: live`, then the same answer                   | a session this process owns streams                |
| `factory watch`, historical | `mode: historical` after the idle sweep, same answer | the fold path, and the label that tells them apart |
| Typed errors                | unknown id → `error: not_found`, non-zero exit       | a script can branch on `code`, not on prose        |

Every check is required: `drive.sh` exits non-zero when one fails.

## Launch

```sh
./up.sh          # api on :9300, pid in .verify/run/, model backend faux
./doctor.sh      # read-only; exits non-zero when the instance is not worth driving
./down.sh        # stops only what up.sh started, plus the drive's tmux server
```

`up.sh` needs Postgres (`docker compose up -d --wait postgres`) — the session log _is_ Postgres. It
waits for **`/readyz`**, not `GET /`: the API binds its server before its migrations are applied
(LOB-21), so `/` answers a moment before a session can be created.

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

Environment: `API_URL` (default `http://localhost:9300`), `EVIDENCE_DIR`.

It runs `factory` in a **private tmux server** (`tmux -S .verify/run/cli-tmux.sock`), so it cannot
touch a tmux session you are using. Each command is typed into the pane and followed by a sentinel
the shell itself prints (`printf '\n__done_%s:%s\n' run $?`), so the driver waits for the command to
finish rather than for a delay, and it captures the exit code the sentinel carried. The pane is
cleared between commands: an assertion must not be able to match an earlier command's output.

## Evidence

Written to `.verify/evidence/latest/cli/` (override with `EVIDENCE_DIR`), gitignored:

- `run.txt`, `ls.txt`, `watch-live.txt`, `watch-historical.txt`, `watch-unknown.txt` — the raw panes
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

## Feature map

Start at `features/README.md`.
