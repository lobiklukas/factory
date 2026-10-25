# `factory board move`

**Status: passing.**

## What it is

A declared transition, at the revision the caller last read (docs/board.md B3, B5). `--expect-revision`
is required and has no default: the revision is the only protection against two people clobbering each
other, and a default would silently pick one of them. `--actor` defaults to `cli` — a person; a run's
actor is its session id, and a run cannot cross either human gate.

## How a user reaches it

```sh
factory board move --task tsk_… --to specifying --expect-revision 1
# moved tsk_… to specifying (revision 2)

factory board move --task tsk_… --to planning --expect-revision 1
# error: stale_revision: task tsk_… is at revision 2, not 1: someone moved it first   (exit 1)

factory board move --task tsk_… --to done --expect-revision 2
# error: undeclared_transition: column "specifying" declares no transition to "done"   (exit 1)
```

## How the skill drives it

Three moves, all in tmux: a declared one (exit 0, the new column and revision on stdout), a stale one
(the service's `message` matched verbatim on the pane, exit non-zero), and an undeclared one (both
column names verbatim, exit non-zero). The refused moves must leave the card where it was — the
following `board start` prints the column the declared move put it in.

## What it does not prove

Nothing about the gates as _refusals_: `planning → building` and `review → done` are only reachable
after the drive's card has walked there, and the human-gate refusal is proven in `packages/core`'s
`TaskService` cases. Nor does it prove `requires[]`: gates are checked on exit, and the MVP's
`requires[]` check is a later board issue.
