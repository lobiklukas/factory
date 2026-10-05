# Create a session

**Status: passing.** `createSession` returns a session whose id is a valid `SessionId`, and a retry
with the same `requestId` returns the _same_ session.

## What it is

A session is one Pi Durable log (`docs/design.md` D7). Creating one mints the id, ensures the
session's working directory, writes the `sessions` index row, and opens the owner: the root
conversation is committed to the log then, so an empty session is still a real log with a root.

## How a user reaches it

CLI `factory run` (not built yet), or the dashboard's **Start a session** button, or any RPC client:

```ts
const session = await client.createSession({ title: "nightly triage" });
// → { id: "ses_01m46...", title: "nightly triage", mode: "live", status: "idle", createdAt: "..." }
```

`requestId` is the deduplication key. A client that times out and retries must not end up with two
logs for one request, which is why the driver asserts the retry returns the same id.

## What proves it

- `createSession` → `id` matches `/^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/` (sortable, branch-safe:
  D10 puts it in a branch name)
- `mode: "live"` — the process that created it owns it
- `status: "idle"` — nothing is running yet
- a second `createSession` with the same `requestId` returns the same `id`
- the first message later names it: the title becomes the message's first line (`sendMessage`
  returns the updated session), and the title is committed to the log too, so the index is rebuildable
