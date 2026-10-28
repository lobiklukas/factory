# Feature map — board

One file per user-facing feature of the board's CLI surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified runs: `factory board add` (LOB-261, 2026-10-28, `agent/LOB-261`), API on
`:9650`, web on `:3650`, the GitHub fake on `:9653`: `./drive.sh` exit 0, **124/124** checks, its card
made in the pane by `factory board add`, with `add.ts`'s **5/5** (`add.json`: the repo inherited, the
body read back, another repo refused, the CLI's card and the form's `createTask` listing the same)
folded in ([add.md](add.md)). Before it, a card created with no repo (LOB-255, 2026-10-28,
`agent/LOB-255`), API on `:9530`, web on `:3530`, the GitHub fake on `:9533`: `./drive.sh` exit 0,
**52/52** required checks, with `create.ts`'s **5/5** (`create.json`: the board's repo inherited, another
refused as `BoardRepoMismatch`, no card written) and `build.ts`'s **4/4** (`build-built.json`: the
build run bound to the board's repo on `factory/<session-id>`) and **8/8** (`build-pr.json`) folded
in — the repo-less card reached review with a PR, then done. Before it, the both-ways phase and `./equivalence.sh` (LOB-87,
2026-10-27, `agent/LOB-87`), API on `:9500`, web on `:3500`, verify-cli's gated API on `:9501`, the
GitHub fake on `:9503`: `./equivalence.sh` exit 0, its nine steps green — verify-cli's drive (with
`approve.sh`), verify-web's `drive.mjs` (**91/91**), then `./drive.sh` **51/51** with `both-ways.mjs`'s
**6/6** (`both-ways.json`) folded in; see [equivalence.md](equivalence.md). Before it, **2026-10-27**, `agent/LOB-86`, `MODEL_BACKEND=faux` —
`./drive.sh` with its build, PR, review and merge phases, API on `:9500`, web on `:3500`, the GitHub
fake on `:9503`, **43/43** required drive checks passed, with `build.ts`'s **3/3** (`build-built.json`)
and **8/8** (`build-pr.json`) folded in, twice against one `./up.sh` instance, and exit 1 naming
`credential_error` under `BOARD_GITHUB=off` ([build.md](build.md)). Before it, `agent/LOB-85` —
`./drive.sh` in tmux, API on `:9500`, web on `:3500`, **30/30** required drive checks passed
(`observed.json` beside the raw panes), with `create.ts`'s **2/2** (`create.json`), the specify
phase's probes' **11/11** (`specify-busy.json`, `specify-parked.json`, `specify-told.json`) and
`web.mjs`'s **3/3** (`web.json`, `web-board.png`) folded in, twice against one `./up.sh` instance;
`./ask.sh`, API on `:9501` across two processes, **14/14** drive checks and **11/11** probe checks
passed (`ask-observed.json`; the probes' `ask-busy.json`, `ask-parked.json`, `ask-told.json`).
The specify phase's spec (LOB-238, 2026-10-27, `agent/LOB-238`), API on `:9520`, web on `:3520`:
`./drive.sh` **35/35** required checks, with `spec.ts`'s **9/9** (`spec-declared.json`, `spec-closed.json`) and
`spec-pane.mjs`'s **4/4** (`spec-pane.json`, `spec-pane.png`) folded in.
`./requires.sh` (LOB-80, 2026-10-27, `agent/LOB-80`), API on `:9522`, **24/24** checks passed
(`requires-observed.json`). `building`'s exit gate (LOB-240, 2026-10-27, `agent/LOB-240`): `./requires.sh`
**24/24** with its building phase (API on `:9511`, GitHub fake on `:9512`), and `./drive.sh` **49/49**
(API on `:9510`, web on `:3510`, GitHub fake on `:9513`) and, under `BOARD_GITHUB=off`, exit 1 with the
card held in `building` by a `pr_link` refusal ([build.md](build.md)). `./board-create.sh` (LOB-208, 2026-10-27, `agent/LOB-208`), API on
`:9510`, **18/18** checks passed (`create-board.json`). `./definitions.sh` (LOB-267, 2026-10-28,
`agent/LOB-267`), API on `:9512`, **31/31** checks passed (`definitions.json`), the tmux pane among
them, with default v4 (LOB-267's seeded transitions) as the newest version. `./start-body.sh` (LOB-260, 2026-10-28, `agent/LOB-260`), API on `:9500`, web on `:3500`, the
GitHub fake on `:9503`: **8/8** checks passed (`start-body.json`), with `body-create.json`'s **4/4** (the refused `$(touch …)` base ref among them) and
`body-told.json`'s **6/6** folded in, and `./drive.sh` exit 0 beside it against the same instance.
The both-ways phase's new-card leg (LOB-275, 2026-10-28, `agent/LOB-275`), API on `:9600`, web on
`:3600`, the GitHub fake on `:9603`: `./drive.sh` exit 0, **66/66**, with `card-create.sh`'s **8/8**
(`card-create.json`) and `card-create.mjs`'s **11/11** (`card-create-web.json`) folded in; an earlier
standalone `./card-create.sh` (10/10 on the page) also passed with LOB-261's `factory board add`
making the twin.
Evidence: `.verify/evidence/latest/board/`.

| Feature                                 | Status  | File                             |
| --------------------------------------- | ------- | -------------------------------- |
| `factory board create`                  | passing | [boards.md](boards.md)           |
| `factory board add`                     | passing | [add.md](add.md)                 |
| create a card (`createTask`)            | passing | [create.md](create.md)           |
| `factory board ls`                      | passing | [ls.md](ls.md)                   |
| `factory board show`                    | passing | [show.md](show.md)               |
| `factory board move` + refusals         | passing | [move.md](move.md)               |
| `factory board start`                   | passing | [start.md](start.md)             |
| a card's body and base ref in its runs  | passing | [body.md](body.md)               |
| `board block\|unblock\|attention\|runs` | passing | [triage.md](triage.md)           |
| the board read back in the web          | passing | [dashboard.md](dashboard.md)     |
| specify, ask, answer (the card)         | passing | [specify.md](specify.md)         |
| build, PR + evidence, merge             | passing | [build.md](build.md)             |
| the specifying run's spec               | passing | [specify.md](specify.md)         |
| the ask on the task                     | passing | [ask.md](ask.md)                 |
| `requires[]` on exit                    | passing | [requires.md](requires.md)       |
| CLI ⇄ browser, one board                | passing | [equivalence.md](equivalence.md) |
| a card made in the browser ⇄ the CLI    | passing | [equivalence.md](equivalence.md) |
| definitions and board config            | passing | [definitions.md](definitions.md) |

## Deliberately absent

- **A trigger's card.** A card from a tracker item is a trigger's job (docs/board.md B2) and is
  `verify-api`'s; the drive's card is a person's, made with `factory board add` ([add.md](add.md)).
  `create.ts` still makes the cards of `triage.sh` and `board-create.sh` over `createTask`
  ([create.md](create.md)).
- **A block's other writers.** B7's block — `needs_input`, set by a run's `ask` and lifted by a
  person's `board comment` — is driven by `drive.sh`'s specify phase ([specify.md](specify.md)) and,
  across a restart, by `ask.sh` ([ask.md](ask.md)); a person's own `board block`/`unblock` is
  [triage.md](triage.md).
- **The card pane's own walk.** The dashboard phase only reads what the CLI's refusals left behind
  ([dashboard.md](dashboard.md)), and the both-ways phase moves the drive's card once each way
  ([equivalence.md](equivalence.md)); the pane's declared moves, its stale refusal, a fresh context
  and a run start are `.pi/skills/verify-web`'s (`features/card-pane.md`), which `./equivalence.sh`
  runs.
- **Definition editing.** A definition version is a new row, never an update (B2); nothing in the CLI
  writes `board_definitions`, and the seed ships the default pipeline. Reading one is
  [definitions.md](definitions.md).
