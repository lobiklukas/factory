# Feature map — board

One file per user-facing feature of the board's CLI surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified runs: **2026-10-27**, `agent/LOB-84`, `MODEL_BACKEND=faux` —
`./drive.sh` in tmux, API on `:9560`, web on `:3560`, **21/21** required drive checks passed
(`observed.json` beside the raw panes), with `create.ts`'s **2/2** (`create.json`) and `web.mjs`'s
**3/3** (`web.json`, `web-board.png`) folded in, twice against one `./up.sh` instance; `./ask.sh`, API
on `:9561` across two processes, **14/14** drive checks and **10/10** probe checks passed
(`ask-observed.json`; the probes' `ask-busy.json`, `ask-parked.json`, `ask-told.json`). Evidence:
`.verify/evidence/latest/board/`.

| Feature                         | Status  | File                         |
| ------------------------------- | ------- | ---------------------------- |
| create a card (`createTask`)    | passing | [create.md](create.md)       |
| `factory board ls`              | passing | [ls.md](ls.md)               |
| `factory board show`            | passing | [show.md](show.md)           |
| `factory board move` + refusals | passing | [move.md](move.md)           |
| `factory board start`           | passing | [start.md](start.md)         |
| the board read back in the web  | passing | [dashboard.md](dashboard.md) |
| the ask on the task             | passing | [ask.md](ask.md)             |

## Deliberately absent

- **Creating a card from the CLI.** Card creation is a trigger's job (docs/board.md B2): the card is
  the tracker's work item, and `factory board` reads and moves what exists. The drive creates its
  card over the API's `createTask` — the door a trigger uses — for the same reason
  ([create.md](create.md)).
- **Blocking and unblocking by hand.** `blockTask`/`unblockTask` are on the RPC surface with typed
  refusals covered in `packages/core`. B7's block — `needs_input`, set by a run's `ask` and lifted by a
  person's `board comment` — is driven by `ask.sh` ([ask.md](ask.md)).
- **The card pane's own walk.** The dashboard phase only reads what the CLI's refusals left behind
  ([dashboard.md](dashboard.md)); the pane's declared moves, its stale refusal and a move followed
  without a reload are `.pi/skills/verify-web`'s (`features/card-pane.md`).
- **Definition editing.** A definition version is a new row, never an update (B2); nothing in the CLI
  writes `board_definitions`, and the seed ships the default pipeline.
