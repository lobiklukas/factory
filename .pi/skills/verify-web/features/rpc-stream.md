# Streaming RPC card

**Status: passing.** Clicking the button streams events from `/rpc` and the panel reaches
`Event: end`.

## Sub-features

- `RpcCard` renders a button and an output panel
- Clicking it starts a streamed call to `/rpc` and renders each tagged event as it arrives
- The stream reaches its terminal `end` event and renders `Event: end`

This is the end-to-end proof of the transport that session event streaming will use
(`docs/design.md` D8/D9): browser → typed Effect RPC client → HTTP NDJSON stream → server.

## How to get to it (user POV)

Open the dashboard, click **Call RPC API** in the "RPC API" card. The panel fills in over roughly
13 seconds (a 3s delay, then one event per second) and ends with
`Message: Start.......... End`.

## Driving it with drive.mjs

`drive.mjs` clicks the button and waits up to 40s for `Event: end`. This is a **required**
check: the run exits non-zero without it. The panel text is recorded in `observed.json`.

## Two bugs hid behind one symptom (fixed 2026-10-06)

1. **Client: interrupted before any request.** `tick-atom.ts` did
   `Effect.provide(RpcClient.layer)` inside `Stream.unwrap`. The scoped layer's scope closed as
   soon as the unwrapping effect returned, interrupting the client before it issued a request.
   The atom's state was `Failure(Interrupt)`, which the card rendered as the unchanged fallback.
   Fix: `RpcClient.layer` is part of the atom runtime layer (`lib/atom.ts`), so the client lives
   as long as the runtime.
2. **Server: terminal event lost.** `Event.ts` finished with `Queue.shutdown`, which discards
   items still queued, so the last tick(s) and `end` never reached the client. Fix: `Queue.end`,
   which lets the queue drain first.

## Gotchas

- A silent failure is the expected shape here, so absence of console errors proves nothing.
  Check the atom's `AsyncResult` in a registry (`AtomRegistry.make()` + `subscribe` + `set`) from
  bun to see `Failure(Interrupt)` that the UI swallows.
- Never provide a scoped layer inside an atom's stream; provide it through the runtime layer.
- Never `Queue.shutdown` a queue you hand to an RPC stream; use `Queue.end` / `Queue.fail`.
- Expect a favicon-class 404 in the console on every run. It is unrelated.
