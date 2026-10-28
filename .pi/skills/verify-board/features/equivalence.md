# The CLI and the browser are one board

**Status: passing.**

## What it is

A move made with `factory board move` reaches a dashboard page that is already open on the card,
without a reload; a move made in that page is what `factory board show` prints next (LOB-87, the
last part of LOB-49). Both are made on the drive's own card, the one it specified, asked about and
answered, between the terminal's move to `planning` and the build.

## How a user reaches it

A person keeps the board open in a browser while a script or a colleague moves the card in a
terminal, then approves the plan in the browser; the terminal reads the card back.

## How the skill drives it

Two halves, in two processes, taking turns through signal files in `.verify/run/both-ways/` (each
written beside and renamed, so neither reads half of one):

1. **Opened.** Before the terminal's move to `planning`, `drive.sh` starts `both-ways.mjs` in the
   background. It opens `/boards/<board>?card=<card>` in headless Chrome, waits for the lane and the
   pane to show the card in `specifying` at the revision `show` printed, sets a `window` marker, and
   signals `opened`.
2. **CLI → browser.** The drive's `board move --to planning` runs in the tmux pane as before; the
   drive signals the column and revision it printed. The page must show the card there — lane and
   pane — within the board's polling, with the marker intact and no main-frame navigation since it
   opened, and the server's `getTask` must agree.
3. **The refusal, while it is open.** The run's refused `planning → building`, `show`, and `web.mjs`
   (a page of its own) happen next. The open page must still show `planning` at the same revision,
   and offer `building` marked `plan approval`, enabled.
4. **Browser → CLI.** The drive signals the page to approve the plan. The page clicks
   `[data-move-to=building]`; its one `moveTask` request must carry the card, `to: building`, the
   revision it rendered and the dashboard's actor (`dashboard`, a person, B5); the lane, the pane and
   the server must reach `building` one revision on. The drive then types `factory board show` and
   requires `column building` and that revision, the same one the page signalled.

`both-ways.mjs` exits non-zero when any of its checks fail, and `drive.sh` folds that exit code in
beside its own checks on each leg. A page that never opens, dies, or is late is a failed check, never
a hang: every wait is bounded, and the drive's waits end early once the page's process is gone. If
the browser did not approve the plan, the drive approves it from the terminal so the build phase
still proves what it proves — the drive has failed already.

### A new card, both ways (LOB-275)

The same equivalence for a card being made: after the plan approval, `drive.sh` runs
`card-create.sh`, again two halves taking turns through signal files (`.verify/run/card-create/`).
`card-create.mjs` opens the board in one page that is never reloaded and makes a card with the header's
**New card** — on the way, a title of spaces refused inline with nothing sent, and a base ref no run can
start from refused by the server in a toast carrying `createTask`'s message verbatim. Its one landed
`createTask` must be the dashboard's, with the form's inputs and no repo. The terminal then requires
`factory board ls` to list that card under `intake` and `factory board show` to print it as filed, makes
its twin with the same inputs (`factory board add`, LOB-261; `createTask` as the CLI's actor on a tree
without it, the check naming the door), and requires the still-open page to show the twin in `intake`.
Last, `listTasks` must hold the two with the same title, body, repo (the board's), priority and base
ref. See `.pi/skills/verify-web/features/card-create.md` for the form itself.

### The phase: `equivalence.sh`

```sh
DATABASE_URL=… API_PORT=9500 WEB_PORT=3500 APPROVE_PORT=9501 GITHUB_PORT=9503 ./equivalence.sh
```

The surfaces' own drives are run, not duplicated: `.pi/skills/verify-cli`'s `up.sh`/`drive.sh`
(which runs `approve.sh`)/`down.sh`, `.pi/skills/verify-web`'s `up.sh`/`drive.mjs`/`down.sh`, then
this skill's `up.sh`/`drive.sh`/`down.sh`, one at a time — every skill records its API in
`.verify/run/api.pid`, and verify-web's `down.sh` removes `.verify/run` whole. A step whose `up.sh`
fails is failed and its drive is skipped; its `down.sh` always runs. The phase exits non-zero on any
failed step and refuses to start without `DATABASE_URL` or while an instance is up.
`packages/storage-postgres/src/verify-board-equivalence.test.ts` runs the real script against fake
skills: the order, the ports and evidence directories each is handed, and the fold.

## What proves it works

`.verify/evidence/lob-87/` (a copy of `latest/` after `./equivalence.sh` exited 0 on 2026-10-27, its
nine steps green: verify-web **91/91**, the board drive **51/51**) — `board/`: `both-ways.json` (**6/6**: opened, followed without a reload, held
through the refusal, the gate offered, the page's own `moveTask`, the move landed), `both-ways-cli.png`
(the page after the terminal's move), `both-ways-browser.png` (after its own), `show-building.txt` (the
terminal's read of the browser's move), and the drive's `observed.json`. `equivalence.sh` writes
`.verify/evidence/latest/equivalence/observed.json` (every step's exit code) and one log per step;
verify-cli's evidence is under `cli/`, verify-web's under `web/`.

The mutation it was checked against: with `BOARD_POLL` at 600 s in `apps/web`, the drive exits 1
with the CLI → browser leg red (`page specifying r8`, terminal `planning 9`), and the browser leg red
after it.

## What it does not prove

The card pane's own walk — the stale refusal in the pane, a fresh browser context, a run started
from the card — is verify-web's `features/card-pane.md`, run by `equivalence.sh`, not repeated here.
How fast a move arrives: the board polls every 2 s (`BOARD_POLL`), and the wait is bounded at 15 s.
