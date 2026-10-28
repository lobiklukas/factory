# Board caps and WIP limits

**Status: passing.**

## What it is

B9's caps as board policy the definition carries (docs/board.md B9, LOB-71): how many runs may be in
flight at once on one board, on one task, in one repository across every board over it, and started
in one column. A version declares `caps` (`board`, `task`, `repo`; `board_definitions.caps`, migration 0038) and a column its `wipLimit` (inside `columns`). Default version 5 carries B9's numbers — 2 per
board, 1 per task, 2 per repository — and no WIP limit; versions 1–4 cap nothing.

A start (`createSession` with a card, which `factory board start` and the card pane send) is checked
against the caps of the version the **card** pins, in the transaction that writes its rows, under an
advisory lock on the card's repository. Past a cap it is refused `at_capacity` — LOB-70's refusal,
built from a limit and its source — naming what it counted, the definition field the limit lives in,
and the runs holding the slots; the error carries the cap typed (`cap.kind`: `task`, `column`,
`board` or `repo`). Narrowest first: a second run on a full card is the task's cap even when the
board has room. A refused start writes no `task_runs` row and opens no session.

A run is in flight from its start until its session first goes idle (`task_runs.finished_at`), unless
its card is `done` or `canceled`, or its workspace was released, first. A run opened without a prompt
is in flight while it waits: send it its message, discard its session (`factory discard`), or finish
its card, to free its slot. A start that fails after its rows are written (its owner does not open)
ends its run there, so it holds no slot; so does a run a restart finds already settled, and a run
`rebuildIndexes` re-creates. A review run
(LOB-36) counts but is never refused — the PR starts it, and refusing it would lose the review the
merge gate needs. Nothing starts a run on its own: no dispatcher, lease or auto-start comes with this.

## How a user reaches it

```sh
factory board definition show default --version 5
# caps        board 2 · task 1 · repo 2 runs in flight
factory board start --task tsk_…
# error: at_capacity: at capacity: at most 1 run may be in flight on task tsk_… at once
#   (definition default v5 caps.task=1), and 1 is: ses_…; retry once one ends its turn (send it a
#   message if it is waiting for one), is discarded (factory discard <session>), or its card is done
#   or canceled
```

A column with a WIP limit prints `wip       at most N runs in flight` under its exits.

## How the skill drives it

`./caps.sh` against the instance from `./up.sh` (and `DATABASE_URL` naming its database). `caps.ts
MODE=define` writes a definition of the drive's own with two versions, as a migration writes one —
v1 caps 2/1/2 and gives `review` a WIP limit of 1; v2 caps 3/1/3 — and the drive makes boards over it
with `factory board create --definition … --definition-version …`, cards with `factory board add`, and
runs with `factory board start` (no prompt, so every run stays in flight and every count is exact):

1. **read** — `definition show` prints v1's caps line and `review`'s WIP limit, and v2's other caps.
2. **task** — a second start on one card is refused naming `caps.task=1`; the card's runs, the
   session rows and the session logs are counted before and after (`caps.ts MODE=writes`): unchanged.
3. **board** — the third start on a v1 board is refused naming `caps.board=2` and the two runs
   holding it, and writes no `task_runs` row, no session and no log.
4. **repo** — a second board over the same repository (`caps.ts MODE=second-board`: `createBoard`
   makes one per repository) refuses its first start naming `caps.repo=2`.
5. **column** — on another v1 board, a second run in `review` is refused naming
   `columns.review.wipLimit=1` and the column, while a run in `building` goes through.
6. **version** — a v2 board takes three runs and refuses the fourth naming `v2 caps.board=3`, and the
   v1 board still refuses its third naming `v1 caps.board=2`: the threshold is the pinned version's,
   changed by data alone.
7. **freed** — `board move --to canceled` on a card whose run holds a slot frees it: the refused
   start then goes through.

Evidence: `caps-*.txt` (each command and its output) and `caps.json` in `.verify/evidence/latest/board/`.

The core suite proves the rest against Postgres (`packages/core/src/SessionService.test.ts`, "board
caps and WIP limits (LOB-71)"): a burst of concurrent starts admits exactly the cap, a run frees its
slot when its session first goes idle, and a review run is admitted past a full cap and then counted.

## What it does not prove

That anything starts a run on its own: nothing does. The dispatcher that will claim cards under these
caps is wave-2 item 1 (docs/board.md). Nor does it prove a steered run is counted again: a run that
went idle and is sent another message is not in flight as the caps count it.
