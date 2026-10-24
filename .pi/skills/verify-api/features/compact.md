# Compact a session on demand

**Status: passing.** `compactSession` admits a compaction task in the log and answers its id; the
summary the task writes is a `compaction` entry, and every entry it stands in for stays in the
transcript above it (LOB-185).

## What it is

Two halves of one feature (B4 in `docs/features.md`, LOB-27):

- **A policy.** Every session opens with compaction enabled, and the thresholds are derived from the
  model's context window (`compactionPolicyFor` in `packages/harness/src/models.ts`): an answer
  reserve and a verbatim tail of at most a quarter of the window each, and background summarization
  only where the window still has a quarter to work in. Above a large window it is pi-durable's own
  pinned defaults to the token, so a real model behaves exactly as before; a small one compacts
  where it actually can instead of never.
- **A manual action.** `compactSession` admits the same task on demand, with optional `instructions`
  for the summarizer. The task summarizes an old prefix of the model context and places the summary
  as the new head marker. Nothing is dropped from the log: the summary heads what the _model_ sees,
  and the transcript keeps the turns it replaced.

## How a user reaches it

```ts
const { taskId, session } = await client.compactSession({
  sessionId,
  instructions: "focus on the failing test",
});
// → the compaction task's id, and the session (still idle: a compaction is not a run)

const after = await client.getSession({ sessionId });
after.entries.find((entry) => entry.kind === "compaction"); // the summary, once the task settles
```

The call does not wait for the summary: the task settles in the background and the entry appears
when it does, so a caller watches the transcript (or `watchSession`) rather than blocking on the
RPC.

## What proves it

- `compactSession` answers a non-empty `taskId` and the session it belongs to, still `idle`
- `getSession` then reports exactly one `compaction` entry with non-empty text
- the entries from before the compaction are all still in the transcript, unchanged and in order —
  the summary is appended, not swapped in
- a threshold test at the harness boundary (`packages/harness/src/session.test.ts`,
  `describe("compaction")`): a session with an 8k-token window that crosses 6k compacts exactly once
  and heads its context with the summary; a session that stays under the threshold commits none

## Notes

- Range selection decides whether a compaction writes anything. Pi Durable keeps the newest
  `keepRecentTokens` verbatim and summarizes what is older, so a transcript shorter than that tail
  has no cut: the task completes, the id is still answered, and no summary is written. That is why
  the drive sends a 90k-character message first — at this window's 20k tail, a short session would
  prove only that the call is mounted.
- The summary entry is a head marker like `pi.reset`, and both read paths read the transcript from
  the start of the log, so a live read, a fold after release, and a stream snapshot all show it
  (`docs/design.md` D8).
- Compaction spend is not itemized yet: the summarizer's request is attributed through the session's
  `pi.usage` like any other model call (LOB-187 shows the compaction and its spend in the
  dashboard).
