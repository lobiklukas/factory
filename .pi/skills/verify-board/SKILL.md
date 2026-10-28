---
name: verify-board
description: Drive and prove the factory board — create a board and a card, move it, assert the three refusals (undeclared transition, stale revision, a run crossing a human gate), and take the card through specify → ask → answer → the next run → build → PR with evidence → review → merge, through `factory board create|add|ls|show|move|comment|start|block|unblock|attention|runs`, the run's PR opened when it settles and shown in the browser, read definitions and a board's configuration through `factory board definitions|definition show|list|config`, author a new definition version with `factory board define --file`, in apps/cli against a real control plane in a real tmux terminal, then read the board back in the dashboard, and cross-check the CLI and the browser on one card both ways (`equivalence.sh` runs verify-cli and verify-web too); includes the ask on the task across a restart. Use when asked to verify, test, or show evidence that the board works from the command line, or after changing apps/cli, packages/domain, packages/core's TaskService, or apps/api.
---

# Verify the board

Proves the board's CLI surface the way a person uses it: a real terminal, a real control plane, a
real Postgres, and the text and exit codes read back. Board state lives in rows, so nothing here is
mocked — `seed.ts` creates the board through `TaskService`, the drive adds its card with `factory board add`
(LOB-261), moves it with the command a human would type, and reads
the result back in the dashboard.

This is the skill every later board issue extends; LOB-49's children **must not** create a second
one. The API behind it is proven by `.pi/skills/verify-api` (`features/board.md`), the sessions CLI by
`.pi/skills/verify-cli`, the dashboard by `.pi/skills/verify-web`. All of them start their own
instance of `apps/api` and record it in `.verify/run/api.pid`, so run them one at a time.

## What it proves

