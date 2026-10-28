---
name: verify-web
description: Drive and prove the factory web dashboard (React SPA at apps/web) in a real browser, together with the Effect API behind it (apps/api). Use when asked to verify, test, or show evidence that the dashboard or its API works, or when a change to apps/web, apps/api, or packages/domain needs proof beyond unit tests.
---

# Verify the web dashboard

Proves behavior by driving the real dashboard in a real browser and capturing evidence.
Unit tests and type checks do not replace this: the streaming card once type-checked and rendered
while the stream silently did nothing (see `features/session-stream.md`).

Two surfaces exist in this repo. This skill covers the **web dashboard** plus the API it calls.
The **CLI** (`apps/cli`) is a separate surface with its own skill — `.pi/skills/verify-cli`, which
drives `factory run`/`watch`/`ls` in a real tmux terminal. Use that one for command-line changes;
this one for anything a person clicks.

## Launch

Run on isolated ports so the run never competes with a dev server you already have open.
Port 3000 in particular is often taken by something else, and Vite is configured `strictPort`,
so it will fail rather than pick another port.

```sh
./up.sh          # api on :9100, web on :3100; pids recorded in .verify/run/
./down.sh        # stops only what up.sh started
```

`up.sh` waits for both surfaces to answer and fails loudly with log paths if they don't
(`.verify/run/api.log`, `.verify/run/web.log`). Override with `API_PORT=` / `WEB_PORT=`.

`ALLOWED_ORIGINS` must name the web port or the browser's request to the API is blocked by
CORS. `up.sh` sets it for you.

## Doctor

```sh
./doctor.sh      # read-only; exits non-zero when the instance is not worth driving
```

Checks that the recorded pids are alive, that our ports are owned by us, and that both
surfaces answer. Port ownership compares against the recorded pid **and its descendants**,
because `bun run dev` starts Vite as a child process. Run this first whenever anything looks
off — do not trust a drive run against an instance that fails the doctor.

## Drive

```sh
node drive.mjs   # requires the instance from ./up.sh to be running
```

Uses the locally installed Chrome (`channel: "chrome"`), so no Playwright browser download is
needed. Environment: `WEB_URL`, `API_URL`, `EVIDENCE_DIR`, and the same `DATABASE_URL` `up.sh` ran
with — the PR-link check (`features/pr-link.md`) seeds a session through it with
`.pi/skills/lib/seed-pr.ts`, whose loopback GitHub fake takes `PR_SEED_GITHUB_PORT` (default `0`:
the OS chooses).

It asserts the shell renders, asserts the browser can reach the API from the page's own origin,
and opens **New session**, types a prompt of its own and submits the form (E6), requiring the transcript to reach the answer the agent's `bash`
tool produced and the card to label its read path. It then seeds its own board and card, opens
the board, and requires one lane per column in definition order and the card in `intake`
(`features/board.md`). It then opens the card pane and requires only the column's declared moves,
the human gate marked, a stale-revision move refused in the service's words with the card left in
place, a `factory board move` followed without a reload (and the card's new lane on reload and in a
fresh browser context), a pane move that `factory board show` prints, and a run started from the
card, then a second board over a synthetic definition (`seed-definition.ts`: todo → doing → done,
gated on the last move) whose pane offers only that definition's moves (`features/card-pane.md`). It then seeds a second board (`seed-attention.ts`) and requires
`/attention` to show an explicit empty state while nothing on it needs a person, then a run's
pending approval, a run's question and a done run at the plan approval, each with its reason and a
link that opens the card, and never a card blocked on a dependency; a card-less session's approval is
one row linking to the session, the rail badge equals the row count, and `?board=` leaves the row out
(`features/attention.md`). Exit
code is non-zero when a required check fails. Each run
seeds a new board, so the drive can be rerun against the same instance; run it with the
`DATABASE_URL` `./up.sh` started the API with.

The dashboard drives the API, and the API needs Postgres on host port 5442: `./up.sh` asks the port
first and runs `docker compose up -d --wait postgres` only when nothing answers, so it starts from a
ralph worktree while another project's container holds 5442 (LOB-57); with no database and no way to
start one it exits non-zero, printing the command to run. The session's model is scripted
(`MODEL_BACKEND=faux`) so the run is offline and deterministic; its tool calls, transcript, and
storage are real.

### The card's thread

```sh
THREAD_API_PORT=9431 THREAD_WEB_PORT=3431 ./thread.sh   # its own asking instance; leaves nothing running
```

