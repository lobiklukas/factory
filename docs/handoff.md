# Handoff

State of the work and what to do next. Read `docs/design.md` before changing an architectural
decision — the decisions (D1–D16), the build order (M0–M7), and the open risks (R1–R6) are all
settled there and this document does not restate them. `docs/features.md` sits beside them: it
ranks _what to build next and why_ from the code audit, the Pi Durable API surface, and a survey of
13 comparable products, and it changes no decision.

Repo: `github.com/lobiklukas/factory` (private, `lobiklukas`), branch `main`, working tree clean,
all gates green (with Postgres up — see "Local environment").

## Where things stand

Last verified 2026-10-05 (after the repo binding and the session list): `format:check`, `build`,
`lint`, `test`, `type-check` all green; `.pi/skills/verify-web/drive.mjs` passes all ten checks;
`.pi/skills/verify-api/drive.ts` passes all twenty-five; `packages/core`'s suite passes ten.

| Workspace                    | State                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                   | Control plane. `GET /` (health) and the session surface at `POST /rpc` — create, get, send, interrupt, list, registerRepo, watch. Boots on `PORT` (9000), drives sessions over `PostgresStorage`, and hosts the harness in-process for local dev (see "Session notes").                                                                                                                                                     |
| `apps/web`                   | Dashboard shell in React on TanStack Router (`/`, `/sessions/$sessionId`, `/sandboxes`, `/approvals`). Icon rail plus a browser-local session list beside a pane that creates a session, streams its transcript, and labels the read path (verified in a browser). `listSessions` exists now, so M5 can replace that browser-local list with a server read. `/sandboxes` and `/approvals` are named gaps, not empty tables. |
| `apps/cli`                   | Bare `factory` root command, no subcommands. Installed bin is `factory`. LOB-7 was paused mid-flight: the partial `run`/`watch`/`ls` work is preserved (not applied) at `.verify/scratch/paused-agents/`.                                                                                                                                                                                                                   |
| `packages/domain`            | `Api.ts` (HttpApi), `Session.ts` (session, repo, workspace and list contracts, incl. `SessionError`), `Rpc.ts` (the session RPC group). Knows nothing about Pi Durable.                                                                                                                                                                                                                                                     |
| `packages/core`              | **New.** `SessionService`: create/get/send/interrupt/list/registerRepo/watch, the owner registry, id minting, idle eviction, repo binding and workspace resolution, the derived `session_activity` index, and the live-vs-fold read split (D8). `rebuild.ts` folds every log back into the index tables.                                                                                                                    |
| `packages/harness`           | Pi Durable wiring, and the only place that touches it: `openSession`, the projection into domain shapes, the faux/anthropic model backends, the M0 spike (`bun run m0`).                                                                                                                                                                                                                                                    |
| `packages/storage-postgres`  | `PostgresStorage` (owner + reader modes), six migrations (`commits`, `sessions`, `repos`, `session_activity`, `sessions.repo`/`base_ref`), health check. Passes the 23-case conformance suite.                                                                                                                                                                                                                              |
| `packages/config-typescript` | Shared tsconfig presets (base, vite).                                                                                                                                                                                                                                                                                                                                                                                       |

### Proven

- Pi Durable 1.0.3 + `pi-ai` + `chord` run on bun.
- **A live model turn** (`bun run m0`): `claude-sonnet-5-5` called `bash`, the tool result came
  back into the transcript, and `harness.usage()` returned per-model tokens and cost.
- **Postgres `Storage`**: pi-durable's `registerStorageConformance` passes 23/23 against
  Postgres and 23/23 against the `MemoryStorage` control, plus our own tests for reopen/replay,
  U+0000 and lone surrogates, per-log isolation, reader mode, second-owner fencing, rejected
  commits not poisoning, and the append-only trigger. All in
  `packages/storage-postgres/src/PostgresStorage.test.ts`.