| Feature                          | Check in the driver                                                                                                                                                                                        | Why it matters                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `board create` (B2, LOB-208)     | `board-create.sh`: newest version unless named, `ls`, a run told its skill, refusals                                                                                                                       | a board is a real operation, not a row a test inserts                |
| `board add` (B3, LOB-261)        | `drive.sh`: prints `task tsk_… revision 1 column intake`; unknown board and empty title refused                                                                                                            | an operator puts work on a board from the terminal                   |
| a card's repo (B2, LOB-255)      | `add.ts`: no repo named, the board's inherited; another refused; `build.ts`: run bound                                                                                                                     | a card made without a repo still gets a branch and reaches review    |
| CLI card = form card (LOB-261)   | `add.ts`: `board add` and `createTask` with the same inputs list the same title, body, repo                                                                                                                | both doors of the board make the same card                           |
| create a card (B2, LOB-84)       | `create.ts` (`triage.sh`, `board-create.sh`): `createTask` opens it in `intake` at r1                                                                                                                      | a trigger's card is a real row the board reads back                  |
| `board ls` (B9, LOB-61)          | every lane printed, in definition order, exit 0                                                                                                                                                            | the lane order is the definition's, not the DB's                     |
| a card in its lane               | the created card is the row under `intake`                                                                                                                                                                 | lanes and cards come from one read, so they agree                    |
| `board show`                     | revision and title printed, exit 0                                                                                                                                                                         | one card as the server has it                                        |
| `board move` (B5)                | a declared move prints the new column and revision, exit 0                                                                                                                                                 | the write path is real, at the revision it expected                  |
| refusal: a stale revision (B3)   | the service's message verbatim, non-zero exit                                                                                                                                                              | a script can tell a refusal from a success                           |
| refusal: an undeclared move (B5) | names both columns verbatim, non-zero exit                                                                                                                                                                 | the refusal is typed, not generic prose                              |
| `board block\|unblock` (LOB-264) | `drive.sh`: stale, parked, already_blocked, stale unblock, restored to `building`                                                                                                                          | a person's triage writes are typed, at a revision                    |
| `board attention` (LOB-264)      | `drive.sh`: the asked card's `question` row; `triage.sh`: a `gate` row, server order                                                                                                                       | a person finds what waits on them without the browser                |
| `board runs` (LOB-264)           | `drive.sh`: three runs newest first, the build run's PR link, `-` for runs with none                                                                                                                       | a card's runs, their status and PR, are one command                  |
| `board start` (B1)               | a `ses_…` id, and the card's column on stdout, exit 0                                                                                                                                                      | a run is one session, bound to the card                              |
| the first message (C6)           | `start-prompt.sh`: Start run → Send and `board start` (no `--prompt`): equal first `pi.user`, busy                                                                                                         | a run started with no words is put to work, the same from both doors |
| budget on a run (C23)            | `budget.sh` (`FAUX_COST=0.01 ./up.sh`): `board start --budget` and Start run's Budget field record the cap; a one-cent cap stops the run, **Raise cap** / `factory budget` clear the stop, the run goes on | a card's run can be capped, and a stopped one continued              |
| body and base ref (LOB-260)      | `start-body.sh`: `show` prints them; the run's `task_body` verbatim, its worktree on `release`                                                                                                             | a run starts from the task as filed, at the ref the card names       |
| specify, ask, answer (LOB-85)    | busy, then parked; `needs_input` + question; `comment`; unblocked; next run told                                                                                                                           | the drive's own card is specified and answered before `planning`     |
| the run's spec (LOB-238)         | `spec.ts`: refused without `gaps`, retried; log + `getTaskSpec`; `show`; `spec-pane.mjs`                                                                                                                   | a specifying run writes the typed spec, and the card shows it        |
| refusal: a run at a gate (B5)    | that session as `--actor` on `planning → building`: code + message verbatim                                                                                                                                | only a person crosses plan approval, and the refusal names the gate  |
| the refusals wrote nothing       | `board show` after them: the last accepted column and revision                                                                                                                                             | a refused move is not a half-applied one                             |
| the dashboard agrees (LOB-84)    | `web.mjs`: lane, pane revision, and `building` marked `plan approval`                                                                                                                                      | the browser shows what the CLI left, and offers a person the gate    |
| CLI ⇄ browser (LOB-87)           | `both-ways.mjs`: an open page follows `board move`; its plan approval is what `show` prints                                                                                                                | the CLI and the browser are one board, on the drive's own card       |
| build, PR, merge (LOB-86, C18)   | a diff; the PR opened on settle (no call) in the fake's ledger, its body's evidence; merge refusal                                                                                                         | the PR and its evidence are real, and only a person reaches `done`   |
| the reviewer's verdict (LOB-241) | `drive.sh`: merge refused, no review ran; signed `opened` → `review.ts`'s reviewer passes; done                                                                                                            | `done` takes a reviewer run's pass on the PR's head, not a note      |
| the ask on the task (B7)         | `ask.sh`: busy, then parked; block + question; restart; answer; next prompt                                                                                                                                | a run that needs a person ends, and the answer reaches the next run  |
| `requires[]` on exit (B8)        | `requires.sh`: specifying refused with no spec; building refused with no run, no diff; PR on settle; review per-head                                                                                       | a refusal names the requirement; evidence is a condition of the move |
| a card's one branch + PR (C19)   | `requires.sh`: a 2nd building run on the 1st's branch, its PR `already-open`; review run has diff                                                                                                          | a later run works on the card's change, and the card keeps one PR    |
| a new card, both ways (LOB-275)  | `card-create.sh`: the board page's New card is what `ls`/`show` list; `board add`'s twin shows                                                                                                             | a card made in either surface is the same card in the other          |
| the surfaces' drives (LOB-87)    | `equivalence.sh`: verify-cli, verify-web, then this drive, one at a time                                                                                                                                   | the equivalence holds with both surfaces' own drives green           |
| definitions and config (LOB-270) | `definitions.sh`: `definitions`, `definition show`, `list`, `config`; v3 against a golden                                                                                                                  | an operator sees what a board will do before trusting it             |
| authoring a definition (D4)      | `define.sh`: `--dry-run` writes nothing; v1 then v2 as new rows only; 8 refusals by field                                                                                                                  | the pipeline changes without a migration, and never in place         |
| caps and WIP limits (LOB-71)     | `caps.sh`: task, board, repo and column caps refused by name, nothing written; v2's threshold                                                                                                              | a definition's caps bound the runs in flight, per pinned version     |

