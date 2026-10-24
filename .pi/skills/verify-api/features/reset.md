# Reset a session

**Status: passing.** `resetSession` starts a new model context, opened with the handoff note when
one is given, and the transcript keeps the turns before it with the `reset` entry marking the
boundary between them (LOB-181).

## What it is

A reset is not an interrupt and not a fork. The session, its log, and its title stay; what changes is
what the model sees from the next request on. Pi Durable appends a `pi.reset` entry that heads the
new context and carries the handoff as its first user message, and the entries before it stay in the
log. The tool that needs it: a run that has gone long or wrong is handed to a fresh context with a
written summary instead of the whole transcript.

## How a user reaches it

Any RPC client:

```ts
await client.resetSession({
  sessionId,
  handoff: "we were fixing the flaky login test",
});
// → the session summary, still idle, with the same id and title

await client.resetSession({ sessionId }); // a context that opens with nothing at all
```

## What proves it

- `resetSession` answers with the session summary, `id` unchanged, `status: "idle"`
- `getSession` after the reset returns the turns from before it, unchanged and in order, then the
  `reset` entry, whose `text` is the handoff
- the transcript is exactly one entry longer than before the reset — nothing is dropped and nothing
  is duplicated
- a second reset with no handoff appends a second `reset` entry whose `text` is `""`, so "reset" and
  "reset with notes" are one shape

The model context itself — that the next request carries the handoff and nothing from before it — is
not observable over the RPC surface; `packages/harness/src/session.test.ts` reads it from
`ContextView.messages` at the harness boundary.

## Notes

- Both read paths show the same thing. `packages/harness` reads the transcript from the start of the
  log rather than from the newest head marker, so a live read, a fold after release, and a stream's
  snapshot all include the past (`docs/design.md` D8). The model's context still starts at the head.
- A reset while a run is in flight is placed at the next boundary by Pi Durable, the same way a
  queued write is; the RPC returns once it is admitted.
