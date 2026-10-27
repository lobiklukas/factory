# `factory board ls`

**Status: passing.**

## What it is

The board's lanes, read from the definition the board instance binds, with each lane's cards under
it (docs/board.md B2, B9). One line per column, in the order the pinned definition version declares
them — never the order the rows happen to come back in, because lane order is a decision the
definition made.

## How a user reaches it

```sh
factory board ls --board brd_0123456789abcdefghjkmnpqrs
```

```
Default pipeline  verify-board/ab12cd  v3
intake  resting  1
  tsk_…  normal  verify-board card
specifying  working  0
planning  working  0
…
```

## How the skill drives it

`drive.sh` runs the command in tmux against the seeded board and asserts:

- it exits 0;
- the lane lines' names, concatenated, are exactly `intake specifying planning building review done
canceled` — the seeded definition's order;
- the drive's card (created by `create.ts` a moment before) is the line directly under
  `intake  resting  1`, so the card is in its own lane.

## What it does not prove

Nothing about a board _definition_ the seed did not ship: `getBoard` returns whatever the instance
binds, and the drive reads the newest version (v3), the one `./up.sh` seeds. Moving a card between boards, or a definition edited in place,
is not reachable through the CLI at all — a definition version is a new row (B2).