Every check is required: `drive.sh`, `ask.sh`, `requires.sh`, `board-create.sh`, `definitions.sh`, `define.sh`, `triage.sh`, `start-body.sh`,
`start-prompt.sh`, `budget.sh`, `caps.sh`, `card-create.sh` and `equivalence.sh` each exit non-zero when one fails, and `drive.sh` folds `add.ts`'s, `ask.ts`'s and `spec.ts`'s (its
specify phase), `spec-pane.mjs`'s, `web.mjs`'s, `both-ways.mjs`'s, `card-create.sh`'s (itself folding
`card-create.mjs`'s) and `build.ts`'s (its build phase) exit codes into its own.

## Launch

```sh
./up.sh          # api on :9400, web on :3400, GitHub fake on :9403, faux model (sleeps, then asks;
                 # the builder role's writes and verifies), one board seeded over a fixture checkout
BOARD_GITHUB=off ./up.sh   # no forge and no credential: the drive's PR phase must fail, naming why
./doctor.sh      # read-only; fails loudly when Postgres on 5442 is down
./down.sh        # stops only what up.sh started, plus the drive's tmux server
```

`up.sh` needs Postgres on host port 5442 — the cards _are_ rows. It asks the port before it asks
compose (`docker compose up -d --wait postgres`), because compose derives its project name from the
directory it runs in and a ralph worktree asking for 5442 a second time fights the human's container
(LOB-57). It waits for **`/readyz`**, not `GET /`: the API binds its server before its migrations are
applied (LOB-21), so `/` answers a moment before a card can be read.

`seed.ts` makes the board through `TaskService.createBoard` (LOB-208) — the writer `factory board
create` reaches — over the seeded `default` definition at its newest version
(`SEED_DEFINITION_VERSION=newest`, so `review` declares `verified`; `SEED_CARD=0`, so no card), over a
repository it registers through the API's `registerRepo` with `.verify/run/board-repo` as its checkout
(`SEED_REPO_ROOT`): a fixture with a passing `verify-web` skill, so a run on the board is a git
worktree with a branch the PR step can publish. The drive's `board add` names no repository on the card: it
inherits the board's (LOB-255), so the drive's build run is a worktree of the fixture with no repo
seeded on the card, and a second create naming another repository is refused as
`BoardRepoMismatch`. It prints one JSON line into `.verify/run/board.json`, which `doctor.sh`
and `drive.sh` read. The drive's card is its own, made by `factory board add` (`add.ts` reads it back) at the start of
every drive, so the drive can run twice against one instance — even after a drive that failed
part-way, because the checks find the drive's card by id in its lane rather than as the lane's only
card; `ask.sh` calls `seed.ts` without
`SEED_CARD=0` and gets a board and a card from the service (so `task_events` gets its `created` row).
`MODEL_BACKEND=faux` keeps `board start` offline: the session, its worktree and its `factory.task`
document are real; only the model behind it is scripted. It is pinned, not read from the caller:
`ROLE_MODELS=builder=faux/builder` names a model only the faux backend serves. The script is the specify phase's
(LOB-85): `FAUX_COMMAND="sleep 8; echo faux-ok"` holds a run's turn open so it is provably busy, and
`FAUX_ASK` is the question a run asks when its prompt carries no task thread yet, recorded in
`.verify/run/faux-ask` for `drive.sh`. `FAUX_ASK` can be overridden; `FAUX_COMMAND` is fixed, and an
exported one is ignored, because the probes need its sleep (the busy control) and its `faux-ok` (the
read was not refused). The 8 s leaves the busy probe, which starts after `board start` returns, the
tmux round-trip and a cold `bun`, several seconds of margin under load. A run on an answered card
never asks. `FAUX_SPEC` (LOB-238, fixed like `FAUX_COMMAND`) is the specifier's `spec` calls: a first
attempt without `gaps`, then the complete spec, which is recorded in `.verify/run/faux-spec`; only a
run offered the tool — one whose column declares the `specifier` role — ever makes them.

The build phase (LOB-86) needs a run of another kind on the same instance: under faux a model is its
script, so `ROLE_MODELS=builder=faux/builder` gives the `building` column's role its own model, and
`FAUX_MODEL_SCRIPTS`' `builder` row makes that model write `apps/web/src/card.ts`, commit it on the
run's branch and call `verify`. Both are fixed, like `FAUX_COMMAND`. The PR goes to the loopback GitHub
fake (`.pi/skills/verify-api/github-fake.ts`) on `GITHUB_PORT` (9403), its ledger in
`.verify/run/github-ledger.json`; the API is started with `GITHUB_API_URL` at it, a fake `GITHUB_TOKEN`,
and every GitHub variable of the caller's shell unset. `BOARD_GITHUB=off` starts no fake and gives no
token (and a closed loopback port as the forge): the case in which the drive must fail.

The review phase (LOB-241) needs a third: `ROLE_MODELS`' `reviewer=faux/reviewer` row, whose
`FAUX_MODEL_SCRIPTS` row reads the diff, and `FAUX_REVIEW`, its clean pass. The fake forge sends no
webhooks, so `review.ts` signs the PR's `pull_request` itself with the instance's
`GITHUB_WEBHOOK_SECRET` — a fresh value per `up.sh`, in `.verify/run/webhook-secret` — and the review
trigger opens the reviewer run on the card exactly as for GitHub's own delivery. The instance has no
reviewer identity (`GITHUB_REVIEWER_*` unset with the rest), and a clean pass posts nothing anyway.

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
./requires.sh    # standalone: its own API on REQUIRES_PORT (default 9402) and GitHub fake on REQUIRES_GITHUB_PORT (9404), five runs on one card
./board-create.sh  # requires the instance from ./up.sh, and DATABASE_URL naming its database
./definitions.sh   # requires the instance from ./up.sh, and DATABASE_URL naming its database
./define.sh        # requires the instance from ./up.sh, and DATABASE_URL naming its database: authoring a definition version (D4)
./triage.sh      # requires the instance from ./up.sh: attention's question and gate rows, block/unblock refusals
./start-body.sh  # requires the instance from ./up.sh, and DATABASE_URL naming its database: a card's body and base ref in its run
./caps.sh        # requires the instance from ./up.sh, and DATABASE_URL naming its database: board caps and WIP limits (LOB-71)
./start-prompt.sh # requires the instance from ./up.sh (API and web): Start run + Send ⇄ `board start` with no --prompt, equal first message
./budget.sh      # requires the instance from `FAUX_COST=0.01 ./up.sh` (API and web): `board start --budget`, Start run's Budget field, a stopped run's Raise cap, `factory budget` (C23)
./card-create.sh # requires the instance from ./up.sh (API and web): the New card form ⇄ `board ls|show|add`; drive.sh runs it too
./equivalence.sh   # standalone, no instance up: verify-cli, verify-web, then up/drive/down here
```

`equivalence.sh` (LOB-87) is the CLI-equivalence phase: it runs `.pi/skills/verify-cli`'s and
`.pi/skills/verify-web`'s own drives rather than repeating them, then this skill's `up.sh`, `drive.sh`
and `down.sh`, one instance at a time (they share `.verify/run/api.pid`, and verify-web's `down.sh`
removes `.verify/run`). It takes `DATABASE_URL` (required), `API_PORT`, `WEB_PORT`, `APPROVE_PORT`
(verify-cli's gated instance) and `GITHUB_PORT`, and exits non-zero when any step fails. The
cross-check itself is `drive.sh`'s both-ways phase on the drive's own card. See
`features/equivalence.md`.

`board-create.sh` (LOB-208) makes boards with `factory board create` and reads them back: the
default definition's newest version unless `--definition-version` names one, `board ls` on the made
board, a card and a run on it whose prompt carries the `specifying` column's skill, the
`board_exists` refusal of a second board over one repository, and the two `definition_not_found`
refusals plus a malformed `--repo`. `board-create.ts` reads the newest version
straight from the database (the oracle) and the run's prompt from its log. See `features/boards.md`.

`definitions.sh` (LOB-270) reads the board's configuration from the terminal: `factory board
definitions` (default v1 through the newest), `factory board definition show default --version 3`
(each column's kind, role or `—`, resolved model, skills, requires marked checked or unchecked, and
exits with the human gates marked), compared whole with the hand-written `definitions-v3.expected`
and once more as a tmux pane, the newest by default, `factory board list` and `factory board config`,
and the `definition_not_found`, `board_not_found` and `invalid_input` refusals. The expected models
are `up.sh`'s `ROLE_MODELS`. See `features/definitions.md`.

`define.sh` (D4) authors a definition of its own (`drv<hex>`) with `factory board define --file`:
`--dry-run` validates and writes nothing, the define writes v1 and only v1, the same file again is
`unchanged`, a changed file on stdin writes v2 with v1 untouched (every row read back by
`define.ts` from `board_definitions`, with an md5 of the whole row), `board definitions` lists both,
`board create --definition` pins v2 and `board add` starts a card in its initial column; then the
spec's eight refusals, each `invalid_definition` naming its field and writing nothing, and the CLI's
own `invalid_input` for a file that is not JSON, carries an unknown key, or cannot be read. See
`features/define.md`.

`caps.sh` (LOB-71) proves the board caps and WIP limits from the terminal on boards of its own, over
a definition `caps.ts` writes with two versions (v1 caps 2/1/2 and gives `review` a WIP limit of 1;
v2 caps 3/1/3): a second start on one card refused naming the task cap, a third on a board naming
the board cap, one on a second board over the same repository naming the repo cap, a second in
`review` naming the column, each writing no run, session or log (`caps.ts MODE=writes`); the v2
board takes three and refuses its fourth while the v1 board still refuses its third; and a canceled
card's run frees its slot. Its runs get no prompt, so every one stays in flight. The shared board
`up.sh` seeds pins the newest default version, which caps 2/1/2 since LOB-71, so `triage.sh` cancels
the card whose run it leaves idle. See `features/caps.md`.

`triage.sh` (LOB-264) proves `factory board attention` and the by-hand `block`/`unblock` on two cards of
its own: one blocked `needs_input` with a note (a `question` row) and one with an idle run in
`planning` (a `gate` row), printed in the server's order, then the unblock, a bad `--reason`, a bad
`--task`, `unblock` on an unblocked card, and `runs` on a card with none. `drive.sh` carries the rest
in its tmux terminal (`runs` with the PR link, the stale and repeated refusals). See
`features/triage.md`.

`requires.sh` (LOB-80, LOB-240) walks a card on the newest `default` definition into `building` and
proves `specifying`'s `spec_doc` (refused with no spec, let through once a run declared one), and `building`'s `run_completed` (refused with no run), `non_empty_diff` and `pr_link` requirements from the terminal — refused with no
run, and let through once the builder run's settle opened its PR on a loopback GitHub fake, after a
second builder run that continued the first's branch and adopted its PR, `already-open` (C19) — and then `review`'s `verified` requirement: refused with no evidence, refused again when the
card's latest change (`api`) is unverified even though an earlier run verified `web`, and let through
once `api` passes. Its runs are real sessions bound to the card, verified by the real `verify` tool
over a fixture repo; `requires.ts` seeds the card and reads each run's `verify` record back. See
`features/requires.md`.

`ask.sh` (LOB-73) is two processes on purpose: the run asks in the first, the API is sent SIGTERM,
and the answer and the next run happen in the second — the question and the block are rows, so a
restart between ask and answer must lose neither. Its two non-CLI facts (is the session busy, what
was the next run's recorded prompt) are probed by `ask.ts`. See `features/ask.md`.

Environment: `API_URL` (default `http://localhost:9400`), `WEB_URL` (default the recorded web port),
`EVIDENCE_DIR`. `up.sh` also takes `GITHUB_PORT` and `BOARD_GITHUB` (`fake` | `off`).

The phases, in order: **add** (`factory board add` in the pane, `add.ts` over RPC) → `ls` → `show` → a declared move to
`specifying` → the **stale** refusal (the revision the card had before that move) → the **undeclared**
refusal (`specifying → done`) → `start` (the run, `ses_…`, sent a prompt) → **specify**: the run is
busy, then asks and is parked (`ask.ts`), `show` prints the `needs_input` block and the question,
`comment` answers and lifts it, `show` prints the answer, a second `start` opens the next run and its
recorded prompt quotes the answer verbatim (`ask.ts`; see `features/specify.md`). Around the ask,
the **spec** (LOB-238): the asking run's spec, refused once without `gaps` and then committed, is in
its log and on the card (`spec.ts MODE=declared`) and `show` prints it; the next run's spec, its gaps
closed, replaces it (`spec.ts MODE=closed`), `show` prints `gaps: none`, and the card pane shows it
(`spec-pane.mjs`) → **both ways** opens (LOB-87; `both-ways.mjs` holds the card's pane open in
headless Chrome) → a person's move to `planning` at the revision that `show` printed, which the open
page must follow without a reload → the
**human-gate** refusal (`planning → building` with `--actor <that ses_…>`) → `show` again (the
refusals wrote nothing) → **web** (`web.mjs` in headless Chrome: the card's lane, the pane's revision,
`building` offered and marked `plan approval`) → **build** (LOB-86; see `features/build.md`): a
person's `planning → building` clicked in the open page, which `board show` must print (the end of
both ways for a move; see `features/equivalence.md`) → **both ways, a new card** (LOB-275,
`card-create.sh`): a card made with the board page's New card is what `board ls` and `board show` list,
its twin made at the terminal with the same inputs reaches the still-open page, and the server holds
the two alike → `board start` in `building`, the run's `verify` record (`build.ts`), a
non-empty `git diff main...factory/<run>`, the PR opened in the browser from the card pane's run row (C7, `pr-browser.mjs`; no `factory pr`) and its link checked against the fake's
ledger and body (`build.ts`), `factory ls` showing it → **review**: the run's own `building → review`,
a person's `review → done` refused naming `review_verdict` (no review ran), then a signed
`pull_request` `opened` for the PR (`review.ts`, LOB-241) whose reviewer run records a pass on its head,
read back by `board runs` → **merge**: the run's `review → done` refused at the merge gate, the
person's move to `done`. With no PR path the drive prints `drive: the PR path is missing — <reason>`
and exits non-zero; it never makes up a link.

