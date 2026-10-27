# Compact now from the pane

**Status: passing.** The header's **Compact** button admits a compaction on the session the pane is
showing; the summary lands in the transcript as a `compaction` row with what the action spent, the
header's own token reading is visible before and after it (LOB-223), and a transcript too short to cut
ends in a visible **Nothing to compact** rather than a spinner that never stops (LOB-224).

## What it is

The browser half of on-demand compaction (B4 in `docs/features.md`, LOB-27). The control plane's half
is `.pi/skills/verify-api/features/compact.md`: `compactSession` admits a task in the session's log
and answers its id, and the summary arrives as a `compaction` entry over the stream the pane is
already following. So the button never waits for a result and never navigates: it admits the task,
and the transcript fills in.

The spend is a **delta between two readings of the session's `SessionUsage`**, not a per-action
number the server reports: `spendOf`/`spendDelta`/`compactionRow`/`compactionDelta` in
`apps/web/src/lib/compaction-view.ts` (LOB-222's helper, extended here), tested by `bun run test` in
`apps/web`. The starting reading is taken when the button is pressed, the ending reading is captured
once the summariser's own spend has landed, and the delta is bound to the **first** `compaction` row
at or after the press:

- a summary that was already on screen keeps no spend line, and neither does a compaction this pane
  did not press — including a later automatic one: a turn of the operator's own between the press
  and the summary ends the window, so a press that had no cut can never charge the next compaction;
- the number freezes at capture, so a turn sent afterwards cannot grow it;
- the window carries its `sessionId`, so moving to another session never subtracts A's reading from
  B's usage.

## How a user reaches it

Open a session. The header reads left to right: the status chip, the read-path label, the live tool,
this session's usage (`46,120 tokens`), **Compact**, and **Fork**. Press Compact.

- While the pane is attaching, or the session is running, the button is disabled and its `title` and
  `aria-describedby` target say why: `Attaching to the session`, `Wait for this run to finish before
compacting`, `This session could not be read`.
- A refused call shows `toast.error("No compaction was started", <cause>)` and leaves the button
  usable — it is the admission that failed, so nothing was written.
- A session too short to have a cut writes no summary: the task settles, no row appears, and the tail
  of the transcript says **Nothing to compact** with `This session is too short to cut. Its recent
turns stay verbatim.` That is LOB-224, below.

## What a press comes to

`compactSession` answers a task id and nothing else, so the outcome is read from the stream. The
state machine is `CompactionSettle` / `settleCompaction` in `apps/web/src/lib/compaction-view.ts`,
unit-tested like the spend arithmetic, and it has four states:

- `idle` — no press, or the press belongs to another session (one pane component serves every route);
- `requested` — the call answered a task id, and the task is (or was) live in the session's
  `SessionTask` list. The tail shows `Compacting this session…` beside a spinner;
- `settled-compacted` — the task left the list and a `compaction` entry arrived at or after the press.
  Nothing is added to the tail: the summary row is the answer;
- `settled-nothing` — the task left the list and no entry did. The tail shows the verdict.

Two wrinkles are the whole reason this is not a boolean:

1. **A settled task is absent from `SessionTask`, not carried with a terminal status**
   (`packages/domain/src/Session.ts:152`). So "terminal" is "gone from the list" — and the list the
   pane held _at the press_ is not evidence, because `compactSession`'s answer and the stream are two
   paths. A compaction with no cut can create and settle in ~11 ms, so all of its task events can be
   folded before the answer arrives. The reducer therefore compares the projection's identity against
   the press-time one, and the pane reduces again when the answer lands, not only when the view
   changes.
2. **A summary can trail its task.** A busy session's summary is placed at its next boundary, so a
   verdict that said "nothing" above rows that are about to be summarized would be the lie this
   state exists to prevent. `settled-nothing` is therefore not final: a summary that arrives later
   settles the press as `settled-compacted`. The verdict's scan is deliberately _not_ the spend's:
   the verdict asks what the task wrote and ignores a turn of the operator's in between
   (`anySummaryFrom`), while the spend line keeps refusing to attribute a row that follows an
   operator turn (`compactionRow`). Both still read the same row list, so the verdict can never point
   at a row the spend disagrees about.

The verdict describes the transcript at the press, so the operator's next turn clears it. A press of
Compact while a compaction is under way is disabled: one admission at a time.

**What the state is and what the pane says are two questions.** `settleCompaction` decides; the
pane asks `verdictVisible(settle, busy)` whether it may speak yet. A verdict is held — not shown, not
discarded — while the session is busy, because an outcome announced under work still in flight reads
as knowledge the pane cannot have; it appears when the run ends. The unit tests cover the pair
(`settleCompaction`, `verdictVisible`); the drive covers the combination, a busy session whose status
region stays `requested` with no verdict on screen.

## Driving it with drive.mjs

The drive creates a session through the control plane's RPC whose **first message is 90,000
characters**, then opens it in the browser: Pi Durable summarizes an old prefix and keeps the newest
`keepRecentTokens` (20k here) verbatim, so a shorter transcript has nothing to cut and the summary
would never appear. It then asserts, in order:

1. while that run is in flight, Compact is `disabled` and `Wait for this run to finish before
compacting` is both its `title` and its `aria-describedby` text;
2. the header's `[data-session-usage]` reading is non-zero and prints no `$` (faux reports tokens,
   never cost);