Answering a parked card needs a run that asks, and the faux model asks only when the whole API is
started with `FAUX_ASK` — which on this instance would park every card run the drive starts. So
`thread.sh` starts its own API (`FAUX_ASK`) and dashboard, runs `thread.mjs`, and stops both. The
drive starts a run from a card's pane, requires the pane to show the question it parked on, answers
it in the browser through a stale-revision refusal (the draft kept, the card re-read by the refusal itself, timed apart from the poll), requires the
block lifted, `factory board show` to agree, and the next run's committed prompt to quote the answer
(`../verify-board/ask.ts MODE=told`) (`features/thread.md`). Evidence goes to
`.verify/evidence/latest/thread/`.

### The spend pane

```sh
SPEND_API_PORT=9421 SPEND_WEB_PORT=3421 ./spend.sh   # its own priced instance; leaves nothing running
```

`/spend` needs a priced model, which this instance deliberately does not run (the compaction check
requires a spend line with no dollar figure). So `spend.sh` starts its own API (`FAUX_COST=0.01`) and
dashboard, runs `spend.mjs`, and stops both. The drive seeds runs by actors and repos of its own,
one from `factory run`, one from the dashboard's **New session**, and one run each from
`factory board start` and a card's **Start run** (`seed-spend.ts`), then requires the page's
repo × actor table to be `listSpend`'s answer and its pairs to be the list's costs added up
(`features/spend.md`). Evidence goes to `.verify/evidence/latest/spend/`.

### Cost prediction

```sh
DATABASE_URL=… COST_API_PORT=9452 COST_WEB_PORT=3452 ./cost.sh   # its own priced instance and database; leaves nothing running
```

The New session form's predicted range and its **Cap at predicted high**, and `/spend`'s backtest
strip (LOB-38). A prediction needs priced history, and its first state — no estimate — needs none, so
`cost.sh` starts its own API (`FAUX_COST=0.01`) and dashboard on a throwaway database it mints on
`DATABASE_URL`'s server and drops on exit. `cost.mjs` reads the empty form, runs three sessions over the
RPC, then requires the form's range and the capped session's budget to be `predictCost`'s, and the
strip's numbers to be `backtestCost`'s (`features/cost.md`). Evidence goes to
`.verify/evidence/latest/cost/`.

### Earlier history of a long session

```sh
HISTORY_API_PORT=9437 HISTORY_WEB_PORT=3437 ./history.sh   # its own short-idle instance; leaves nothing running
```

The pane only pages back through a **historical** read, and this instance keeps its owners live. So
`history.sh` starts its own API (`SESSION_IDLE_TIMEOUT_MS=4000`) and dashboard, grows and releases one
session with `../verify-api/history.ts` (which checks the RPC half), then runs `history.mjs`: the pane
shows the newest entries and **Show earlier entries**, each press reads one page, and once the control
is gone every turn's message is on screen once, in order (`features/history.md`). Evidence goes to
`.verify/evidence/latest/history/`.

### The repositories page

```sh
REPOS_API_PORT=9441 REPOS_WEB_PORT=3441 ./repos.sh   # its own instance and throwaway git checkouts; leaves nothing running
```

`/repos` needs real git checkouts on the API's disk, so `repos.sh` starts its own API and dashboard and
`repos.mjs` makes them. It seeds a repo a session registered by naming a slug (no checkout), then
requires the page to flag it **not runnable** with the reason and the fix, a bad slug refused in the
form, a path that is not a git work tree refused in the server's own words with nothing written, a
throwaway checkout registered through the form and listed without a reload (equal to `listRepos`),
the flagged repo turned runnable in place, a session on the registered repo cut a
`factory/<session-id>` worktree (asserted over the API and on disk), and a checkout moved away
behind the registry's back flipping its row on the poll (`features/repos.md`). Evidence goes to
`.verify/evidence/latest/repos/`.

### Creating a board

```sh
BOARD_CREATE_API_PORT=9561 BOARD_CREATE_WEB_PORT=3561 ./board-create.sh   # its own instance and empty database; leaves nothing running
```

