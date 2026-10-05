# Request limits

**What it is.** Two limits, at two layers. A message has a maximum length and going over it is a
typed refusal rather than a truncation or a crash. A request body has a maximum size, refused at the
transport before any RPC parsing.

**How a user reaches it.** `sendMessage` with a `content` longer than `MAX_MESSAGE_CHARS`
(100,000 characters, `packages/core/src/SessionService.ts`) fails with
`SessionError{ code: "invalid_input" }` and a message naming the limit and the actual length. The
check runs before the session is woken, so an oversized message cannot start a run. Separately, any
request body over `MAX_REQUEST_BODY_BYTES` (1 MiB, `apps/api/src/index.ts`) is refused with 413.

**How the skill drives it.** `drive.ts` sends `"x".repeat(100_001)` to a session that exists and
asserts the failure crosses the wire as `SessionError` with `code: "invalid_input"` — a client must be
able to branch on the code rather than parse prose. It then posts 2 MiB of junk to `/rpc` and asserts
413 followed by a `/livez` 200, so the refusal is a refusal and not a crash.

**Why those numbers.** 100,000 characters is generous for a task description and small enough that a
message cannot be used to push an unbounded body through the RPC endpoint; 1 MiB carries the largest
legal message (~400 KB of UTF-8 plus JSON framing) with headroom. Bun's own body default is 128 MiB —
128× larger, and enough for one unauthenticated upload to exhaust the process.

**What it does not prove.** Nothing about how a long message behaves against a real provider's
context window — that is compaction (LOB-27) — and nothing about rate or concurrency limits, which
are admission control (LOB-28).
