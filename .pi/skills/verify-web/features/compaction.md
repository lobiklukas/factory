# Compact now from the pane

**Status: passing.** The header's **Compact** button admits a compaction on the session the pane is
showing; the summary lands in the transcript as a `compaction` row with what the action spent, and
the header's own token reading is visible before and after it (LOB-223).

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
this session's usage (`46,120 tokens`), **Compact**, **Fork**, and the Forget icon. Press Compact.

- While the pane is attaching, or the session is running, the button is disabled and its `title` and
  `aria-describedby` target say why: `Attaching to the session`, `Wait for this run to finish before
compacting`, `This session could not be read`.
- A refused call shows `toast.error("No compaction was started", <cause>)` and leaves the button
  usable — it is the admission that failed, so nothing was written.
- A session too short to have a cut writes no summary: the task settles and no row appears. That is
  part 3's "nothing to compact" case, not this one.

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
4. a `compactSession` that the network layer answers with 500 shows the failure toast and leaves the
   button enabled with `aria-busy="false"`, after which a second press re-enables it with no new
   failure toast.

Evidence: `.verify/evidence/<id>/verify-web/` — `compaction.png` plus `observed.json`'s
`compactBusy`, `compactSpend`, `compactFailure` and `compactRetry` blocks.

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
- The drive's console-error list carries one expected entry: the injected 500
  (`Failed to load resource: … 500`). It is the scenario, not a defect.
- Nothing here is a compaction _policy_: automatic compaction at a threshold is the harness's
  (`.pi/skills/verify-api`'s threshold test). This surface only presses the manual action.
