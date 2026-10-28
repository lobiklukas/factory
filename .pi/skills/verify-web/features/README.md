# Feature map — web dashboard

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive
it with the harness, and what observable end state proves it works.

Status reflects the last verified run (2026-10-28, `chrome`, headless, API `:9550` / web `:3550`;
`drive.mjs` 119/119 required checks passed from the `agent/LOB-272` worktree, which adds LOB-272's
faux banner on `/sessions`, a board and `/spend`, and the session's model in its pane header and row
([backend-badge.md](backend-badge.md)); `backend.sh` (API `:9551`, web `:3551`, an inferred-anthropic
instance under a dummy key) passed 10/10: no banner after the page's own `getServerInfo` read, and
`anthropic/claude-sonnet-5-5` in the pane header and row). The run before it (`agent/LOB-254`, API
`:9613` / web `:3610`, 112/112) added LOB-254's
card-pane link to the issue a card was filed from (evidence `card-pane-external-link.png`,
[card-pane.md](card-pane.md)). The run before it (`agent/LOB-267`, 111/111) added LOB-267's
card-pane checks over a synthetic definition (todo → doing → done, gated; evidence
`card-pane-synthetic-todo.png`, `card-pane-synthetic-doing.png`, [card-pane.md](card-pane.md)) and
reads the default card's expected moves from its pinned definition over the API. The run before it
(2026-10-27, `agent/LOB-210`, 97/97) added LOB-210's five 390 px shell checks
([fork-lineage.md](fork-lineage.md)) and the refused id's back link ([routing.md](routing.md));
`thread.sh` last passed 15/15 on the `agent/LOB-239` worktree). The one console error in
`drive.mjs` is the compaction block's injected 500 ([compaction.md](compaction.md)). An earlier run
failed only the busy-compaction race named
under Known gaps.

`session-new.sh` (the New session form, E6) last passed **16/16** on 2026-10-28 from the `agent/E6`
worktree, API `:9501` / web `:3501`; there `drive.mjs` (119/119, its session-stream case now typing its
own prompt into the form), `cost.sh` (12/12), `model.sh` (11/11), `spend.sh` (18/18) and `auth.sh`
(6/6) re-passed beside it, as each opens the same form.

