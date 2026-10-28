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
and clicks **Start a session**, requiring the transcript to reach the answer the agent's `bash`
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

| File                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `up.sh`             | Launch isolated API + web, wait for readiness                           |
| `down.sh`           | Stop only what `up.sh` started                                          |
| `doctor.sh`         | Read-only health check of the instance                                  |
| `drive.mjs`         | Browser drive + evidence capture                                        |
| `seed-attention.ts` | The attention block's board, cards and the run's ask                    |
| `spend.sh`          | The spend pane's own priced instance and its drive (`spend.mjs`)        |
| `thread.sh`         | The card thread's own asking instance and its drive (`thread.mjs`)      |
| `seed-spend.ts`     | The spend drive's board and the two cards its runs start from           |
| `repos.sh`          | The repositories page's own instance, checkouts and drive (`repos.mjs`) |
| `features/`         | Feature map: what each user-facing feature is and how to prove it       |

## Feature map

Start at `features/README.md`. It lists what exists and whether it currently passes.
