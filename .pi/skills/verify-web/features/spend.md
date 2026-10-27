# Spend by repo and actor (the spend pane)

**Status: passing.** `/spend` shows what the factory's sessions cost, grouped three ways: **By repo**,
**By actor**, and **By repo and actor** (LOB-162, part 2 of LOB-17). The rail's **Spend** section
(the coins icon) opens it.

## What is shown

The page is `listSpend` (`SessionRpc`) and nothing else. That call is one grouped read of the same
index `listSessions` reads (`sessions ⋈ session_activity`, `GROUP BY repo, actor`), so a session's
cost here is the `costTotal` the sidebar shows for it: both `pi.usage` buckets (LOB-153). No log is
folded (R6).

- **By repo and actor** — `table` rows `tr[data-spend-pair]`, one per pair the server answers,
  costliest first. `data-spend-repo`, `data-spend-actor`, `data-spend-count` and `data-spend-cost`
  carry the values. The cells print the cost as `$0.0400`.
- **By repo** / **By actor** — `[data-spend-group=repo|actor] li[data-spend-line]`. These are the
  pairs added up in the browser (`apps/web/src/lib/spend-view.ts`), so the three blocks cannot
  disagree. The bar behind a line is that line's share of the total.
- **The header** — `[data-spend-total]` is the report's total and its session count.

A session bound to no repo is listed as `scratch`. A session nobody was attributed to is listed as
`unattributed`. Both are marked `data-spend-absent` on their roll-up line and printed in italics. A
cost of exactly zero reads **no cost reported**, not `$0.0000`: pi-ai's faux prices nothing unless
`FAUX_COST` is set (LOB-222's rule). With no sessions at all the page says **No spend recorded**
(`[data-spend-empty]`). The page polls every 5 s (`SPEND_POLL`), and a session started from the
dashboard re-reads it at once.

## Where an actor comes from

The actor is caller-declared, the same way an approval decision's and a board move's actor are:

- `createSession({ actor })` sets it directly.
- `factory run` and `factory board start` send `--actor` (default `cli`).
- The dashboard's **New session** and a card's run send `dashboard`.
- A trigger-started session is `trigger:<source>` (`trigger:linear`, `trigger:github`, …).
- A fork or a replay takes its source's actor.

The log records the actor as the `factory.actor` document, and `sessions.actor` (migration 0019) is
its index, which `rebuildIndexes` refolds. LOB-20's credential will change where the value comes
from, not this shape.

## How to get to it (user POV)

Click the coins icon (**Spend**) in the rail.

## Driving it with spend.sh

`./spend.sh` owns its own API and dashboard (`SPEND_API_PORT`, default 9421, and `SPEND_WEB_PORT`,
default 3421). The API runs a **priced** faux model (`FAUX_COST=0.01`, two requests a run), which
`up.sh`'s instance does not, because a price there would put dollar figures on the compaction
check's spend line. `spend.mjs` requires:

1. **Seed.** Runs on two repos of its own (`verify-spend-<tag>/web`, `…/api`) by two actors of its own
   (`person:amy-<tag>`, `person:bob-<tag>`). Also one `factory run --repo` from the real CLI, which
   exits cleanly, and one session from the dashboard's **New session** button. Each run is waited on
   until the list's `costTotal` equals the snapshot's spend.
2. **Navigation.** The rail's **Spend** opens `/spend` and is marked `aria-current`.
3. **The pair table matches the server.** It is `listSpend`'s rows exactly, in order, with the same
   counts and costs.
4. **This run's pairs.** Each pair the run made, including `…/api × cli`, holds exactly its sessions
   at the sum of their `listSessions` costs. That cost is above zero and printed as dollars.
5. **The roll-ups.** By repo adds every actor on a repo, By actor adds one actor across repos, and
   both add up to the report's totals.
6. **The dashboard's session.** The button's session moved `scratch × dashboard` by exactly one
   session and by its own spend. `scratch` is marked absent, and `dashboard` is a named actor.
7. **Runs started from a card.** `seed-spend.ts` makes a board and two cards in `specifying` on a
   repo of the run's own (`verify-spend-<tag>/board`). `factory board start` on one card puts exactly
   one session under `…/board × cli`, and the card pane's **Start run** on the other puts exactly one
   under `…/board × dashboard`. Neither run is sent a message, so only the count is required.
8. **The header** shows the report's total and count.
9. **Polling.** With the page left open, a run by a new pair appears without a reload.
10. **No console errors.**

Evidence: `.verify/evidence/latest/spend/` holds `spend.png`, `spend-polled.png`, `observed.json`
(every check, the seeded sessions and their spend, the report, the page's rows), `api.log` and
`web.log`.

## Gotchas

- **The pane is global.** It reads every session the database holds, so the drive only asserts the
  pairs it made by name and compares the whole table to the server's answer. It never compares the
  table to a fixed list.
- **The empty state is not driven.** A database with any session cannot show it. It is one
  conditional on `rows.length === 0`.
- **An actor is a declaration, not an identity.** Anyone who can reach the RPC surface can name any
  actor. Verified identity is LOB-20's, and until then the pane is attribution, not accountability.