- **Streaming RPC over HTTP** from browser to server (NDJSON), through the real Effect client.
- **`Harness` over `PostgresStorage`** — the first real integration of M0 and M1
  (`packages/harness/src/session.test.ts`): one turn with a real `bash` tool call, commits landing in
  `commits`, a fresh owner-mode reopen replaying the identical transcript, and the transcript
  continuing rather than restarting.
- **A session, end to end, with two read paths that agree** (`packages/core/src/SessionService.test.ts`
  and `.pi/skills/verify-api`): create, send, live stream (`snapshot` → entries → `busy` → `idle`),
  read, release, fold, resume. The folded entries equal the live ones they replaced, and a
  historical stream is exactly one `snapshot` and then ends.
- **The session surface through the real Effect RPC client** — 25/25 checks in
  `.pi/skills/verify-api/drive.ts`, including typed errors (`SessionError{code: "not_found"}`,
  `invalid_input` for a message over the cap) surviving the wire.
- **A session bound to a repo** (LOB-5, `packages/core`'s suite and `verify-api`):
  `createSession({ repo, baseRef })` returns a summary carrying both, the snapshot's `workspace`
  names the session's own directory plus the commands read from the repo's `.factory/config`, and a
  repo with no config opens with `commandsSource: "none"`. The binding is a `factory.session`
  document in the log, so `sessions.repo`/`base_ref` and the `repos` row are derivable from it.
- **The session list without a fold** (LOB-6): `listSessions` answers from the derived
  `session_activity` index in **one SQL statement whatever the row count** — asserted by counting
  statements through `Statement.CurrentTransformer` over 3 rows and 30 — pages by keyset cursor
  without repeating a row, and orders by newest activity. `rebuildIndexes` empties-and-rebuilds the
  claim: `DELETE FROM sessions`, rebuild, and every list field (title, repo, base ref, spend,
  creation time) comes back from the logs alone.
- **The same session in a browser** — 10/10 checks in `.pi/skills/verify-web/drive.mjs`, off
  `MODEL_BACKEND=faux`, with a real tool call and a real log: the root redirect, the sidebar's honest
  empty state, the route moving to the created session, the header labelling the read path, the
  session landing in the sidebar, a bad id refused locally, and both milestone routes naming what is
  missing.

### Not proven

- Anything on a cluster, and any isolation claim whatsoever (design R2).
- **Cross-process fan-out (D12).** Live streaming is in-process: the replica that owns a session
  streams it. A session owned by another process reads as `historical`, which is the honest answer
  while nothing can say who owns it (see task 7).
- Reader mode under a concurrent writer's load, and replay cost on a long log (see "Storage
  notes" below). Every historical read folds the whole log, once per read.
- **A historical read through the dashboard.** `verify-web/up.sh` keeps `SESSION_IDLE_TIMEOUT_MS`
  long so the pane stays live, and `.pi/skills/verify-api` owns the fold path. The header label
  renders either way, so the check is that string the day someone drives a fold through the UI.
- `whenBusy` queueing and steering at the RPC surface: Pi Durable's queueing is exercised at the
  service level, and `busy` is a mapped error code, but no drive run forces a session to be busy
  deterministically (the faux turn is too fast) — see task 6. `FAUX_COMMAND` is now configurable
  (`FAUX_COMMAND="sleep 5 && echo faux-ok"`), so a verification run can hold that window open; the
  activity index's `status` is asserted at rest and on release, not during a run.
- **`rebuildIndexes` has no caller at runtime.** It is the D7 recovery path and its test drives it,
  but no app or CLI invokes it, so the operator story for a lost index table is "read `packages/core/src/rebuild.ts`".
- **The list's cost under load.** One statement per page is asserted in a unit test; nothing
  measures `listSessions` against a large `session_activity` table or a slow database.
- **Sessions that predate migration `0005`.** Their activity row is backfilled from the `sessions`
  index (status `idle`, `last_activity_at` = the row's `created_at`), not from their logs, until a
  rebuild runs.

## Local environment

- **Postgres:** `docker compose up -d --wait postgres` (host port **5442**, user/password/db all
  `factory`). `bun run test` needs it and **fails loudly rather than skipping** when it is down.
  `DATABASE_URL` defaults to `postgres://factory:factory@localhost:5442/factory`.
- **Docker on this machine:** the active docker context is Docker Desktop, which is not running;
  Colima is. Use `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` rather than
  changing the global context. Port 5432 is held by an unrelated `ssh` tunnel, hence 5442.
- **Model key:** `ANTHROPIC_API_KEY` in the repo-root `.env` (gitignored). `bun run m0` loads it
  from the root whether run from the root or from `packages/harness`.
- **Browser verification:** `.pi/skills/verify-web/up.sh`, then `node drive.mjs`, then `down.sh`.
- **API verification:** `.pi/skills/verify-api/up.sh`, then `bun drive.ts`, then `down.sh`. Both
  skills need Postgres and both pin `MODEL_BACKEND=faux`, so neither needs a key or the network.

## What to do next

**The brief for a fresh session is `docs/next-agent.md`** — it names the issues for this stretch, the
gates, and the traps. This section is the longer view behind it.

**Where we are in the build order (design §4).** M2 is half done. The control plane exists and is
proven end to end — sessions, messages, interrupt, and both read paths — but M2 also names the CLI,
and `apps/cli` is still a bare root command. So: finish M2 (LOB-7,
LOB-21), close the two verification holes task 4 left open, then M3 — with milestone **B** (the board,
`docs/board.md`) running alongside it as the operator surface everything after is driven from.

### Done so far

**1. ~~Resolve the streaming card.~~** The demo stream is gone, replaced by the session stream. Two
bugs hid behind one symptom (a scoped layer provided inside an atom's stream; `Queue.shutdown`
discarding the tail). Rules: `.pi/skills/verify-web/features/session-stream.md`.

**2. ~~Build the Postgres `Storage` backend (D7, M1).~~** Deviations recorded in D7: `log_id`
column, `seq` minted by the owner rather than `bigserial`, `json` not `jsonb`, immutable rows.

**3. ~~Prove the model path.~~** Open finding: `usage.tools` comes back `{}` even though a tool ran,
so per-tool rollups (R4) are unverified. Per-model usage and cost work.

**4. ~~Session entity and endpoints.~~** Met: 25/25 checks in `.pi/skills/verify-api/drive.ts`, plus
`packages/core`'s suite for the policy underneath. The three questions it raised were settled with
the user first (server-minted id = `log_id` plus a mutable title; the API hosts the harness
in-process behind a seam; a "message" is a thin Pi Durable submission and the wire carries our own
session-event schema). Two deviations from the plan, both recorded in the design:

- **`SessionBus` was not built** — it has no consumer while ownership is in-process (task 7).
- **`packages/core` and `packages/harness` took the work** the plan spread across
  `packages/storage-projection` and `packages/bus`. The fold already lives in `PostgresStorage`
  (`MemoryStorage`), so a projection package would have wrapped it for no gain.

**4b. Repo binding and the session list (LOB-5, LOB-6 — 2026-10-05).** A session names its repo, at a
base ref; the log records the binding (`factory.session`) and the index carries it, so the summary
never folds. `listSessions` answers from the derived `session_activity` index. Both are in "Proven"
with the checks that establish them, and `rebuildIndexes` is the recovery path for the index tables.
This is what `createSession({ repo, baseRef })` needed to be worth anything downstream: a trigger
(LOB-14) binds an issue to a repo, a sandbox (LOB-13) mounts it, and M6 cuts a worktree from it.

### 5. `apps/cli` subcommands — this finishes M2

**Paused mid-flight (2026-10-05).** A subagent wrote `factory run` / `watch` / `ls` against
`SessionRpc` and wired them into the root command, then was stopped by the user before it built
`.pi/skills/verify-cli/` or ran anything. Its work is preserved but **not applied** at
`.verify/scratch/paused-agents/` (patch + new files + a README saying what is there and what is
missing); read it as a reviewer rather than trusting it.

D9 puts the CLI first because dogfooding forces the session contract to be correct before a UI hides
a bug; the dashboard already found one race, and a terminal will find more. The contract is proven
already — the CLI is the same RPC client the dashboard builds (`apps/web/src/lib/rpc-client.ts`),
minus the browser.

Shape: `factory run "<task>" --repo <owner/name>` (create, send, stream the transcript to the
terminal until idle, print the session id), `factory watch <session-id>` (attach to any session, live
or historical — the mode label is the interesting part), and `factory ls` (reads `listSessions`,
which now exists).

_Done when:_ `.pi/skills/verify-cli/` drives it in a tmux session — create, stream, and show the
answer, plus `ls` showing a session the server knows about — pinned to `MODEL_BACKEND=faux` like the
other skills, with evidence that survives cleanup.

### 6. Close task 4's two verification holes

Cheap, and they are the only claims in this repo that nothing currently checks.

- **Steering.** The faux turn is too fast to be reliably busy, so `placement` and the `busy` error
  code are unproven at the RPC surface. Force the window: a faux script whose command sleeps, then
  assert `sendMessage` reports `placement: "followUp"` and `whenBusy: "reject"` fails with
  `code: "busy"`.
- **`usage.tools`** (finding from task 3) is `{}` with both providers. Either find what carries it
  or drop per-tool rollups from R4's claims — an unverified cost claim is worse than an absent one.

_Done when:_ both are asserted in a suite or a drive run, or explicitly withdrawn in the design.

### 7. Presence and `SessionBus` — makes D12 true

A second replica cannot stream a session another replica owns, because nothing can say who owns
what. Two pieces, in this order, and the first is the one that matters:

1. **Presence.** Which process owns a session, with a lease and a heartbeat. Today ownership _is_
   "the registry in this process has it", which is only true on one replica. A Postgres lease table
   is enough to make it real locally and is what a sandbox will renew in M4.
2. **`SessionBus`** (`packages/bus`): an in-process Layer and a Postgres `LISTEN`/`NOTIFY` Layer —
   an `AFTER INSERT` trigger on `commits` calling `pg_notify` with a **cursor** (`log_id`, `seq`),
   not an event (`NOTIFY` payloads cap at 8000 bytes, and D7 makes the log truth). The subscriber
   reads the log from the cursor, so the notification is a hint.

Then `SessionService.events` gains its third branch: not owned here, but owned _somewhere_ → stream
from notices instead of folding once and ending, which is what the `mode: "historical"` contract
promises today (`.pi/skills/verify-api/features/fold.md` needs updating with it).

_Done when:_ two `SessionService` instances over one database — one owning, one not — stream the same
session live, and a drive run proves it.

### 8. ~~Session list, and what the fold costs (R6)~~

**Done (LOB-6, 2026-10-05).** Decided the derived-projection way, deliberately: `session_activity`
holds `status`, `cost_total`, and `last_activity_at`, written as this process observes a session's
committed changes, joined to `sessions` for identity. `listSessions` is therefore one statement
whatever the row count (asserted by counting statements), pages by keyset cursor, and `rebuildIndexes`
re-derives all three index tables by folding the logs. `factory ls` (LOB-7) is now the only consumer
missing. What is still open from this item: compaction for long logs (LOB-27) and the list's cost
under load — both named in "Not proven".

### 8b. LOB-21 — readiness, shutdown and request limits (paused mid-flight)

The deployment floor: `/livez` and `/readyz`, a SIGTERM handler that calls `SessionService.close`, a
request-body cap, and a typed `invalid_input` error code. The error code and the message-length cap
landed with 4b (`SessionService.send` refuses over `MAX_MESSAGE_CHARS` = 100,000; `verify-api` proves
the typed error over the wire). The rest was paused: a subagent wrote `apps/api/src/Api/Probes.ts`
(`/livez` as a constant 200; `/readyz` as live checks over Postgres, the six migration ids, and the
control-plane tables) and restructured `apps/api/src/index.ts` to bind the server without
`Layer.orDie` on migrations, plus a `maxRequestBodySize` config — but the SIGTERM finalizer and every
piece of evidence were still missing when it was stopped. That work is preserved, not applied, at
`.verify/scratch/paused-agents/`.

Two design points to carry into it: a liveness probe must not depend on the database (Kubernetes
would restart a healthy pod and turn an outage into a crash loop), and readiness that cannot answer
while Postgres is down is not readiness — boot the server, report 503, and let requests fail with the
typed `SessionError` codes.

_Done when:_ a SIGTERM mid-run leaves a resumable session, an oversized request is refused rather
than crashing, `/readyz` reports 503 while `/livez` stays 200, and the existing `verify-api` checks
still pass. `FAUX_COMMAND` (configurable since 4b) is what holds a run open for the SIGTERM case.

### 9. M3 — local dependencies

Docker provider for Postgres and the sandbox image; `CredentialProvider` with a static-token
implementation; the policy service with hook enforcement and the D11 boundary (D15). Policy is the
interesting one: it is data, not logic, and its negative cases are exactly what
`.pi/skills/verify-policy/` should assert — a push to `main` is refused, force-push and ref deletion
are refused, writes outside the worktree are refused.

_Done when:_ a session's tool calls are policed by configuration, and `verify-policy` proves the
refusals rather than the happy path.

### 10. M4 — Kubernetes tier, and the skill it needs

`Kubernetes.LocalCluster` (kind), the released `agent-sandbox` manifest, and
`packages/sandbox-kubernetes`. Validates `Sandbox` lifecycle, pause/resume, PVC persistence, and
warm-pool behavior — and _nothing else_: kind cannot run gVisor, so a green local suite still says
nothing about isolation (R2). This is also where presence gets a real owner — a sandbox renewing a
lease rather than a replica — and where the sandbox's PVC becomes the working directory that M6 turns
into a git worktree.

_Done when:_ `.pi/skills/verify-sandbox/` drives create → pause → resume → destroy against kind, and
the handoff stops calling isolation unverified.

### 11. Stop and ask before M7

Nothing is provisioned in Google Cloud without explicit approval. M7 is where isolation is finally
tested, and it needs a dedicated cluster, a gVisor node pool, and the GitHub rulesets from D15.

## Session notes

How a session works now, so the next agent does not have to re-derive it:

- **A session is one `log_id`, and the id is the `log_id`.** Minted server-side as `ses_` + ten
  Crockford base32 characters of millisecond timestamp + sixteen of randomness: sortable, unique,
  and safe in a URL _and_ in a git branch (D10). `packages/core/src/ids.ts`.
- **Ownership is per process, and one process owns a log.** `SessionService` holds a registry of
  open owners, guarded by a semaphore so two callers cannot open the same log twice (the second
  `PostgresStorage` in owner mode would poison itself on its first append). Locally the API process
  is the sandbox, so this is D3 instantiated rather than D8 violated; when the harness moves into a
  sandbox, the registry is the seam.
- **Live vs historical is decided by the registry, not by a flag.** Owned here → the stream attaches
  to `viewState()` and reports `mode: "live"`; not owned → a reader-mode storage folds the log and
  reports `mode: "historical"`, and the stream sends one `snapshot` and ends. Both paths project the
  same _active_ transcript (newest head marker onward), so they agree entry for entry — asserted in
  both the core suite and the API drive.
- **The projection diffs whole views.** Entries only append, so an `entry` event is never an update;
  documents (`pi.live`, `pi.usage`) are compared by reference, because Chord publishes immutable
  revisions and shares unchanged data. So a subscriber that falls behind still converges.
- **Idle means untouched.** A read counts as use, so a client watching a session keeps its owner
  open; the sweep closes owners that nobody has touched for `SESSION_IDLE_TIMEOUT_MS` (15 min by
  default, and only when idle — a run in flight is durable either way, but closing it would throw
  away the fold a live client is streaming from). Sweeps run at least twice per timeout window.
- **Titles live in the log and in an index.** The `sessions` row (id, title, repo, base ref,
  request id, created_at) is a droppable index; `factory.title` entries and the `factory.session`
  document in the log are what make it rebuildable. The first message names a session that has no
  title yet.
- **A session's repo binding is a document, not an entry** (`factory.session`, written once at
  create; empty strings mean "no repo"). It is state, not transcript, so the agent never sees it —
  and `rebuildIndexes` reads it back to rebuild `sessions.repo`/`base_ref` and the `repos` row. A
  repo the session names is registered on first use with no clone URL; `registerRepo` is what fills
  in the URL and a local checkout.
- **The workspace is resolved per read, and the session's own directory wins.** `SessionWorkspace`
  is `{ path, repo?, baseRef?, commands, commandsSource }`: `path` is `SESSION_ROOT/<owner>/<name>/
<session-id>` when bound (`SESSION_ROOT/<session-id>` otherwise), and `commands` comes from a
  `.factory/config` first in that directory and then in the registry's `local_path`. A missing or
  undecodable config is `commandsSource: "none"` with a warning, never an error — a repo that says
  nothing about itself must still open.
- **The list index is written from observation, not from reads.** While a process owns a session, a
  fiber projects that session's committed changes into `session_activity` (status on `status`
  events, spend on `usage`, `last_activity_at` on anything), and releasing an owner writes `idle` —
  nobody owns it, so nothing is running (D8). `listSessions` never folds: it is one statement over
  that table joined to `sessions`. The projection is best-effort (`Effect.ignore`): a failed upsert
  must never fail a session.