It runs `factory` in a **private tmux server** (`.verify/run/board-tmux.sock`), so it cannot touch a
tmux session you are using. Each command is typed into the pane and followed by a sentinel the shell
prints (`printf '\n__done_%s:%s\n' marker $?`), so the driver waits for the command to finish rather
than for a delay, and it reads the exit code the sentinel carried. The pane is cleared between
commands: an assertion must not match an earlier command's output.

## Evidence

Written to `.verify/evidence/latest/board/` (override with `EVIDENCE_DIR`), gitignored:

- `add.json` — the drive's cards (`factory board add`'s and the form-equivalent one) read back, the equivalence, and the add phase's checks
- `add.txt`, `add-pair.txt`, `add-unknown.txt`, `add-empty.txt` — raw panes of `board add`: the drive's card, the card with every flag, and the two refusals
- `create.json` — a card made over `createTask` by `create.ts` (`triage.sh`, `board-create.sh`): the card, its `getTask` read-back and its checks
- `ls.txt`, `show.txt`, `move.txt`, `move-stale.txt`, `move-undeclared.txt`, `start.txt`,
  `show-asked.txt`, `comment.txt`, `show-answered.txt`, `start-next.txt`, `move-planning.txt`,
  `move-gate.txt`, `show-after.txt`, `show-building.txt` (`move-building.txt` only when the browser
  did not approve the plan), `start-build.txt`, `pr.txt`, `ls-pr.txt`,
  `move-review.txt`, `move-merge-unreviewed.txt`, `runs-reviewed.txt`, `move-merge-run.txt`,
  `move-merge.txt`, `show-done.txt` — raw panes, one per phase