`pr.sh` (Open pull request on the session pane and a card's run row, C7) last passed on 2026-10-28
from the `agent/C7` worktree, API `:9570` / web `:3570` / the GitHub fake `:9571`, and
`.pi/skills/verify-board`'s `drive.sh` opened its build run's PR in the browser there
([pr-open.md](pr-open.md)).

`first-run.sh` (the dashboard's front door and getting-started checklist, C9) passed on 2026-10-28 from
the `agent/C9` worktree, API `:9562` / web `:3562`, on an empty throwaway database; `drive.mjs` passed
(API `:9560` / web `:3560`) and `board-create.sh` passed beside it, as the checklist sits on `/boards`.

`board-create.sh` (the New board form, C5) passed **20/20** on 2026-10-28 from the `agent/C5` worktree,
API `:9561` / web `:3561`, on an empty throwaway database; `drive.mjs` passed 120/120 there (API `:9560` /
web `:3560`), its board now made through the form.

`model.sh` (the New session model picker, LOB-274) last passed **11/11** on 2026-10-28 from the
`agent/LOB-274` worktree, API `:9505` / web `:3505`.

`interrupt.sh` (the Interrupt button, C8) last passed **10/10** on 2026-10-28 from the `agent/C8`
worktree, API `:9541` / web `:3541`, `FAUX_SLEEP_MS=4000`.

`card-face.sh` (the card face's run status, PR link and cost, C10) last passed **10/10** on 2026-10-28
from the `agent/C10` worktree, API `:9581` / web `:3581`, `FAUX_SLEEP_MS=5000`. `drive.mjs` re-passed there
(120 checks, 0 failed) once `listBoardCards` joined its read allowlist.

`exit-checklist.sh` (a column's exit checklist in the card pane, D9) last passed **12/12** on 2026-10-28 from the
`agent/D9` worktree, API `:9560` / web `:3560`; the pane re-reads on the 10 s `EXIT_POLL`.

`card-edit.sh` (the card pane's block, unblock, urgent flag and title edit, C11) last passed **11/11** on
2026-10-28 from the `agent/C11` worktree, API `:9582` / web `:3582`.

`board-settings.sh` (the board settings page and each lane's disclosure, LOB-245) last passed **28/28** on
2026-10-28 from the `agent/C22` worktree, API `:9520` / web `:3520`, with each column's effective autonomy
shown and a run in a gated column parked on its approval (C22). Before it, 23/23 from `agent/D3`, where
`drive.mjs` re-passed (API `:9541` / web `:3541`), its lane-control count leaving the settings disclosure out.

`definition-edit.sh` (edit a board definition as a new version, D6) last passed **18/18** on 2026-10-28
from the `agent/D6` worktree, API `:9512` / web `:3512`; `board-settings.sh` re-passed there beside it.

`skills.sh` (the skill pages, D8) last passed **21/21** on 2026-10-28 from the `agent/D8` worktree,
API `:9541` / web `:3541`, on a throwaway database; `board-settings.sh` re-passed there (23/23, API `:9541` /
web `:3541`) with each column's skills now links.

`cost.sh` (cost prediction on the New session form and `/spend`, LOB-38) last passed **12/12** on
2026-10-28 from the `agent/LOB-38` worktree, API `:9552` / web `:3552`; `spend.sh` and `model.sh`
re-passed there beside it, as the strip and the form sit on their pages.

| Feature                      | Status  | File                                                                          |
| ---------------------------- | ------- | ----------------------------------------------------------------------------- |
| Dashboard shell renders      | passing | [dashboard-shell.md](dashboard-shell.md)                                      |
| Routing                      | passing | [routing.md](routing.md)                                                      |
| Approvals inbox              | passing | [routing.md](routing.md)                                                      |
| Browser reaches the API      | passing | [api-connectivity.md](api-connectivity.md)                                    |
| Session stream               | passing | [session-stream.md](session-stream.md)                                        |
| Fork lineage                 | passing | [fork-lineage.md](fork-lineage.md)                                            |
| Transcript                   | passing | [transcript.md](transcript.md)                                                |
| Live tasks                   | passing | [live-tasks.md](live-tasks.md)                                                |
| Compaction from the pane     | passing | [compaction.md](compaction.md)                                                |
| Board lanes                  | passing | [board.md](board.md)                                                          |
| Board settings               | passing | [board-settings.md](board-settings.md) (`board-settings.sh`)                  |
| Definition editor            | passing | [definition-edit.md](definition-edit.md) (`definition-edit.sh`)               |
| Skill pages                  | passing | [skills.md](skills.md) (`skills.sh`)                                          |
| Card pane (write path)       | passing | [card-pane.md](card-pane.md)                                                  |
| What needs a person          | passing | [attention.md](attention.md)                                                  |
| The card's thread            | passing | [thread.md](thread.md) (`thread.sh`)                                          |
| The session's PR link        | passing | [pr-link.md](pr-link.md)                                                      |
| Open pull request            | passing | [pr-open.md](pr-open.md) (`pr.sh`)                                            |
| Spend by repo and actor      | passing | [spend.md](spend.md) (`spend.sh`)                                             |
| Repositories                 | passing | [repos.md](repos.md) (`repos.sh`)                                             |
| Triggers                     | passing | [triggers.md](triggers.md) (`triggers.sh`)                                    |
| New board (boards page)      | passing | [board-create.md](board-create.md) (`board-create.sh`)                        |
| First run (checklist, `/`)   | passing | [first-run.md](first-run.md) (`first-run.sh`)                                 |
| New card (board page)        | passing | [card-create.md](card-create.md) (verify-board's `card-create.sh`)            |
| Earlier history              | passing | [history.md](history.md) (`history.sh`)                                       |
| Model backend and model      | passing | [backend-badge.md](backend-badge.md) (`backend.sh`)                           |
| New session form             | passing | [session-new.md](session-new.md) (`session-new.sh`)                           |
| New session model picker     | passing | [model-picker.md](model-picker.md) (`model.sh`)                               |
| Cost prediction              | passing | [cost.md](cost.md) (`cost.sh`)                                                |
| Interrupt a busy run         | passing | [interrupt.md](interrupt.md) (`interrupt.sh`)                                 |
| Card face (status, PR, cost) | passing | [card-face.md](card-face.md) (`card-face.sh`)                                 |
| Exit checklist               | passing | [exit-checklist.md](exit-checklist.md) (`exit-checklist.sh`)                  |
| Card pane state controls     | passing | [card-edit.md](card-edit.md) (`card-edit.sh`)                                 |
| The dashboard's credential   | passing | verify-api's [identity.md](../../verify-api/features/identity.md) (`auth.sh`) |

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
  `./decompose.sh` ([decompose.md](../../verify-api/features/decompose.md)), and approving them by
  `./approve-proposals.sh` ([approve-proposals.md](../../verify-api/features/approve-proposals.md), LOB-202).
- **Plan revisions have no pane.** Nothing in the dashboard renders a snapshot's `planRevisions` or
  calls `approvePlanRevision` / `declinePlanRevision` yet (LOB-45); the surface is driven over RPC
  and a signed merge by verify-api's `./plan-freshness.sh`
  ([plan-freshness.md](../../verify-api/features/plan-freshness.md)).
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
