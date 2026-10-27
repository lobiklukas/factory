# Curate a finished session's pages

**Status: passing.** One bounded curator pass over a finished session (LOB-206, part 3 of LOB-47).
It makes exactly one model call, writes at most `maxPages` cited pages, and writes nothing when the
session already holds what the model proposed.

## What it is

- `curateSession({ sessionId, maxPages? })` reads the session's live snapshot and the pages it
  already holds, makes **one** model call over both, and commits the proposals as pages. The server
  clamps `maxPages` rather than refusing it, as a list's page size is clamped.
- Every page it writes cites the curated session in `sources`, whether or not the model named it: a
  page written by this pass was, by construction, learned from this session.
- The call's spend is charged to the curated session's own `pi.usage` ledger and activity row, before
  the answer is judged: a curator is a call, not a session with a bill of its own. An unreadable
  answer is refused as `harness` _after_ the charge.
- A running session is refused (`busy`) before any call: a curator reads finished work.

## How a user reaches it

`SessionRpc.curateSession`, on the same `/rpc` endpoint as the rest of the session surface. The
pages it writes come back through `listPages`, and are folded from the log like everything else, so
they survive the owner being released.

## What proves it

`drive.ts`, over the real Effect RPC client (`SessionRpc`), on a session of its own:

- A session sends a message and settles. The faux model derives a curation answer from the rendered
  transcript (one page per tool that shows a result), so a page can only exist if this session really
  ran a tool.
- `curateSession` with `maxPages: 1` writes exactly one page, `proposed` is at least one, the page's
  `sources` names the curated session, and `listPages` reads that page back.
- The curated session's own usage grows across the call — the spend is attributed to it — and a
  `listSessions` read taken after the call carries no row that was not there before: a curator is a
  call, not a run with a session of its own.
- The same call again answers `pages: []` while `proposed` stays non-zero, and `listPages` still
  reports the one page. `pages: []` is the load-bearing assertion: a same-name rewrite would commit
  an entry while leaving the page _count_ unchanged, so the count alone would not catch it. (The
  mutation run in `.verify/evidence/lob-206/mutation/` is exactly that case: with the dedupe
  disabled the repeat answers `pages: [bash-ran]` and the drive fails.)

The first answer, the held pages, the repeat, and the token counts before and after are in
`observed.json` under `curation`.

That the repeat still costs exactly one call, and that the pages a curation wrote come back from the
log after their rows are deleted, is `./pages.sh` — a priced faux and a database connection, which
this drive's instance does not have. See [pages.md](pages.md).

What this drive does **not** cover, because it is a property of the code rather than of the wire:

- **The cap above one.** The faux answer proposes one page for the one tool the probe session runs, so
  a `maxPages` larger than one is not reached here. The clamp and the cap are unit-tested in
  `packages/harness/src/curate.test.ts` ("writes at most maxPages of what the model proposed, in one
  request") and in `packages/core/src/SessionService.test.ts`.
- **A second call.** The one-call bound is asserted there by reading `faux.state.callCount` from the
  provider, which a drive process cannot see across the wire. The drive's repeat check proves the
  _consequence_ of a second call (a second pass that writes nothing) rather than the count.
