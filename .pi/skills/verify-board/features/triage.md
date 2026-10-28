# `factory board block | unblock | attention | runs`

**Status: passing.**

## What it is

The four board reads and writes an operator needs to triage from a terminal (LOB-264), each over an
RPC that already existed: `blockTask`, `unblockTask`, `listAttention` and `listTaskRuns`.

- `block` parks a card for a reason (`dependency`, `needs_input`, `capability`, `transient`) with an
  optional `--note` (a fifth reason, `setup_failed`, is a run's own block when its worktree's setup
  failed, S-env-setup; a person unblocks it like any other); `unblock` lifts it and the card is back in the column it blocked from.
  `--expect-revision` is optional on both: named, it is sent as named and a stale one is the server's
  `stale_revision`; omitted, the command reads the card and uses its current revision (`move` still
  requires one, because a move is a decision taken from a read).
- `attention` prints what needs a person, on every board or one (`--board`), in the order the server
  answered: approvals, then questions, then gates. Each entry is a row (`reason  task  repo  column
rN  title`, the card id second) and an indented line with the reason's facts.
- `runs` prints a card's runs newest first: session id, column, the session's status, its PR URL
  (`-` when none) and when it started. The status and PR are read from `getSession` per run, because
  the run index carries neither; a session the server says is gone reads `missing`.

## How a user reaches it

```sh
factory board block --task tsk_… --reason dependency --note "waiting on the schema PR"
factory board unblock --task tsk_…
factory board attention [--board brd_…]
factory board runs --task tsk_…
```

## How the skill drives it

- `drive.sh`, in the tmux terminal, on the drive's own card: `attention` lists it as a `question` row
  with the run's question under it (and `--board` narrows it, a malformed `--board` is
  `invalid_input`); `runs` prints three rows newest first, the build run's with the PR the forge
  opened; `block` at a stale revision is `stale_revision`, at the card's revision parks it, a second
  is `already_blocked`, a stale `unblock` is `stale_revision`, and `unblock` restores the card to
  `building`, two revisions on, at which the review move is then made.
- `triage.sh`, plain subprocesses: a card blocked `needs_input` by hand and a card with an idle run at
  the plan approval gate are the `question` and `gate` rows, in that order — the gate row naming
  `plan_doc` as needed first, since the idle run posted no plan (D10); `unblock` takes the card
  off the list; an unknown `--reason`, a malformed `--task`, `unblock` on a card that is not blocked,
  and `runs` on a card with no run.
- `apps/cli/src/commands/board.test.ts`: the revision each write expects (named or read), the stale
  conflict and its printed form, every reason's row and detail line, and `runs`' rows and `missing`.

## What it does not prove

An `approval` row: it needs a gated deployment (`APPROVAL_REQUIRED`), which `verify-cli`'s
`approve.sh` runs; here its row is covered by the unit test only.
