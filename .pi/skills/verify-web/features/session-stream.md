# Session stream

**Status: passing.** Clicking **New session** creates a session through the API, sends it a message,
navigates to `/sessions/<id>`, streams the events back, and renders the transcript — ending with the
answer the `bash` tool produced.

## Sub-features

- The sidebar button creates a session and the route moves to that session's own URL
- `SessionPane` attaches with `getSession` then `watchSession`, and folds events into one view
- The header shows the session id, the run state, and the read path (`LIVE STREAM` or
  `HISTORICAL FOLD`)
- The transcript renders `user`, `system`, `toolResult` (collapsed, in a disclosure), and `assistant`
- The pane ends with `faux-ok (re: ...)`, text that exists only because the agent really ran `bash`
- The session appears in the sidebar, recorded from what the stream reported

This is the browser end-to-end proof of the session stream (`docs/design.md` D8/D9): browser → typed
Effect RPC client → HTTP NDJSON stream → `SessionService` → Pi Durable → Postgres, and back. It
replaced the demo `tick` stream, which proved the transport and nothing else.

## How to get to it (user POV)

Click **New session**. The route becomes `/sessions/ses_…`, the sidebar gains a row, and the header
reads `IDLE` (or `BUSY`) beside `LIVE STREAM`. The composer is pinned to the bottom edge; Enter sends,
Shift+Enter newlines.

## Driving it with drive.mjs

`drive.mjs` clicks the button, requires the path to match `/sessions/ses_…` within 20s, waits up to
40s for the answer, then requires `IDLE` within 20s. It also asserts the header labels the read path,
the header carries the id, and the sidebar shows the session. All are required checks; the run exits
non-zero without them.

The whole thing is driven against `MODEL_BACKEND=faux` (`up.sh` sets it): the model is scripted, but
the tool call, the transcript, the stream, and storage are all real.

## Why the read-path label matters

`LIVE STREAM` beside `HISTORICAL FOLD` is not decoration: it is D8's requirement that a transcript
folded from the log must never look like a live one. The dashboard reads its mode from the snapshot,
so the label is the client's own report of which read path served it.

## Why the transcript does not label tool calls

A coding run emits dozens. Every reference agrees tool activity is a disclosure, not a card per step
(Cofounder's tab strip, Devin's "Worked for 11s" chevron, Mintlify's timeline). The first render
listed the call name on the assistant row _and_ inside the following `toolResult` disclosure — the
same fact twice. The call label is gone; an in-flight call shows in the header instead, which is
where v0 puts the current step.

## Rules this cost us (2026-10-06)

Both bugs are recorded because they were invisible from the outside: the card rendered, and nothing
happened.

1. **Client: never provide a scoped layer inside an atom's stream.** The old tick atom did
   `Effect.provide(RpcClient.layer)` inside `Stream.unwrap`; the scope closed as soon as the
   unwrapping effect returned, so the client was interrupted before it issued a request. The atom's
   state was `Failure(Interrupt)`, which the card rendered as its unchanged fallback. Fix: the client
   layer belongs to the atom runtime (`lib/atom.ts`).
2. **Server: never `Queue.shutdown` a queue you hand to an RPC stream.** It discards what is still
   queued, so the stream's tail never reaches the client. Use `Queue.end` (drain) or `Queue.fail`.

The session stream avoids both by construction: streaming comes from `viewState()` subscriptions, so
there is no hand-rolled queue, and the client layer lives in the runtime.

## Gotchas

- A silent failure is the expected shape here, so absence of console errors proves nothing. To see
  what an atom actually did, drive it from bun with an `AtomRegistry` (`AtomRegistry.make()` +
  `subscribe` + `set`) and read the `AsyncResult`.
- Each click creates a **new** session and sessions are append-only. Clicking ten times leaves ten
  logs; that is expected, not a leak to clean up by hand.
- `SessionPane` records into the sidebar registry from a `useEffect`, not from the atom. Writing one
  atom from another needs an `AtomRegistry` in context, and the pane is already where the summary
  lands.
- A session id that is not `ses_` + Crockford base32 is refused by the route's decode, never sent to
  the RPC surface as a `not_found`.
