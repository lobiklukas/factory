# `factory board show`

**Status: passing.**

## What it is

One card, as the server has it: id, board, column, revision, priority, repo, block state and title.
The revision it prints is the token the next `board move` has to carry, so this is the command a
person runs first when a move was refused as stale.

## How a user reaches it

```sh
factory board show --task tsk_0123456789abcdefghjkmnpqrs
```

## How the skill drives it

The driver asserts exit 0, a `revision  <n>` line matching the revision the seed created, and a
`title` line matching the seeded title.

## What it does not prove

Nothing about a card's history. `task_events` is append-only and the card's history is what a gated
move is audited by; reading it needs a `task_events` read the RPC surface does not have yet.
