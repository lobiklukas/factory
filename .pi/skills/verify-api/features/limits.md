# Request limits

**What it is.** A message has a maximum length, and going over it is a typed refusal rather than a
truncation or a crash. The transport-level request body cap is LOB-21's half and is not in yet.

**How a user reaches it.** `sendMessage` with a `content` longer than `MAX_MESSAGE_CHARS`
(100,000 characters, `packages/core/src/SessionService.ts`) fails with
`SessionError{ code: "invalid_input" }` and a message naming the limit and the actual length. The
check runs before the session is woken, so an oversized message cannot start a run.

**How the skill drives it.** `drive.ts` sends `"x".repeat(100_001)` to a session that exists and
asserts the failure crosses the wire as `SessionError` with `code: "invalid_input"` — a client must
be able to branch on the code rather than parse prose.

**Why the number.** 100,000 characters is generous for a task description and small enough that a
message cannot be used as a way to push an unbounded body through the RPC endpoint. The body cap
that backs it (1 MiB, so the largest legal RPC payload fits with headroom) belongs to LOB-21 and is
parked at `.verify/scratch/paused-agents/`.

**What it does not prove.** Nothing checks the _transport_ limit yet, and nothing checks how a long
message behaves against a real provider's context window — that is compaction (LOB-27).