- **`rebuildIndexes` (`packages/core/src/rebuild.ts`) is the D7 recovery path.** It enumerates
  `SELECT DISTINCT log_id FROM commits`, skips ids that are not session ids (the `commits` table is
  shared with the harness suite's fixtures), folds each log with a reader storage, and rewrites
  `sessions`, `session_activity`, and any repo slug it finds. Operator input survives: `repos.url`
  and `repos.local_path` are kept, and a slug the log names is inserted with no URL.
- **The model backend is configuration.** `MODEL_BACKEND=anthropic|faux`, defaulting by whether
  `ANTHROPIC_API_KEY` is set. `faux` is pi-ai's scripted provider: it runs a _real_ `bash` tool call
  and answers with that output, so the tool path, the log, and the stream are real while the model
  is not. Every verification run uses it, and `FAUX_COMMAND` overrides the command it runs — which
  is how a verification run holds a turn open long enough to be busy.
- **Session working directories** are `SESSION_ROOT/<session-id>` for a scratch session and
  `SESSION_ROOT/<owner>/<name>/<session-id>` for a repo-bound one (`.factory/sessions` locally,
  gitignored), one directory per session so two sessions never share files. The snapshot's
  `workspace.path` is the resolved answer, and M6 replaces this with a per-session git worktree.

## Storage notes

How `PostgresStorage` works, so the next agent does not have to re-derive it:

- **The log is truth, `MemoryStorage` is the fold.** Every commit goes through
  `MemoryStorage.prepareCommit` (validation, id minting, seq assignment), is appended to
  `commits`, and only then `apply()`ed. Reads are all served from the in-memory fold. Pi
  Durable's JSONL backend is built the same way; read
  `node_modules/.bun/@earendil-works+pi-durable*/…/dist/storage/jsonl/storage.js` for the
  reference.
- **Owner mode** is the single writer for a `log_id`. A second owner's append collides on
  `PRIMARY KEY (log_id, seq)` and that instance is **poisoned** (every later call rejects; reopen
  it). A commit rejected by validation is _not_ poisoned and writes nothing.
- **Reader mode** runs `SELECT … WHERE seq > lastSeq` before every read. It is correct but costs a
  query per read; when the control plane serves many reads, drive catch-up from `NOTIFY` instead.
- **No snapshots.** Opening a log replays all of it, and the whole fold lives in memory. Fine
  for a session's lifetime today; revisit with a snapshot/checkpoint if long sessions make open
  slow (it is a replay of `commits` in batches of 500).
- **`writes` is `json`, not `jsonb`**, on purpose: strings must round-trip, and `jsonb` rejects
  lone surrogates and U+0000. Nothing queries inside it.
- **`seq` is read back as `Number`.** Safe far beyond any realistic log; noted so nobody is
  surprised by a `bigint` column.
- **The adapter takes an `SqlClient` and is Promise-shaped because Pi Durable's `Storage` is. Effect
  runs only inside it (`Effect.runPromise` around SQL).
- **Three tables are derived, and every column in them is a fold of `commits`** (`docs/handoff.md`
  §Where things stand, D7). `sessions` (id, title, request id, repo, base ref, created at) and
  `session_activity` (status, cost, last activity) are the control plane's index; `repos` (slug, url,
  default base ref, local path, registered at) is the registry. None is a source of truth: drop any
  of them and `packages/core/src/rebuild.ts` folds the logs back into all three. `repos.url` and
  `repos.local_path` are the only columns the log cannot reconstruct.
