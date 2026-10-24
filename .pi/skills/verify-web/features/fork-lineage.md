# Fork lineage and the fork action

**Status: passing.** A session can be forked from its own pane, and the sidebar shows which session
a fork came from — on the fork's row only (LOB-182, over LOB-180's `forkSession`).

## Sub-features

- The pane header carries a **Fork** button (`aria-label` "Fork from here"), beside the status chip
  and left of **Forget**. It calls `forkSession({ sessionId })` — the fork is taken at the session's
  last entry — then navigates to the child's route.
- The child is recorded in the sidebar registry before the route moves, so the list is not one render
  behind the pane.
- A sidebar row whose session has a parent reads `forked from ses_…` as a third line, in the same
  `font-mono text-[10px] text-muted-foreground` as the meta line. A session that was not forked has
  no lineage line and keeps its two-line height.
- The parent's id is plain text, not a link: the parent need not be in this browser's registry.
- A refused fork raises the `No fork was created` toast and stays on the current route.

## How to get to it (user POV)

Open a session, let it settle to `IDLE`, press Tab until **Fork** has focus, press Enter. The route
becomes a new `/sessions/ses_…`, and the sidebar gains a row above the parent reading
`forked from <parent id>`.

## Driving it with drive.mjs

After the session-stream checks, the drive blurs the document, tabs up to 30 times recording each
focused control's accessible name, and requires **Fork from here** to appear — and to come before
**Forget this session**. It then walks focus back to **Fork** and presses Enter, requiring the path
to become a _different_
`/sessions/ses_…`. Finally it requires at least two sidebar rows, the child's row to contain
`forked from <parent id>`, the parent's row to carry no `forked from` text, and the document to fit a
390 px viewport with the lineage line present — including the lineage line's own box staying inside
its row, so "readable" is asserted as a box rather than inferred from the page not widening.
Evidence: `fork-lineage.png`, `fork-lineage-narrow.png` and the recorded `narrowWidth` numbers.

All of these are required checks; the run exits non-zero without them.

## The two data paths, and which check proves which

`SessionListEntry.forkedFrom` reaches a screen by two routes, and the drive used to prove only the
first:

- **The summary path.** The fork RPC answers the child's `SessionSummary`, the pane records it in the
  browser-local registry, and the sidebar renders it. Proved by the sidebar row checks above.
- **The index fold.** `listSessions` folds `sessions.forked_from` into each `SessionListEntry`. The
  dashboard does not call `listSessions` yet (see the gap in `features/README.md`), so the drive asks
  the control plane directly: it posts the NDJSON request envelope that
  `apps/web/src/lib/rpc-client.ts` writes for `listSessions` **from inside the page**, which makes the
  check cover the RPC, the `SessionListEntry` schema and the browser's CORS path at once. It requires
  `forkedFrom` on the child's entry and its absence on the parent's.

## What this does not prove

- A refused fork's toast is not driven: the drive has no way to make `forkSession` fail without
  editing the session out from under the pane.
- The list-RPC check reads the response body rather than going through `RpcClient.make`, so a wrong
  method tag or a renamed field fails it, while a change to the _transport_ would not (there is no
  client in the page to reuse). `verify-api` drives the typed client.