- `review-drive.json` — the review phase's probe (LOB-241): the signed delivery and its answer, the
  reviewer session, and the review its log records
- `build-built.json`, `build-pr.json`, `pr-body.md`, `build-diff.txt` — the build phase's probes, the
  PR body as the fake received it, and git's diff of the run's branch
- `specify-busy.json`, `specify-parked.json`, `specify-told.json` — the specify phase's probes:
  their checks and facts, the next run's recorded `task_thread` section among them
- `spec-declared.json`, `spec-closed.json`, `show-specified.txt`, `spec-pane.json`, `spec-pane.png` —
  the spec's probes (each run's `spec` results, its logged spec, the card's `getTaskSpec`), the pane
  after the next run, and the card pane's Spec section as rendered
- `both-ways.json`, `both-ways-cli.png`, `both-ways-browser.png` — the both-ways phase's checks,
  what the open page rendered at each step, its own `moveTask` request, and the page after the
  terminal's move and after its own
- `start-prompt-web.json`, `start-prompt-{form,sent}.png` — `start-prompt.sh`'s checks, both runs' first
  `user` entries and status as `getSession` read them, the page's own writes, and the form and the run
  after Send; `start-prompt.sh` deletes its own before it starts
- `budget-web.json`, `budget-{stopped,raised}.png` — `budget.sh`'s checks, the budgets and spend as
  `getSession` read them, the page's own writes, and the run's pane at its stop and after the raise;
  `budget.sh` deletes its own before it starts
