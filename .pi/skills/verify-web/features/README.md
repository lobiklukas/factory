# Feature map — web dashboard

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive
it with the harness, and what observable end state proves it works.

Status reflects the last verified run (2026-10-28, `chrome`, headless, API `:9510` / web `:3510` —
an agent worktree's port block, not the usual 9100/3100; `drive.mjs` 111/111 required checks
passed, from the `agent/LOB-267` worktree against its own database on 5442, which adds LOB-267's
card-pane checks over a synthetic definition (todo → doing → done, gated; evidence
`card-pane-synthetic-todo.png`, `card-pane-synthetic-doing.png`, [card-pane.md](card-pane.md)) and
reads the default card's expected moves from its pinned definition over the API. The run before it
(2026-10-27, `agent/LOB-210`, 97/97) added LOB-210's five 390 px shell checks
([fork-lineage.md](fork-lineage.md)) and the refused id's back link ([routing.md](routing.md));
`thread.sh` last passed 15/15 on the `agent/LOB-239` worktree). The one console error in
`drive.mjs` is the compaction block's injected 500 ([compaction.md](compaction.md)). An earlier run
failed only the busy-compaction race named
under Known gaps.

| Feature                  | Status  | File                                       |
| ------------------------ | ------- | ------------------------------------------ |
| Dashboard shell renders  | passing | [dashboard-shell.md](dashboard-shell.md)   |
| Routing                  | passing | [routing.md](routing.md)                   |
| Approvals inbox          | passing | [routing.md](routing.md)                   |
| Browser reaches the API  | passing | [api-connectivity.md](api-connectivity.md) |
| Session stream           | passing | [session-stream.md](session-stream.md)     |
| Fork lineage             | passing | [fork-lineage.md](fork-lineage.md)         |
| Transcript               | passing | [transcript.md](transcript.md)             |
| Live tasks               | passing | [live-tasks.md](live-tasks.md)             |
| Compaction from the pane | passing | [compaction.md](compaction.md)             |
| Board lanes              | passing | [board.md](board.md)                       |
| Card pane (write path)   | passing | [card-pane.md](card-pane.md)               |
| What needs a person      | passing | [attention.md](attention.md)               |
| The card's thread        | passing | [thread.md](thread.md) (`thread.sh`)       |
| The session's PR link    | passing | [pr-link.md](pr-link.md)                   |
| Spend by repo and actor  | passing | [spend.md](spend.md) (`spend.sh`)          |
| Repositories             | passing | [repos.md](repos.md) (`repos.sh`)          |
| New card (board page) | passing | [card-create.md](card-create.md) (verify-board's `card-create.sh`) |
| Earlier history          | passing | [history.md](history.md) (`history.sh`)    |

## Known gaps

- **The no-checkout banner (`[data-checkout-warning]`) is unit-tested, not driven (LOB-263).** It sits
  under a board's header ([board.md](board.md)) and a session's ([session-stream.md](session-stream.md)).
- **The board follows moves by polling, every 2 s.** LOB-76's card pane moves cards and starts runs;
  a move made elsewhere reaches an open board within one interval, not instantly; the attention view
  (LOB-77) and the card's thread (LOB-239) poll on the same interval.
- **The busy-compaction check is timing-sensitive.** "a busy session shows the pending state, never
  the verdict" needs the run to turn busy while the compaction is still `requested`; on 2026-10-27 it
  failed once (the summary settled before the run started) and passed on the next run, with no
  change between them. A failure there with `busyStarted=true` and no `requested`+`busy` sample is
  the race, not a regression.
- **`/sandboxes` and `/approvals` are off the rail.** They became panes of a card's run (LOB-76).
  `/sandboxes` still renders its milestone copy (M4), and `drive.mjs` asserts it. `/approvals` is
  every run's pending approvals since LOB-53, reached by URL or from a session pane that is waiting
  on one — not from the rail, where the attention view (LOB-77) is the place for "a person is
  needed". The dashboard seeds its approvals through `requestApproval` (its API is ungated); the
  gated run that parks and resumes is driven by `verify-cli/approve.sh`.
- **The rail's attention badge polls on every page.** The bell shows the length of
  `listAttention` (LOB-271), read through the same atom `/attention` uses, so it adds one 2 s poll
  to every page and none on the every-board `/attention`. A board's view (`?board=`) polls both, and
  the badge there is still the every-board count, not that board's. `drive.mjs` counts `listAttention` among the reads for
  that reason. A push would replace the poll.
- The session API is covered here only through the dashboard. Its contract is proven by
  `.pi/skills/verify-api`, which drives the real Effect RPC client directly; neither replaces the
  other, and a change to `packages/domain` or `packages/core` deserves both.
- **A session's pages have no pane.** Neither the dashboard nor the CLI calls `listPages` or
  `curateSession`; the surface is driven over RPC by verify-api's `./pages.sh`
  ([pages.md](../../verify-api/features/pages.md)), so nothing here proves how a page renders.
- **Proposed child issues have no pane.** Nothing in the dashboard calls `proposeDecomposition` or
  renders a snapshot's `proposedIssues` yet (LOB-201); the surface is driven over RPC by verify-api's
  `./decompose.sh` ([decompose.md](../../verify-api/features/decompose.md)).
- `drive.mjs` has no case for a **historical** read. `SESSION_IDLE_TIMEOUT_MS` is deliberately long
  in `up.sh` so the pane stays live; the one historical read the dashboard is driven through is a long
  session's earlier history, by `history.sh` on an instance of its own
  ([history.md](history.md)).
- **A compaction's spend is a delta between two readings of the session's usage**, not a number the
  server attributed to the action. It is bound to the first summary after the press and frozen once
  measured, so a compaction this pane did not press — the harness's own threshold policy, or a second
  summary the same press did not write — shows no spend. See [compaction.md](compaction.md).
- **"Nothing to compact" is read from the live-task list, not answered by the RPC.**
  `compactSession` cannot say that nothing happened, so the pane watches the task it admitted leave
  the session's task projection and only then reads the transcript; a verdict stays until the next
  press or the operator's next turn. A press can only be made on an idle session, so the pending
  state it proves is a live compaction task, not a live run. See [compaction.md](compaction.md).
- **The transcript's follow-the-stream behaviour is not driven.** The faux run finishes too fast to
  observe it; it is checked by hand (see `transcript.md`).
- The browser path needs Postgres on host port 5442; sessions are logs, and the log is Postgres.
  `./up.sh` asks the port first and only starts one when nothing answers, so it runs from a ralph
  worktree while another project's container holds 5442 (LOB-57).
- Isolation is not verifiable locally at all. See `docs/design.md` R2 — kind cannot run gVisor,
  so never cite a local run as evidence that sandboxing works.
