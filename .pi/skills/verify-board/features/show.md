# `factory board show`

**Status: passing.**

## What it is

One card, as the server has it: id, board, column, revision, priority, repo, block state (the typed
reason and the column it blocked from) and title, then the card's **thread** — every comment, oldest
first, each under a `[question|answer|note] <actor> (revision n)` header with its body verbatim
(LOB-73). The revision it prints is the token the next `board move` or `board comment` has to carry,
so this is the command a person runs first when a write was refused as stale.

## How a user reaches it

```sh
factory board show --task tsk_0123456789abcdefghjkmnpqrs
```

## How the skill drives it

`drive.sh` asserts exit 0, a `revision  <n>` line matching the revision the seed created, and a
`title` line matching the seeded title. `ask.sh` reads the block line (`needs_input from
specifying`) and the thread — the question a parked run asked, before and after a restart, and the
answer under it ([ask.md](ask.md)).

## What it does not prove

Nothing about a card's full history. The thread is the `commented` slice of `task_events`
(`listTaskComments`); the moves, blocks and priority changes that are the rest of the audit trail have
no read on the RPC surface yet.
