# Request limits

**What it is.** Three limits, at three layers. A message has a maximum length and going over it is a
typed refusal rather than a truncation or a crash. A request body has a maximum size, refused at the
transport before any RPC parsing. And the process runs at most `SESSION_MAX_CONCURRENT` sessions at
once (admission control, LOB-70): the request that would open one more is refused with a typed code
a client can retry on.

**How a user reaches it.** `sendMessage` with a `content` longer than `MAX_MESSAGE_CHARS`
(100,000 characters, `packages/core/src/SessionService.ts`) fails with
`SessionError{ code: "invalid_input" }` and a message naming the limit and the actual length. The
check runs before the session is woken, so an oversized message cannot start a run. Separately, any
request body over `MAX_REQUEST_BODY_BYTES` (1 MiB, `apps/api/src/index.ts`) is refused with 413.

**Admission control.** With `SESSION_MAX_CONCURRENT=N` set (unset: no cap), a slot is an open owner —
a harness, the log's single-writer lock, a worktree and a projection. `createSession`, `forkSession`
and `replaySession` past N fail with `SessionError{ code: "at_capacity" }` before they write any row,
so a retried create with the same `requestId` is a fresh attempt; a `sendMessage` (or any call) to a
session nobody owns is refused the same way before it opens one, while a call to a session whose owner
is open is served. The message names the cap and its key: `at capacity: at most 2 sessions may be
open at once (SESSION_MAX_CONCURRENT=2), and that many are; retry once one is released`. A slot frees
when an owner is released — the idle sweep (`SESSION_IDLE_TIMEOUT_MS`), a workspace release, shutdown.
A boot's resume of a run or mission a dead process left in flight (`resumeRuns`, `resumeMissions`,
LOB-25) is never refused — the cap admitted that work before the crash, and a refusal would strand it
until the next boot — but the owners it opens count, so a boot that resumes N sessions is at
capacity until the sweep releases one.
A trigger delivery that would open a session past the cap (`/webhooks/generic`, `linear`, `sentry`,
`jira`, `slack`, and GitHub's issue events, docs `push` and review) is answered `503` with
`Retry-After` and `code: "at-capacity"`, never `500`, and its claim is released, so the sender's
redelivery is processed once a slot is free. Each request's refusal counts as `factory.refusals{reason="at_capacity"}`; a replay's background
comparison commit refused at capacity does not.
It is not `SESSION_BUDGET` (dollars per session) and not `SENTRY_RATE_LIMIT` (deliveries per window).

**How the skill drives it.** `drive.ts` sends `"x".repeat(100_001)` to a session that exists and
asserts the failure crosses the wire as `SessionError` with `code: "invalid_input"` — a client must be
able to branch on the code rather than parse prose. It then posts 2 MiB of junk to `/rpc` and asserts
413 followed by a `/livez` 200, so the refusal is a refusal and not a crash. `admission.sh` boots its
own API with `SESSION_MAX_CONCURRENT=2`, a 3 s idle timeout and a signed generic route, and
`admission.ts` fires two concurrent `createSession` calls (both admitted), asserts the third is
`SessionError` with `code: "at_capacity"` naming `SESSION_MAX_CONCURRENT=2`, posts a signed generic
delivery and asserts `503 at-capacity` with `Retry-After`, then — touching nothing, so the idle sweep
can release the owners — retries the refused create until it succeeds with an open owner (at least one
earlier attempt refused and every one the same typed refusal, so the request id was unclaimed by the
refusal), reads the sessions that filled the cap back as `historical` (the sweep freed the slot), and
redelivers the same delivery, which is `processed` with a session. `ADMISSION_CAP` must be at least 2:
the retried create and the redelivery each take a slot.

**Why those numbers.** 100,000 characters is generous for a task description and small enough that a
message cannot be used to push an unbounded body through the RPC endpoint; 1 MiB carries the largest
legal message (~400 KB of UTF-8 plus JSON framing) with headroom. Bun's own body default is 128 MiB —
128× larger, and enough for one unauthenticated upload to exhaust the process.

**What it does not prove.** Nothing about how a long message behaves against a real provider's
context window — that is compaction (LOB-27). Nothing about rate limits, which stay out of scope
here, except the existing Sentry route cap (`SENTRY_RATE_LIMIT`, [sentry.md](sentry.md)). The
concurrency cap is per process: two API processes on one database each admit N, and a per-board cap
read from the board definition is LOB-71. The core suite (`packages/core/src/SessionService.test.ts`,
"admission control") proves what a drive cannot reach deterministically: a burst of concurrent creates
admits exactly N with no row for the rest, concurrent sends to dormant sessions admit exactly N, and
fork, replay and a dormant send are refused while a send and a mission on an open owner are served; a
fork that fails after it was admitted hands its slot back; and a boot resumes a marked run and mission
at capacity, with their owners counted;
`apps/api/src/Api/AdmissionWebhooks.test.ts` proves the `503` and the redelivery for the generic and
Linear routes and the docs `push`.
