# Feature map — board

One file per user-facing feature of the board's CLI surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified runs: **2026-10-27**, `agent/LOB-86`, `MODEL_BACKEND=faux` —
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
`./requires.sh` (LOB-80, 2026-10-27, `agent/LOB-80`), API on `:9522`, **24/24** checks passed
(`requires-observed.json`). `./board-create.sh` (LOB-208, 2026-10-27, `agent/LOB-208`), API on
`:9510`, **18/18** checks passed (`create-board.json`). Evidence: `.verify/evidence/latest/board/`.

| Feature                         | Status  | File                         |
| ------------------------------- | ------- | ---------------------------- |
| `factory board create`          | passing | [boards.md](boards.md)       |
| create a card (`createTask`)    | passing | [create.md](create.md)       |
| `factory board ls`              | passing | [ls.md](ls.md)               |
| `factory board show`            | passing | [show.md](show.md)           |
| `factory board move` + refusals | passing | [move.md](move.md)           |
| `factory board start`           | passing | [start.md](start.md)         |
| the board read back in the web  | passing | [dashboard.md](dashboard.md) |
| specify, ask, answer (the card) | passing | [specify.md](specify.md)     |
| build, PR + evidence, merge     | passing | [build.md](build.md)         |
| the ask on the task             | passing | [ask.md](ask.md)             |
| `requires[]` on exit            | passing | [requires.md](requires.md)   |

## Deliberately absent

- **Creating a card from the CLI.** Card creation is a trigger's job (docs/board.md B2): the card is
  the tracker's work item, and `factory board` reads and moves what exists. The drive creates its
  card over the API's `createTask` — the door a trigger uses — for the same reason
  ([create.md](create.md)).
- **Blocking and unblocking by hand.** `blockTask`/`unblockTask` are on the RPC surface with typed
  refusals covered in `packages/core`. B7's block — `needs_input`, set by a run's `ask` and lifted by a
  person's `board comment` — is driven by `drive.sh`'s specify phase ([specify.md](specify.md)) and,
  across a restart, by `ask.sh` ([ask.md](ask.md)).
- **The card pane's own walk.** The dashboard phase only reads what the CLI's refusals left behind
  ([dashboard.md](dashboard.md)); the pane's declared moves, its stale refusal and a move followed
  without a reload are `.pi/skills/verify-web`'s (`features/card-pane.md`).
- **Definition editing.** A definition version is a new row, never an update (B2); nothing in the CLI
  writes `board_definitions`, and the seed ships the default pipeline.