- **`session_activity` hangs off `sessions`** with `ON DELETE CASCADE`, and migration `0005`
  backfills it from `sessions` so a pre-existing database does not silently lose sessions from the
  list. Its `last_activity_at` is a `TIMESTAMPTZ` on purpose: the keyset cursor carries the exact
  value Postgres ordered by, so pagination cannot skip or repeat a row.
- **`sessions.repo` is nullable and `base_ref` is only allowed next to a repo** (a CHECK constraint),
  so "no repo" is one state rather than two. Migration `0006` leaves existing rows `NULL` rather than
  guessing a binding from the id.

## Deliberately not built

Missions (v2 — but note Pi Durable already supplies the primitives: `defineTask` with phases and
`waiting`/`on`/`failFast`, the ownership tree with bottom-up `abort`, `defineDoc`, and subagents as
owned conversations), automations, AutoWiki, Agent Readiness scoring, Slack/Linear/Jira
delegation, any diff or review UI (review is GitHub's, per D16), and the Cloudflare executor
(interface only, per D6).

Of the design's component inventory (§3), these do not exist yet, and none of them is an oversight:

| Package                       | Status                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `packages/bus`                | Not built; needs presence first — task 7.                    |
| `packages/storage-projection` | Not built; the fold lives in `PostgresStorage` — task 8.     |
| `packages/sandbox`            | M4.                                                          |
| `packages/sandbox-kubernetes` | M4.                                                          |
| `infra`                       | M3 (Docker) and M7 (GKE); nothing is provisioned until then. |

## Gotchas that cost time already

- **Port 3000 is often taken** on this machine and Vite is `strictPort`, so the dev server dies
  rather than relocating. Always launch through `.pi/skills/verify-web/up.sh`, which pairs
  `VITE_PORT` with the API's `ALLOWED_ORIGINS`.
- **Pi Durable ids are branded numbers.** `SubmissionId`, `EntryId`, `ConversationId` are
  `number & {…}`, not strings. `String(id)` for a wire field is fine, but never stringify an id you
  are going to look up again (`harness.submission("8")` finds nothing; `harness.submission(8)`
  works). The projection stringifies entry ids for the API contract on purpose.
- **A scripted tool-calling answer needs `stopReason: "toolUse"`.** With pi-ai's faux provider, an
  assistant message carrying a tool call but `stopReason: "stop"` is a _final_ answer: the
  generation never runs the tool and the transcript has no tool result. This cost an hour.
- **Effect 4 is not Effect 3.** `Config.String` (not `Config.string`), `Effect.result` + `Result`
  (not `either` + `Either`), and a tagged error is yielded directly (no `Effect.fail` wrapper).
  The Effect language service reports these as `outdated-api` warnings, and warnings are errors.
- **`oxlint` runs with `denyWarnings: true`.** Fix the code; do not suppress the rule.
- **`.pi` and `.verify` are excluded from lint**, because skill helpers are Node tooling where
  `process.env`, `console`, and `fs` are correct.
- **pi-ai is ESM-only.** `require.resolve` on its subpaths fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`
  even though the export map lists them. Bun and Vitest are fine.
- **Local kind cannot run gVisor**, so no local run ever proves isolation (design R2).
- **Lint bans `async` anywhere** (`effecttsgo(async-function)`) — declarations, methods, _and_
  arrows, which the previous version of this note got wrong. At a Promise boundary (Pi Durable is
  Promise-based) either write `Promise.resolve().then(…)` chains, as `PostgresStorage` does, or keep
  the boundary inside `Effect.gen` with `Effect.tryPromise` — that is what `packages/harness` does,
  and it is why `packages/core` needs no Pi Durable types at all. Also banned: `Date.now`,
  `Math.random`, `crypto.randomUUID`, `JSON.parse`/`stringify`, `this` aliasing, and `unknown` in an
  Effect's error channel. Use `Effect.gen({ self: this }, function* () {…})` for `this`;
  `Schema.fromJsonString(Schema.Unknown)` for JSON text; `Clock`/`Random` in tests.
- **Effect 4 renamed things you will reach for by reflex.** `Layer.effect` (there is no
  `Layer.scoped`), `Effect.forkChild` (no `Effect.fork`), `Effect.andThen` (no `Effect.zipRight`),
  `Stream.unwrap` (no `Stream.unwrapScoped`), `Effect.orElseSucceed`, `Config.Literals`. Two more
  that fail _type-check_, not runtime: use `Schema.Finite` rather than `Schema.Number` for counters
  (`schema-number` warns, and warnings are errors), and remember `Schema.optional` accepts an absent
  key _and_ an explicit `undefined`, while `Schema.optionalKey` rejects `undefined` — use `optional`
  for anything a client can send.
- **Bun cannot resolve workspace packages from `.pi/`** unless the root manifest declares them.
  `.pi/skills/verify-api/drive.ts` imports `@repo/domain` and `effect` for that reason: they are root
  devDependencies, so skill helpers are runnable with `bun` from the repo root and need no install
  of their own.
- **`Effect.gen(this, …)` is Effect 3 syntax**; in Effect 4 it is `Effect.gen({ self: this }, …)`.
  The wrong form fails at runtime with `this` undefined, not at compile time.
- **`Data.TaggedError` has an empty `message`** unless you override it. Pi Durable surfaces storage
  errors as plain `Error`s and its tests match on message text, so define
  `override get message()`.
- **`@effect/sql-pg` rewrites JSON keys** (`transformJson`, and snake/camel result transforms, are
  on in `PostgresLive`). Anything that stores arbitrary JSON must cast to text on the way in and
  out (`${text}::json`, `col::text`) — as `PostgresStorage` does — or its keys will be renamed.
- **Test results from `turbo` can be cached.** `packages/storage-postgres`, `packages/harness`, and
  `packages/core` opt out (`turbo.json`, `cache: false`) because their results depend on a live
  database; keep that for any suite with an external dependency, or a cached pass will outlive the
  Postgres it lied about.
- **Turbo writes a managed block into `AGENTS.md`** before repository-scoped commands. Keep it
  committed; the conventions below live after it on purpose.
