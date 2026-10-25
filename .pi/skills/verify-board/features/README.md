# Feature map — board

One file per user-facing feature of the board's CLI surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified run: **2026-10-25**, `ralph/LOB-61`, API on `:9400`,
`MODEL_BACKEND=faux`, `./drive.sh` in tmux — **14/14** required checks passed. Evidence:
`.verify/evidence/latest/board/` (`observed.json` beside the raw panes).

| Feature               | Status  | File                 |
| --------------------- | ------- | -------------------- |
| `factory board ls`    | passing | [ls.md](ls.md)       |
| `factory board show`  | passing | [show.md](show.md)   |
| `factory board move`  | passing | [move.md](move.md)   |
| `factory board start` | passing | [start.md](start.md) |

## Deliberately absent

- **Creating a card from the CLI.** Card creation is a trigger's job (docs/board.md B2): the card is
  the tracker's work item, and `factory board` reads and moves what exists. The drive seeds its card
  through `TaskService` for the same reason.
- **Blocking and unblocking.** `blockTask`/`unblockTask` are on the RPC surface with typed refusals
  covered in `packages/core`; the board's blocking UX (B7's question and answer) belongs to the
  dashboard's card pane.
- **A board UI.** Lanes, cards and the attention view are a later child of LOB-22; `WEB_PORT=3400` is
  reserved for it in this skill's port habit.
- **Definition editing.** A definition version is a new row, never an update (B2); nothing in the CLI
  writes `board_definitions`, and the seed ships the default pipeline.
