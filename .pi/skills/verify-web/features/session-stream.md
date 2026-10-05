# Session stream card

**Status: passing.** Clicking **Start a session** creates a session through the API, sends it a
message, streams the events back, and renders the transcript — ending with the answer the `bash`
tool produced.

## Sub-features

- `SessionCard` renders a button, a live/historical label, and a transcript panel
- Clicking it creates a session, sends a prompt, and attaches to `watchSession`
- The snapshot's entries render, then each committed entry as it arrives
- The panel ends with `assistant: faux-ok (re: ...)`, text that exists only because the agent really
  ran `bash` in the session

This is the browser end-to-end proof of the session stream (`docs/design.md` D8/D9): browser → typed
Effect RPC client → HTTP NDJSON stream → `SessionService` → Pi Durable → Postgres, and back. It
replaced the demo `tick` stream, which proved the transport and nothing else.

## How to get to it (user POV)

Open the dashboard, click **Start a session** in the "Session" card. The label under the button reads
`live · idle` or `live · busy` (mode · run state), and the panel fills with the session's transcript:
`title`, `user`, `system`, `assistant` (with its tool call), `toolResult`, `assistant`.

## Driving it with drive.mjs

`drive.mjs` clicks the button and waits up to 40s for `toolResult: faux-ok`, then requires the panel
to contain the answer and the mode label to start with `live`. Both are required checks: the run
exits non-zero without them. The panel text and the mode line go into `observed.json`.

The card is driven against `MODEL_BACKEND=faux` (`up.sh` sets it): the model is scripted, but the
tool call, the transcript, the stream, and storage are all real.

## Why the label matters

`live · idle` is not decoration: it is D8's requirement that a transcript folded from the log must
never look like a live one. The dashboard reads its mode from the snapshot, so the label is the
client's own report of which read path served it.

## Rules this card cost us (2026-10-06)

Both bugs are recorded because they were invisible from the outside — the card rendered, and nothing
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
- The 404 in the console on every run is a favicon-class request; `failedResponses` stays empty. Do
  not chase it.
- The card creates a **new** session on every click, and sessions are append-only. Clicking ten times
  leaves ten logs; that is expected, not a leak to clean up by hand.
