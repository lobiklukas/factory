# What needs a person (the attention view)

**Status: passing.** `/attention` lists every card a person has to act on, grouped by what they
have to do, each row with the reason in the server's words and a link to the card (LOB-77, part 3
of LOB-22). `/attention?board=<id>` scopes it to one board; the board's header links there, and the
rail's **Needs a person** section opens it for every board.

## What is listed

The rows are `listAttention` (`TasksRpc`), one server read over the indexes — no card, run or
approval is walked from the browser. `TaskService.attention` decides; the page only words it
(`apps/web/src/lib/attention-view.ts`).

- **Approve or deny a request** — a `session_approvals` row with no decision, on a session
  `task_runs` names as a run of the card. Any column, any block. The row's link opens the card with
  `?run=<the session that asked>`, so the pane's Approvals tab holds the request.
  `li[data-attention-reason=approval]`, text `A run asks to <action>[: <detail>]`.
- **An approval of a session no card owns** (LOB-271) — the same `session_approvals` row on a session
  `task_runs` names nowhere: a scratch session gated by `APPROVAL_REQUIRED`. The item has no `task`;
  it carries `sessionTitle` (and `repo` when the session has one), and the row, marked
  `li[data-attention-session]`, is titled by the session and links to `/sessions/<id>`. Text
  `A session asks to <action>[: <detail>]`. It sits in the same group and the same oldest-first
  order as the card-bound approvals. Only the every-board view lists it: a board's view (`?board=`)
  lists that board's cards.
- **Answer a run's question** — the card is blocked `needs_input` (B7). The reason is the newest
  `question` comment asked since the block began (the ask tool's), or the block's note when a person
  blocked it by hand — an answered question from an earlier block never reappears. `li[data-attention-reason=question]`, text `Asked: <question>`. Its link opens the card at `#thread`,
  where the question is answered ([thread.md](thread.md)).
- **Make a person's move** — the card is not blocked, its column's exit crosses a human gate
  (`planning → building` plan approval, `review → done` merge; B5), it has a run started in that
  column, no run of the card is busy (`session_activity`), and no run of the card holds an
  undecided approval (a run parked on one is idle, but is waiting on the decision — it is listed as
  the approval only). `li[data-attention-reason=gate]`, text
  `The <column> run is idle; <column> → <to> is the <gate>, a person's move`. When the exit still
  misses a checked requirement (D10: a planning run that settled without a plan), the server names it
  (`reason.unmet`) and the text is `The <column> run is idle without <keys>; <column> → <to> needs it
  before the <gate>`, because the gate's move would be refused naming the key.

Not listed: a resting card (`intake`), a card in a column with no human gate, a card in a gated
column with no run there yet or with a run still busy, and a card blocked on a `dependency`,
`capability` or `transient` reason — it is waiting on that, not on a person (it is listed only for
an approval its run holds). A card with two reasons is two rows.

With no rows the page says **Nothing needs a person** (`[data-attention-empty]`); a `?board=` the
server does not hold says **No such board**, never the empty state. The view polls with the board
(`BOARD_POLL`, 2 s), so a run that asks, goes idle at a gate, or is answered elsewhere changes it
without a reload.

## How to get to it (user POV)

Click the bell (**Needs a person**) in the rail, or **Needs a person** in a board's header. The
bell carries a count badge (`[data-attention-badge]`) of everything the every-board view lists, a
scratch session's approval included — the number of rows on the every-board `/attention`, from the same atom, so it is never a second
answer there. On a board's view (`?board=`) the badge is still the every-board count while the rows
are that board's, and the page polls both reads. It is absent when nothing waits.

## Driving it with drive.mjs

The block runs after the card pane's, on its own board from `seed-attention.ts` (`MODE=board`): a
resting card, a card blocked `dependency` in `planning`, and cards in `planning`, `specifying` and
`building`. It requires:

1. the dependency-blocked card, given an idle run in `planning` (so it _would_ be at the plan
   approval but for its block), and the resting card to leave the board's view on its empty state,
   with `listAttention` empty too;
2. a run on the `planning` card given a turn (the faux command sleeps ~12 s), a run on the
   `specifying` card that asks (`seed-attention.ts MODE=ask`, the ask tool's own `TaskService.ask`
   with the run as actor), and a `requestApproval` on the `building` card's run;
3. the question and approval rows to appear while the `planning` run is still busy, and the
   `planning` card **not** to be listed while `getSession` says it is busy;
4. once the run finishes, the gate row to appear without a reload, reading `plan approval` and
   `planning → building`; the question row to read `Asked: <the question>` verbatim; the approval row
   to carry the action and its detail;
5. the page's rows to be exactly `listAttention`'s, grouped approval, question, gate, with the
   dependency-blocked and resting cards absent;
6. each row's `href` to be `/boards/<id>?card=<task>` (the approval's with `&run=<session>`, the
   question's with `#thread`, the card pane's thread — [thread.md](thread.md)); a click
   on the gate row to open that card's pane in `planning` with the plan approval marked; the board
   header's **Needs a person** to lead back; a click on the approval row to open the run's tabs;
7. a `commentTask` from the drive (the answer) to drop the question row without a reload;
8. the rail's section to open the every-board view, whose gate row names the board's repository;
9. a scratch session (`createSession` with no card) given a `requestApproval` to be exactly one row
   on the every-board view, linking to `/sessions/<id>` and reading `A session asks to <action>`,
   with the empty state gone; the rail badge, the header count and the number of rows to be the same
   number, equal to `listAttention`'s length; the card-bound rows to be still listed; a board's
   `?board=` view to leave the session out; and a click on the row to open the session;
10. `?board=<an id the server does not hold>` to say **No such board**.

Evidence: `attention-empty.png`, `attention.png`, `attention-card.png`, `attention-all.png`, `attention-scratch.png`, and
`observed.attention`.

## Gotchas

- **The cards' columns are seeded, not walked.** The walk through moves is the card pane's subject;
  here it would make the checks depend on what a move out of `specifying` requires (LOB-80).
- **The question is asked in-process, not by the faux model.** `FAUX_ASK` is an API-wide setting
  and would make every run in the drive ask; `seed-attention.ts` makes the ask tool's own service
  call instead.
- **The gate reads "idle", not "done".** In the MVP a person starts and drives every run, so an
  idle run in a gated column has handed its work back. A run created and not yet given a turn is
  idle too, so a card is at its gate from the moment such a run exists — which is why the row says
  the run _is idle_ rather than claiming it finished; the drive only reads "not at the gate" while it
  has seen the run busy.
- **Known gap: a stale `busy`.** "Busy" is the persisted `session_activity.status`, written best
  effort as turns run and set idle when a session closes gracefully. An API killed mid-turn
  (SIGKILL) leaves the row `busy`, and nothing at boot resets it, so that card stays off its gate
  until another turn on the session or a `rebuildIndexes`. `getSession` reads the live in-memory
  flag instead and is not affected.
- **Cost (R6).** Three statements (four on the every-board read: the card-less approvals) and no log
  fold. The approvals reads use the
  `session_approvals_pending` partial index; the questions and gates reads filter `tasks` by block
  and column, which no index covers, so the every-board view scans `tasks`. That is fine at MVP card
  counts; a partial index on `blocked_reason` is the fix when it is not.
