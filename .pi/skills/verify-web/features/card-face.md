# The card face: run status, PR link and cost

**Status: passing.** A card in a lane answers "what is live, what has a PR, what did it cost"
without opening it (C10; LOB-22 promised a card shows "run status, PR link and cost").

**What it is.** `listBoardCards` (on `TasksRpc`) returns the board's cards in `listTasks`' order,
each with `runCount`, `costTotal` and, when it has had a run, `run` (the newest run by `started_at`:
session, `busy` or `idle`, start) and `prUrl`. `TaskService.listCards` is `list` plus three
statements over the board's `task_runs` (counts and spend; the newest run; the newest PR), so a
board costs the same reads whether it holds three cards or three hundred. `boardAtom` calls it
instead of `listTasks`, polled every `BOARD_POLL` (2 s) with the rest of the board.

- **Status** is the newest run's `session_activity.status`; a run whose index row is missing reads
  `idle`, never `busy`. A card with no run has no row at all.
- **PR** is the newest run's PR _that has one_ (`sessions.pr_url`), not necessarily the newest
  run's: a later run does not take the link away. The anchor is the session pane's own `prLink`
  (`PR #<n>`, `http(s)` only, `href` verbatim), a sibling of the card's link, never inside it.
- **Cost** is the sum of every run's `session_activity.cost_total`, worded as `/spend` words it
  (`$0.7500`; `no cost reported` for a provider that reports none, as faux does).

**How a user reaches it.** Open a board: `[data-card=<id>] [data-card-runs]` holds
`[data-card-run-status]`, `a[data-card-pr]` and `[data-card-cost]`.

**How the skill drives it.** `./card-face.sh` (own API and dashboard, `FAUX_SLEEP_MS`).
`seed-card-face.ts` makes the board and three cards (`live`, `done`, `bare`); `card-face.mjs` starts
runs over the RPC as **Start run** does. `seed-card-face.ts` writes the PR and cost onto a run's
index rows: the PR step is `pr.sh`'s subject (the drive's is that an existing PR reaches the face),
and faux reports no cost.

**What proves it.** The bare card has no row. `busy` shows within one poll interval of the run
starting. After two runs are marked $0.25 and $0.50 the face reads `$0.7500`, equal to the sum the
drive reads off `listTaskRuns` and `listSessions`. A PR recorded on one run shows as an anchor with the
exact `href` within one poll interval, not nested in the card's link, on one card only. The `busy`
card goes `idle` when the run settles. The page's RPC tags (counted from its own requests) hold
`getServerInfo`, `getBoard`, `listBoardCards`, `listAttention` and none of `getTask`, `listTaskRuns`,
`getSession`, `listSessions`, `listTasks`; after six more cards the tags and the per-window count
are the same.

## Gotchas

- **One PR per card on the face.** A card whose runs opened several PRs shows the newest; the card
  pane lists every run's own.
- **Unit cases.** `card-face-view.test.ts` (wording, `javascript:` refused) and
  `TaskService.test.ts` ("lists a board's cards…", against Postgres) hold the cases a seeded board
  cannot reach.
