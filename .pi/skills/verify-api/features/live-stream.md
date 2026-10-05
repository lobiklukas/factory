# Watch a live session

**Status: passing.** A client that attaches before a message arrives receives a snapshot, then the
transcript entries as they commit, then the run going `busy` and back to `idle`.

## What it is

The streaming half of D8. When this process owns the session, `watchSession` streams from the live
view: a snapshot of the committed state at attachment, then one event per change — `entry` for a
committed transcript entry, `live` for the in-flight generation and tool round, `status` when the
run starts or stops, `usage` when spend changes.

A client can tell what it is looking at from the snapshot's `mode`, and every later event belongs to
the same session, in order, with nothing skipped: the projection diffs whole views rather than
forwarding operations, so even a client that falls behind converges.

## How a user reaches it

The dashboard's session card streams through this call, as does any RPC client:

```ts
const events = client.watchSession({ sessionId });
// snapshot → entry(user) → status(busy) → entry(assistant) → entry(toolResult) → ... → status(idle)
```

## What proves it

- the first event is a `snapshot` with `mode: "live"` and the entries committed _before_ the message
  (the driver attaches first, so this is the state before the work)
- at least one `entry` event arrives afterwards — the transcript grew while attached
- `status` events include `busy` and then `idle` in that order
- an `entry` event carries the answer text, which is derived from the `bash` tool's output
- `getSession` afterwards agrees with the streamed entries, and reports non-zero token usage

## Gotchas

- The answer arrives after `sendMessage` returns. Waiting for it means watching the stream (or
  polling `getSession` until `live.busy` is false); do not assume the call blocks.
- Partials are committed at `settings.progress.partialIntervalMs` (250 ms here, because storage is
  remote), so a slow turn shows up as repeated `live` events before its `entry` lands.
- A run is durable and belongs to the session, not the request: a client that disconnects mid-turn
  does not cancel the agent.