- `card-create.json`, `card-create-web.json`, `card-create-*.png`, `card-create-*.txt` — the new-card
  leg's terminal checks (both card ids), the page's checks with what it
  sent and the oracle's reads, its screenshots, and what `ls`, `show` and `add` printed;
  `card-create.sh` deletes its own before it starts
- `web.json`, `web-board.png` — the dashboard phase's checks, the lanes and pane as rendered, the
  server's `getTask` it was compared with, and the screenshot
- `observed.json` — every check with its detail, the board id, the card id and both session ids.
  `drive.sh` deletes `add.json`, `add{,-pair,-unknown,-empty}.txt`, `specify-*.json`, `spec-*.json`, `spec-pane.png`, `build-*.json`,
  `pr-body.md`, `review-drive.json`, `web.json`, `web-board.png`, `both-ways*` and `observed.json` before it starts,
  so a phase that dies before writing cannot leave an earlier run's passing file behind
- `ask-observed.json`, `ask-{busy,parked,told}.json`, `ask-*.txt`, `ask-api.log` — `ask.sh`'s checks,
  its probes' facts, the CLI outputs and both processes' log
- `requires-observed.json`, `requires-build.json`, `requires-{web,api-unverified,api-verified}.json`,
  `review-requires-{a,b,c,b-again,c-again}.json`, `requires-*.txt`, `requires-api.log` — `requires.sh`'s checks, each
  run's decoded `verify` record, each head's delivery and the review its reviewer recorded, the CLI
  outputs
