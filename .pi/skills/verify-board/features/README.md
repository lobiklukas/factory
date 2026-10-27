# Feature map — board

One file per user-facing feature of the board's CLI surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified runs: **2026-10-27**, `agent/LOB-73`, `MODEL_BACKEND=faux` —
`./drive.sh` in tmux, API on `:9520`, **15/15** required checks passed (`observed.json` beside the raw
panes); `./ask.sh`, API on `:9521` across two processes, **14/14** drive checks and **10/10** probe checks
passed (`ask-observed.json`; the probes' `ask-busy.json`, `ask-parked.json`, `ask-told.json`). Evidence:
`.verify/evidence/latest/board/`.

| Feature               | Status  | File                 |
| --------------------- | ------- | -------------------- |
| `factory board ls`    | passing | [ls.md](ls.md)       |
| `factory board show`  | passing | [show.md](show.md)   |
| `factory board move`  | passing | [move.md](move.md)   |
| `factory board start` | passing | [start.md](start.md) |
| the ask on the task   | passing | [ask.md](ask.md)     |

## Deliberately absent

- **Creating a card from the CLI.** Card creation is a trigger's job (docs/board.md B2): the card is
  the tracker's work item, and `factory board` reads and moves what exists. The drive seeds its card
  through `TaskService` for the same reason.
- **Blocking and unblocking by hand.** `blockTask`/`unblockTask` are on the RPC surface with typed
  refusals covered in `packages/core`. B7's block — `needs_input`, set by a run's `ask` and lifted by a
  person's `board comment` — is driven by `ask.sh` ([ask.md](ask.md)).
- **A board UI.** Lanes, cards and the attention view are a later child of LOB-22; `WEB_PORT=3400` is
  reserved for it in this skill's port habit.
- **Definition editing.** A definition version is a new row, never an update (B2); nothing in the CLI
  writes `board_definitions`, and the seed ships the default pipeline.
