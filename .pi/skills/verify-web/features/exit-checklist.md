# The exit checklist: what a card needs to leave its column

**Status: passing.** The card pane lists what the column needs before the card leaves it, and a move
the server would refuse says why before it is clicked (D9; docs/board.md B5, B8).

**What it is.** `getTaskExit` (on `TasksRpc`) returns the card's column and, for each of its
`requires[]` under the card's pinned definition version, in declaration order, `status` `met`,
`unmet` (with `reason`) or `unchecked`. `TaskService.exit` judges each checked key with the same
`requirementVerdict` `move` refuses on (`packages/core/src/requirements.ts`), so a reason listed here
is the sentence a refusal carries, word for word. Keys nothing checks (`plan_doc`, the `human_*`
labels) are `unchecked`, never `met`. Two keys are checked since D9:

- `spec_doc` is met when the card holds a `specified` event (a specifying run's `spec` tool wrote one,
  LOB-238), whatever the spec's gaps.
- `run_completed` is met when the card's _latest_ run's newest turn ended on its own: not still
  working or parked, not a failed or aborted model answer, not interrupted (C8), not stopped by its
  budget (`runTurnOf`, the same log window `runEndingOf` reads for the PR step).

**How a user reaches it.** Open a card: the Move section opens with `[data-exit-checklist=<column>]`,
heading "Leaves <column> when", one `li[data-exit-key][data-exit-status]` per requirement with the
words `met`, `unmet` or `not checked` and, for an unmet one, `[data-exit-reason]`. A move the server
would refuse carries `data-move-unmet="<keys>"` and a list of the keys with their reasons under it
(`[data-move-unmet-note=<to>]`, referenced by the button's `aria-describedby`). The button is not
disabled: the checklist can be a poll behind, so the server's answer to a click stays the decision.
A move into `canceled` checks nothing and is never warned. The read is polled with the board (2 s) and
re-read when a move or a run start from the page lands.

**How the skill drives it.** `./exit-checklist.sh` (own API and dashboard, default `:9561` / `:3561`).
`exit-checklist.mjs` creates a board and a card over the RPC, walks it with `moveTask` as a person, and
declares the spec with `lib/seed-spec.ts` (what a `spec` tool call does, in-process, since no RPC posts
one). The oracle is `getTaskExit`, asked from the drive, never the page.

**What proves it.** In `specifying` with no spec the pane's items (key, status, reason) equal
`getTaskExit`'s; the move to `planning` names `spec_doc` before the click and `canceled` says nothing;
the click's refusal contains the checklist's reason verbatim and the card did not move. After the spec is
declared `spec_doc` turns met within one poll interval, the warning goes, and the same click moves
the card. In `planning` every item reads `not checked` and no move is warned. In `building` with no run
`run_completed`, `non_empty_diff` and `pr_link` are all unmet, equal to the server's, and the move to
`review` names all three.

## Gotchas

- **A faulted, interrupted or unfinished run is not driven in the browser.** The faux backend cannot
  fail a model request, so those turns are `TaskService.test.ts` ("refuses building → review after a
  faulted run…"), `runEnding.test.ts` (`runTurnOf`) and `requirements.test.ts`. The drive's `run_completed`
  is the no-run case; `verify-board/requires.sh` proves a completed run lets the move through.
- **The checklist is the card's column, not the destination's.** A read of another column than the
  card's is hidden rather than shown stale (`currentExit`).
- **`plan_doc` is still unchecked.** Nothing records a plan document yet.