The empty state of `/boards` needs a database with no board, so `board-create.sh` starts its own API
and dashboard on a throwaway database it mints on `DATABASE_URL`'s server (over TCP) and drops on exit.
`board-create.mjs` requires the empty state to offer **New board**, the form's definition and version
pickers to be `listDefinitions`' (the newest version first), a bad slug stopped in the form with no
request, a typed slug to land on the new board's lanes pinned to the newest version and printed by
`factory board list`, a second create for it to be `BoardExists` with a link to the existing board and
nothing written, a registered repository to be offered by the picker and version 1 to pin version 1,
and `DefinitionNotFound` (the page's own request rewritten in flight to name a definition that does
not exist) to be shown verbatim with nothing written (`features/board-create.md`). `drive.mjs` makes
its own board through the same form. Evidence goes to `.verify/evidence/latest/board-create/`.

### The first run

```sh
FIRST_RUN_API_PORT=9562 FIRST_RUN_WEB_PORT=3562 ./first-run.sh   # its own instance and empty database; leaves nothing running
```

A new operator's path needs a database with nothing in it, so `first-run.sh` starts its own API and
dashboard on a throwaway database it mints on `DATABASE_URL`'s server and drops on exit.
`first-run.mjs` walks the path through the browser alone (C9): `/` opens `/boards`, whose checklist
shows nothing ticked; every empty state (`/attention`, `/approvals`, `/sandboxes`, `/spend`,
`/sessions`) names a press in the UI and none says to type `factory <command>`; then each step's own
link registers a throwaway checkout, creates a board on it, adds a card and (after moving the card out
of intake) starts a run, with the checklist ticking one step at a time, equal to the RPC reads. It ends
on routing: `/` and the logo open the only board's lanes, and the list once a second board exists
(`features/first-run.md`). Evidence goes to `.verify/evidence/latest/first-run/`.

### Board settings

```sh
BOARD_SETTINGS_API_PORT=9471 BOARD_SETTINGS_WEB_PORT=3471 ./board-settings.sh   # its own instance with a role model; leaves nothing running
```

A column's model is deployment configuration, so `board-settings.sh` starts its own API
(`ROLE_MODELS=specifier=faux/faux-spec`) and dashboard and makes two boards over the RPC, one on the
default definition's newest version and one pinned to v2. `board-settings.mjs` opens each board's
**Settings** page from its header and requires every column read back from the page — kind, role,
model and its source, skills, requirements marked checked or "not yet checked", moves out and human
gates — to equal `getDefinition` for the board's version; `planning → building` to be the gate "plan
approval" and `specifying`'s role `specifier`; the v2 board to say v3 exists; each lane header's
disclosure to show its column's same facts; and a malformed or missing board to be refused
(`features/board-settings.md`). Booted with `APPROVAL_REQUIRED="npm publish"`, it also authors a
definition whose `careful` column gates `sleep` (C22), requires every column's effective autonomy on
the page to equal `getDefinition`, and starts a run in `careful` and one in `building` with the same
faux call: the first parks on an approval, the second runs. Evidence goes to `.verify/evidence/latest/board-settings/`.

### The dashboard's credential

```sh
AUTH_API_PORT=9445 AUTH_WEB_PORT=3445 AUTH_OPEN_WEB_PORT=3446 ./auth.sh   # an API that requires a token, two dashboards; leaves nothing running
```

`auth.sh` boots an API with `FACTORY_API_TOKENS=dashboard-op=<per-run token>` and two dashboards on it,
one built with `VITE_FACTORY_API_TOKEN` and one without (LOB-20). `auth.mjs` requires the first to list
a session the API holds, to send `Authorization: Bearer` on every RPC, and to have its **New session**
(body actor `dashboard`) recorded as `dashboard-op` in `listSpend`; and the second to be answered
`Unauthenticated` and show no session. The shell checks the token is in neither the evidence nor the
API log. Evidence goes to `.verify/evidence/latest/auth/`. Every other drive here runs against an API
with auth off (its checks expect the declared `dashboard` actor).

### The model backend and each session's model

```sh
BACKEND_API_PORT=9451 BACKEND_WEB_PORT=3451 ./backend.sh   # its own anthropic-inferred instance; leaves nothing running
```

