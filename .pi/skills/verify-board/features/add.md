# `factory board add`

**Status: passing.**

## What it is

A card put on a board from the terminal (LOB-261): `createTask` over the RPC surface, reached by
`factory board add --board brd_… --title … [--body … | --body-file …] [--repo …] [--priority
urgent|normal] [--base-ref …]`. It prints one line, `task tsk_… revision 1 column intake`, the three
things the next command needs (`board show --task`, `board move --expect-revision`).

The input is exactly what the dashboard's 'New card' form sends (LOB-275): only the fields that were
given, the title trimmed, the body as typed. The server's defaults — the board's repository, `normal`,
no body — are therefore the same whichever door the card came through. `--body-file -` reads stdin;
`--body` with `--body-file` is `invalid_input`.

Refusals: an empty or blank title, an oversize body or base ref, a malformed board id, repo or
priority, and an unreadable body file are `error: invalid_input: …` from the CLI itself, before any
request. An unknown board is the server's `error: board_not_found: no board brd_…`, a repo other than
the board's `board_repo_mismatch`, an unsafe base ref `invalid_task_input` — each printed verbatim,
exit 1.

## How a user reaches it

```
factory board add --board brd_… --title "Pin the Postgres major" --body "Compose names one major."
factory board add --board brd_… --title Release --body-file spec.md --priority urgent --base-ref release
```

## How the skill drives it

`drive.sh`'s first phase types `factory board add` in the tmux pane and reads the pane back:

- the drive's own card (no repo, no priority, a two-line body typed as a `$'…'` word): exit 0 and
  exactly `task tsk_… revision 1 column intake`, which is where the rest of the drive gets its id —
  `board ls`, `show` (which prints the body's two lines), `move` and the runs all act on it;
- a second card with every flag, its body from a file;
- an unknown board: the server's message verbatim and a non-zero exit;
- an empty title, with `--api` pointed at a port nothing listens on: `invalid_input` and a non-zero
  exit, so a request would have been a connection error instead.

`add.ts` then reads what the command made over RPC (`add.json`): the card with no repo carries the
board's repository and the body it was given; a `createTask` naming another repository is
`BoardRepoMismatch`, naming both; a `createTask` with the second card's inputs — the form's call —
lists with the same title, body, repo, priority and base ref as the CLI's card; and the refused
commands wrote no card. That `createTask` is the only direct create in the phase, and it is there to
be compared.

`apps/cli/src/commands/board.test.ts` covers the printed line, the exact input sent (present fields
only, trimmed title), the empty-title and over-limit refusals sending nothing, and the unknown
board's printed refusal and exit code.

## What it does not prove

The web form itself (LOB-275's own drive). The equivalence here is at the RPC both doors call.