3. pressing Compact puts `Summary: the session ran its tools and kept working.` on screen, the row's
   `[data-compaction-spend]` line reads `N tokens to compact`, and the header reading is still
   non-zero — measured 92,050 → 114,925 tokens on the recorded run;
4. the pane's compaction status went `idle → requested → settled-compacted` (`MutationObserver` on
   `[data-compaction-status]`, sampled per DOM change rather than polled), and it never said
   `settled-nothing` while the task was live;
5. a `compactSession` that the network layer answers with 500 shows the failure toast and leaves the
   button enabled with `aria-busy="false"`, after which a second press re-enables it with no new
   failure toast;
6. a **second, short session** is created through the RPC and opened: pressing Compact there ends in
   `[data-compaction-status="settled-nothing"]` reading `Nothing to compact` and `too short to cut`,
   with no spinner left in the status box, the button re-enabled with `aria-busy="false"`, and the
   recorded sequence `idle → requested → settled-nothing` — the pending state is committed to the DOM
   before the verdict, and the verdict text is never on screen while the state is `requested`;
7. the pending box and the verdict box are the same height (64 px on the recorded run: `min-h-16`),
   so the verdict does not reflow the transcript;
8. a **third, long session** is pressed and sent a turn in the same script task, and the recorded
   sequence is `idle → idle(busy) → requested(busy) → settled-compacted`: a session busy with its own
   run shows the pending state and never a verdict (the verdict is held, not shown, while `busy`);
9. the operator's next turn clears the verdict, and the pane does not overflow horizontally at 390 px.

Evidence: `.verify/evidence/<id>/verify-web/` — `compaction.png`,
`compaction-nothing-to-compact.png`, `compaction-nothing-to-compact-narrow.png` plus `observed.json`'s
`compactBusy`, `compactSpend`, `compactSettle`, `compactFailure`, `compactRetry` and
`verdictCleared` blocks.

## What it does not prove

- **No dollar figure, on purpose.** pi-ai's faux provider hardcodes `cost.total = 0`, so a gate-run
  session spends $0 by construction and a `$`assertion would be fiction. The helper prints tokens
alone when a reading reports no cost, and the drive asserts the absence of`$` rather than
  inventing a number.
- **The refusal is injected at the browser's network layer**, not by the control plane: there is no
  way to make the server refuse a compaction on a session this pane is allowed to compact. What that
  proves is the catch path, the toast, and the button's recovery — not the server's refusals, which
  `.pi/skills/verify-api` covers. The toast's description is therefore the transport's own defect
  text (`RpcClientDefect: Received empty HTTP response from RPC server`), not a domain refusal.
- The retry after that failure is asserted as _the button re-enables and nothing new fails_, not as
  a second summary: compaction of a context that has just been summarized has no range left to cut.
  Since LOB-224 that re-enable is itself the settle (the retry's press ends in `settled-nothing`),
  so it also proves the reducer concludes without a summary.
- **The pending state is recorded, not awaited.** A compaction with no cut settles in milliseconds, so
  the drive observes the DOM (`MutationObserver`) instead of polling for the pending line: it proves
  the state was rendered and that the verdict never appeared beside it, not that a person had time to
  read it. A runtime-visible pending state is the long-session case, where the summariser answers for
  seconds.
- **"A busy session" here is a session busy _compacting_ or _running_.** Compact is disabled while
  the run is busy (`Wait for this run to finish before compacting`, asserted since LOB-223), so a
  run-busy session cannot start a press; the drive therefore presses on an idle session and sends a
  turn in the same script task, which is the one way both are true at once. **The click must come
  first**: `requestSubmit` dispatches a submit event, React flushes that event's state before the next
  dispatch, and a click after the send lands on a `disabled` button and does nothing — measured, and
  the reason an earlier draft of this drive recorded no press at all. What is proven is that the
  verdict never appears under work still in flight; not that a run-busy session can be compacted at
  all, which it cannot. And the busy session is a long one, so it settles `settled-compacted`: the
  held-verdict path (`verdictVisible` with `busy`) is otherwise covered by unit tests only.
- **The identity of the task projection is the detection, and it has one residual hazard.** A
  projection that predates the admission but arrives _after_ the call answers would end the wait
  early, and the pane would show the verdict for the seconds a long summary takes (the entry then
  refines it to `settled-compacted`). The concrete trigger is a re-attach: `session-atom.ts` replaces
  `tasks` on every `snapshot` event, which is what a re-attach delivers. No run of the drive has
  produced that ordering: the stream compares projections (`sameTasks`) and drops the ones that say
  nothing new, and the admission revision is always published. There is no clock in the reducer to
  bound it, though — a future change could replace the identity comparison with "the task was seen at
  least once", at the cost of hanging whenever the whole task life fits between two folded events.
- **The reserved height is a desktop-and-tablet guarantee.** At 390px the dashboard's three-column
  shell leaves the pane a ~60px transcript column, so the verdict's copy stacks nearly a word per line
  and the tail grows no matter what this box reserves. The drive still asserts no horizontal overflow
  there, and records the measured height rather than asserting it (`observed.shortNarrow`). The
  squeeze is the shell's and predates this control.
- The drive's console-error list carries one expected entry: the injected 500
  (`Failed to load resource: … 500`). It is the scenario, not a defect.
- Nothing here is a compaction _policy_: automatic compaction at a threshold is the harness's
  (`.pi/skills/verify-api`'s threshold test). This surface only presses the manual action.