`drive.mjs` proves the faux half (the `role="alert"` banner on `/sessions`, on a board and on `/spend`;
`faux/faux-1` in the pane header and the list row, equal to `getSession`'s). The no-banner half needs a
deployment that is not scripted, so `backend.sh` starts its own API (no `MODEL_BACKEND`, a _dummy_
`ANTHROPIC_API_KEY`, so the backend is inferred from the credential) and dashboard, runs `backend.mjs`,
and stops both. It requires no banner after the page's own `getServerInfo` read has landed,
`anthropic/claude-sonnet-5-5` in the pane header and the row of a session created over the RPC (no
message is sent, so no request leaves the machine), and `factory status` / `factory ls` against it
(`features/backend-badge.md`). Evidence goes to `.verify/evidence/latest/backend/`.

### The New session form

```sh
SESSION_NEW_API_PORT=9461 SESSION_NEW_WEB_PORT=3461 ./session-new.sh   # its own instance and throwaway checkouts; leaves nothing running
```

A session on a repo needs real git checkouts on the API's disk, so `session-new.sh` starts its own
API and dashboard and `session-new.mjs` makes two (E6). It requires **New session** to open a form and
create nothing, an empty prompt to send no `createSession` (the page's own requests are the oracle),
the typed multi-line prompt to be the session's first user entry verbatim, a session on a picked repo
and base ref to be listed with both and to work in a `factory/<session-id>` worktree cut from that
ref, a repo whose base ref the checkout lacks to be refused inline in the server's words and to leave
no `sessions` row (read from the table over TCP), and an answer to a form the person closed to be a
toast rather than lost or pulled into a later form (`features/session-new.md`). Evidence goes to `.verify/evidence/latest/session-new/`.

### The New session model picker

```sh
MODEL_API_PORT=9451 MODEL_WEB_PORT=3451 ./model.sh   # its own instance with DEFAULT_MODEL and a role model; leaves nothing running
```

The models a server serves are deployment settings, so `model.sh` starts its own API and dashboard
with `DEFAULT_MODEL=faux/faux-cheap` and `ROLE_MODELS=specifier=faux/faux-spec`. `model.mjs` requires
the New session form's **Model** picker to offer the server's default and then exactly `getServerInfo.models`,
a session started on `faux/faux-spec` to name it and to have sent every request to it (its
`usage.models`, read over the API), and one started on the server's default to run `faux/faux-cheap`
(`features/model-picker.md`). Evidence goes to `.verify/evidence/latest/model/`.

### Interrupting a busy run

```sh
INTERRUPT_API_PORT=9461 INTERRUPT_WEB_PORT=3461 ./interrupt.sh   # its own instance with FAUX_SLEEP_MS; leaves nothing running
```

A run is only busy long enough to press if the scripted model naps, so `interrupt.sh` starts its own
API and dashboard with `FAUX_SLEEP_MS` (default `4000`). `interrupt.mjs` requires one press to send
one `interruptSession`, the header to go idle within 5 s, no `faux-ok` two naps later, the turn's
`interrupted` row, a follow-up that answers, and a press held in the browser until the run settled to
raise a toast in the server's words (`features/interrupt.md`). Evidence goes to
`.verify/evidence/latest/interrupt/`.

### The card face

```sh
CARD_FACE_API_PORT=9581 CARD_FACE_WEB_PORT=3581 ./card-face.sh   # its own instance with FAUX_SLEEP_MS; leaves nothing running
```

A card shows its newest run's state, the PR its runs opened and their summed spend (C10), from the
board's one `listBoardCards` read. `card-face.sh` starts its own API and dashboard with
`FAUX_SLEEP_MS` (default `5000`); `card-face.mjs` seeds a board (`seed-card-face.ts`), starts runs over
the RPC, and requires `busy` within one poll interval of a run starting, the summed spend to equal the
sum the drive reads off `listTaskRuns` and `listSessions`, a PR link to appear within one poll interval
of the session recording it, `idle` once the run settles, no per-card read in the page's RPC tags, and
nine cards to cost no more calls per window than three (`features/card-face.md`). Evidence goes to
`.verify/evidence/latest/card-face/`.

### Open pull request

```sh
PR_API_PORT=9442 PR_WEB_PORT=3442 PR_GITHUB_PORT=9443 ./pr.sh   # its own instance and loopback GitHub fake, twice; leaves nothing running
```

A PR is opened by a person's press in the session pane's header or on a card's run row (C7), so
`pr.sh` starts its own API (`GITHUB_API_URL` the fake, a `GITHUB_TOKEN` the fake never reads),
dashboard and `github-fake.ts`, plus three fixture checkouts whose marker file makes the instance's
one scripted command commit a small change, a change over the diff cap, or nothing. `pr.mjs` presses
the control and requires the link in both panes without a reload, one create request in the fake's
ledger for a double press and for a repeat over RPC, and each refusal in the server's words with the
button disabled. It then runs again with no credential and requires the missing-token message
(`features/pr-open.md`). Evidence goes to `.verify/evidence/latest/pr/{fake,off}/`.

## Evidence

Written to `.verify/evidence/latest/` (override with `EVIDENCE_DIR`), gitignored:

- `dashboard.png` — full-page screenshot after the drive
- `boards.png`, `board.png`, `board-after-move.png` — the boards list and the seeded board before and
  after the CLI move
- `card-pane-intake.png`, `card-pane-stale.png`, `card-pane-run.png` — the card pane in `intake`, with
  the stale-revision refusal, and with a run started from it
- `attention-empty.png`, `attention.png`, `attention-card.png`, `attention-all.png`, `attention-scratch.png` — the attention
  view of the seeded board with nothing waiting, with its three rows, the card a row opened, every
  board's view, and the every-board view with a card-less session's approval
- `backend-banner.png`, `session-model.png` — the faux banner on `/sessions`, and a session's pane header
  and list row naming `faux/faux-1` (LOB-272, `features/backend-badge.md`)
- `session-pane-narrow.png`, `fork-lineage-narrow.png` — a session's pane at 390 px, and the session
  list its header's back link opened there (LOB-210, `features/fork-lineage.md`)
- `observed.json` — heading, per-check pass/fail with details, the API body, the session card's
  transcript and mode label, console errors, and HTTP responses ≥ 400

Proof standards for this app:

- Exercise the real control a user touches. Click the button; do not call the client from the
  test process. `api-connectivity` deliberately runs its `fetch` **inside the page** so it
  proves CORS and reachability through the client's origin, which a curl from the shell would not.
- Capture the action and the resulting state: the screenshot plus the extracted text, not one or
  the other.
- A green unit test is not evidence for a browser path. The streaming card was the proof: it
  compiled, rendered, and did nothing.
- Chrome logs a 404 for a resource that never appears in Playwright's response events (it is a
  favicon-class request). It is not a failure of the drive and `failedResponses` will be empty
  for it. Do not chase it.
- Require the end of the story, not the beginning. The session card check waits for the _answer_,
  which exists only once the tool call, the transcript commit, and the stream all worked.

## Cleanup

```sh
./down.sh        # kills only the pids up.sh recorded, removes .verify/run/
```

Never kill by process name — this machine runs other Vite/Node servers, and one of them may
hold port 3000. Cleanup removes the instance and its scratch state and deliberately does not
touch `.verify/evidence/`; after cleanup, confirm the evidence is still there.

## Helpers

| File                | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `up.sh`             | Launch isolated API + web, wait for readiness                                    |
| `down.sh`           | Stop only what `up.sh` started                                                   |
| `doctor.sh`         | Read-only health check of the instance                                           |
| `drive.mjs`         | Browser drive + evidence capture                                                 |
| `seed-attention.ts` | The attention block's board, cards and the run's ask                             |
| `spend.sh`          | The spend pane's own priced instance and its drive (`spend.mjs`)                 |
| `thread.sh`         | The card thread's own asking instance and its drive (`thread.mjs`)               |
| `seed-spend.ts`     | The spend drive's board and the two cards its runs start from                    |
| `repos.sh`          | The repositories page's own instance, checkouts and drive (`repos.mjs`)          |
| `board-create.sh`   | The New board form's own instance, empty database and drive (`board-create.mjs`) |
| `first-run.sh`      | The first run's own instance, empty database and drive (`first-run.mjs`)         |
| `board-settings.sh` | The settings page's own instance (a role model) and drive (`board-settings.mjs`) |
| `backend.sh`        | The anthropic-inferred instance, no banner, and the model (`backend.mjs`)        |
| `history.sh`        | A long history's own short-idle instance and its drive (`history.mjs`)           |
| `auth.sh`           | An API that requires a token, two dashboards and the drive (`auth.mjs`)          |
| `model.sh`          | The model picker's own instance (`DEFAULT_MODEL`) and drive (`model.mjs`)        |
| `session-new.sh`    | The New session form's own instance, checkouts and drive (`session-new.mjs`)     |
| `pr.sh`             | Open pull request's own instance, fake GitHub and drive (`pr.mjs`)               |
| `features/`         | Feature map: what each user-facing feature is and how to prove it                |

## Feature map

Start at `features/README.md`. It lists what exists and whether it currently passes.
