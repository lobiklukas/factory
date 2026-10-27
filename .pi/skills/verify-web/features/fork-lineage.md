# Fork lineage and the fork action

**Status: passing.** A session can be forked from its own pane, and the sidebar shows which session
a fork came from — on the fork's row only (LOB-182, over LOB-180's `forkSession`).

## Sub-features

- The pane header carries a **Fork** button (`aria-label` "Fork from here"), beside the status chip,
  as the header's last control. It calls `forkSession({ sessionId })` — the fork is taken at the session's
  last entry — then navigates to the child's route.
- `forkSessionAtom` carries `SESSIONS_KEY`, so the sidebar re-reads the server's list once the child
  exists (LOB-75 deleted the browser-local registry that used to record it).
- A sidebar row whose session has a parent reads `forked from ses_…` as a third line, in the same
  `font-mono text-[10px] text-muted-foreground` as the meta line. A session that was not forked has
  no lineage line and keeps its two-line height.
- The parent's id is plain text, not a link: the parent need not be on the list's first page.
- A refused fork raises the `No fork was created` toast and stays on the current route.

## How to get to it (user POV)

Open a session, let it settle to `IDLE`, press Tab until **Fork** has focus, press Enter. The route
becomes a new `/sessions/ses_…`, and the sidebar gains a row above the parent reading
`forked from <parent id>`.

## Driving it with drive.mjs

After the session-stream checks, the drive blurs the document, tabs up to 30 times recording each
focused control's accessible name, and requires **Fork from here** to appear, and requires that no
**Forget this session** control remains (it only ever edited the browser-local list). It then walks focus back to **Fork** and presses Enter, requiring the path
to become a _different_
`/sessions/ses_…`. Finally it requires at least two sidebar rows, the child's row to contain
`forked from <parent id>`, and the parent's row to carry no `forked from` text.

At 390 px (LOB-210) it then requires, on the fork's own route, the pane's header to span from the
rail's right edge to the viewport's with no list beside it, the **Fork from here** and **Compact
session** buttons' `getBoundingClientRect()` to end inside the viewport, the composer to be at least
half the viewport wide and no taller than two of its lines, and the document not to widen. It presses
the header's **Show sessions** link and requires `/sessions` with the list at the full width beside
the rail, the document to fit with the lineage line present, and the lineage line's own box to stay
inside its row, so "readable" is asserted as a box rather than inferred from the page not widening.
Against the build before LOB-210 the first three fail (pane 86 px, Fork's right edge 657 px,
composer 22 × 418 px) and the back link does not exist. Evidence: `fork-lineage.png`,
`session-pane-narrow.png`, `fork-lineage-narrow.png` and the recorded `narrowWidth` numbers.

All of these are required checks; the run exits non-zero without them.

## The two data paths, and which check proves which

`SessionListEntry.forkedFrom` reaches a screen by two routes, and the drive used to prove only the
first:

- **The sidebar.** Since LOB-75 the sidebar _is_ `listSessions`, so the row checks above already read
  the index fold. (Before it, the fork RPC's `SessionSummary` was recorded in a browser-local
  registry, and only that summary path was proven.)
- **The wire.** `listSessions` folds `sessions.forked_from` into each `SessionListEntry`, and the
  drive also asks the control plane directly: it posts the NDJSON request envelope that
  `apps/web/src/lib/rpc-client.ts` writes for `listSessions` **from inside the page**, which makes the
  check cover the RPC, the `SessionListEntry` schema and the browser's CORS path at once. It requires
  `forkedFrom` on the child's entry and its absence on the parent's.

## What this does not prove

- A refused fork's toast is not driven: the drive has no way to make `forkSession` fail without
  editing the session out from under the pane.
- The list-RPC check reads the response body rather than going through `RpcClient.make`, so a wrong
  method tag or a renamed field fails it, while a change to the _transport_ would not (there is no
  client in the page to reuse). `verify-api` drives the typed client.
