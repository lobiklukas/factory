# Streaming RPC card

**Status: KNOWN FAILURE.** Clicking the button starts no effect and issues no HTTP request.

## Sub-features

- `RpcCard` renders a button and an output panel
- Clicking it should start a streamed call to `/rpc` and render each tagged event as it arrives
- The stream is expected to reach its terminal `end` event and render `Event: end`

Intended to be the end-to-end proof of the transport that session event streaming will use
(`docs/design.md` D8/D9): browser → typed Effect RPC client → HTTP NDJSON stream → server.

## How to get to it (user POV)

Open the dashboard, click **Call RPC API** in the "RPC API" card. The panel below the button
should fill in as events arrive over roughly 13 seconds (a 3s delay, then one event per second).

## Driving it with drive.mjs

`drive.mjs` clicks the button and waits up to 40s for `Event: end`, recording
`rpcStream.worked` and the panel text in `observed.json`. It does **not** fail the run, so the
rest of the drive still produces evidence while this is broken.

## What was observed (2026-10-05, chrome headless)

The click reaches the DOM. Everything around the call is correct. The call itself never happens.

| Check                                            | Result                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Button exists, visible, enabled                  | yes                                                              |
| Click delivered to the DOM                       | yes (`BUTTON:Call RPC API` observed via a capture listener)      |
| `VITE_SERVER_URL` inlined into the served module | yes (`http://localhost:9100`)                                    |
| Browser can reach the API across origins         | yes (`fetch` from the page → 200)                                |
| Network request to `/rpc` after the click        | **none**                                                         |
| Panel text after the click                       | unchanged fallback: "Click the button above to test the RPC API" |
| Console errors / page errors                     | none attributable (one favicon-class 404)                        |

Because no request is issued and no error surfaces, the failure is in the client-side atom
wiring — `runtime.fn(...)` + `useAtom(...)` in `apps/web/src/lib/atoms/tick-atom.ts` and
`apps/web/src/components/rpc-card.tsx` — not in the server, the URL, or CORS. The stream never
starts, so `AsyncResult.getOrElse(result, () => null)` keeps returning the fallback and the UI
looks inert.

`useAtom`, `runtime.fn` (stream variant), and the `RegistryContext` default registry all exist
in the installed versions, so this is a wiring bug rather than a missing API.

## Gotchas

- Do not "fix" this by asserting less. The card is the only end-to-end check of the streaming
  transport; deleting the check would hide the bug rather than remove it.
- A silent failure is the expected shape here, so absence of console errors proves nothing.
  When wiring anything similar, add a temporary capture listener to confirm the click is
  delivered before suspecting the click handler.
- Expect a favicon-class 404 in the console on every run. It is unrelated.