- `create-board.json`, `create-board-*.txt`, `create-board-prompt.json` — `board-create.sh`'s checks,
  each command with its output, and the run's prompt sections
- `definitions.json`, `definitions-*.txt`, `definitions-*.diff`, `definitions-pane.txt` —
  `definitions.sh`'s checks, each command with its output, the comparisons with the expected
  description, and the tmux pane
- `define.json`, `define-*.txt`, `define-v1.json` — `define.sh`'s checks, each command with its
  output, and the definition file it defined
- `../equivalence/observed.json`, `../equivalence/<step>.log` — `equivalence.sh`'s steps and their
  exit codes; the drives it runs write `../cli/`, `../web/` and this directory

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
  (`human_gate_required`), not a bug. The drive proves both with a run's own id: the plan approval
  before the dashboard phase (so the browser reads a card whose next move is the gate the run was
  refused), and the merge in the build phase, where the person's move then reaches `done`.
- **The board is one per repository.** Every drive against one `./up.sh` instance opens its PR on the
  same repository, so `build.ts` finds this drive's request and PR in the ledger by the run's branch
  (`factory/<run>`), not by being the only one.
- **`board start` sends the card's prompt unless told not to (C6).** Without `--prompt` the run is sent
  the card's default prompt (its title, body and the column's instruction); `--idle` opens the run and
  sends nothing, as `triage.sh` needs for a run that must be idle. The drive and `ask.sh` pass their
  own `--prompt`, so the run's first turn is theirs.
- **The faux asks only once per card.** `FAUX_ASK` makes the script call `ask` when the run was
  offered the tool and its prompt has no `task_thread` yet, so the run after an answer replies instead.
  A phase that starts a run on a card nobody has answered yet will park it; that is the script, not a
  bug.
- **The spec moves the card.** Each accepted `spec` call is a `specified` event, one revision: the
  asking run's question lands a revision later than it would without it, and the move to `planning`
  expects the revision `show` printed after the next run's spec, not after the answer.
- **The answer is typed as a `$'…'` word.** It carries a newline and an em dash so a trimmed or
  re-encoded answer is caught; the pane's shell (bash or zsh) turns the escapes into one argument.
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
