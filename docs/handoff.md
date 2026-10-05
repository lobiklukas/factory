# Handoff

State of the work and what to do next. Read `docs/design.md` before changing an architectural
decision — the decisions (D1–D16), the build order (M0–M7), and the open risks (R1–R6) are all
settled there and this document does not restate them.

Repo: `github.com/lobiklukas/factory` (private, `lobiklukas`), branch `main`, working tree clean,
all gates green (with Postgres up — see "Local environment").

## Where things stand

Last verified 2026-10-06 (after task 4): `format:check`, `build`, `lint`, `test`, `type-check` all
green; `.pi/skills/verify-web/drive.mjs` passes all five checks; `.pi/skills/verify-api/drive.ts`
passes all sixteen.

| Workspace                    | State                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                   | Control plane. `GET /` (health) and the session RPC surface at `POST /rpc`. Boots on `PORT` (9000), drives sessions over `PostgresStorage`, and hosts the harness in-process for local dev (see "Session notes"). |
| `apps/web`                   | Dashboard shell in React. Its card creates a session, sends a message, and streams the transcript (verified in a browser).                                                                                        |
| `apps/cli`                   | Bare `factory` root command, no subcommands. Installed bin is `factory`.                                                                                                                                          |
| `packages/domain`            | `Api.ts` (HttpApi), `Session.ts` (session contracts, incl. `SessionError`), `Rpc.ts` (the session RPC group). Knows nothing about Pi Durable.                                                                     |
| `packages/core`              | **New.** `SessionService`: create/get/send/interrupt/watch, the owner registry, id minting, idle eviction, and the live-vs-fold read split (D8).                                                                  |
| `packages/harness`           | Pi Durable wiring, and the only place that touches it: `openSession`, the projection into domain shapes, the faux/anthropic model backends, the M0 spike (`bun run m0`).                                          |
| `packages/storage-postgres`  | `PostgresStorage` (owner + reader modes), the `commits` and `sessions` migrations, health check. Passes the 23-case conformance suite.                                                                            |
| `packages/config-typescript` | Shared tsconfig presets (base, vite).                                                                                                                                                                             |

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
- **The session surface through the real Effect RPC client** — 16/16 checks in
  `.pi/skills/verify-api/drive.ts`, including typed errors (`SessionError{code: "not_found"}`)
  surviving the wire.
- **The same session in a browser** — 5/5 checks in `.pi/skills/verify-web/drive.mjs`, off
  `MODEL_BACKEND=faux`, with a real tool call and a real log.

### Not proven

- Anything on a cluster, and any isolation claim whatsoever (design R2).
- **Cross-process fan-out (D12).** Live streaming is in-process: the replica that owns a session
  streams it. A session owned by another process reads as `historical`, which is the honest answer
  while nothing can say who owns it (see task 7).
- Reader mode under a concurrent writer's load, and replay cost on a long log (see "Storage
  notes" below). Every historical read folds the whole log, once per read.
- `whenBusy` queueing and steering at the RPC surface: Pi Durable's queueing is exercised at the
  service level, and `busy` is a mapped error code, but no drive run forces a session to be busy
  deterministically (the faux turn is too fast) — see task 6.

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

**Where we are in the build order (design §4).** M2 is half done. The control plane exists and is
proven end to end — sessions, messages, interrupt, and both read paths — but M2 also names the CLI,
and `apps/cli` is still a bare root command. So: finish M2, close the two verification holes task 4
left open, then M3.

### Done so far

**1. ~~Resolve the streaming card.~~** The demo stream is gone, replaced by the session stream. Two
bugs hid behind one symptom (a scoped layer provided inside an atom's stream; `Queue.shutdown`
discarding the tail). Rules: `.pi/skills/verify-web/features/session-stream.md`.

**2. ~~Build the Postgres `Storage` backend (D7, M1).~~** Deviations recorded in D7: `log_id`
column, `seq` minted by the owner rather than `bigserial`, `json` not `jsonb`, immutable rows.

**3. ~~Prove the model path.~~** Open finding: `usage.tools` comes back `{}` even though a tool ran,
so per-tool rollups (R4) are unverified. Per-model usage and cost work.

**4. ~~Session entity and endpoints.~~** Met: 16/16 checks in `.pi/skills/verify-api/drive.ts`, plus
`packages/core`'s suite for the policy underneath. The three questions it raised were settled with
the user first (server-minted id = `log_id` plus a mutable title; the API hosts the harness
in-process behind a seam; a "message" is a thin Pi Durable submission and the wire carries our own
session-event schema). Two deviations from the plan, both recorded in the design:

- **`SessionBus` was not built** — it has no consumer while ownership is in-process (task 7).
- **`packages/core` and `packages/harness` took the work** the plan spread across
  `packages/storage-projection` and `packages/bus`. The fold already lives in `PostgresStorage`
  (`MemoryStorage`), so a projection package would have wrapped it for no gain.

### 5. `apps/cli` subcommands — this finishes M2

D9 puts the CLI first because dogfooding forces the session contract to be correct before a UI hides
a bug; the dashboard already found one race, and a terminal will find more. The contract is proven
already — the CLI is the same RPC client the dashboard builds (`apps/web/src/lib/rpc-client.ts`),
minus the browser.

Shape: `factory run "<task>"` (create, send, stream the transcript to the terminal until idle, print
the session id), `factory watch <session-id>` (attach to any session, live or historical — the mode
label is the interesting part), and `factory ls` (needs task 8).

_Done when:_ `.pi/skills/verify-cli/` drives it in a tmux session — create, stream, and show the
answer — pinned to `MODEL_BACKEND=faux` like the other skills, with evidence that survives cleanup.

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

### 8. Session list, and what the fold costs (R6)

M5's dashboard needs "which sessions exist", and nothing answers it today: the `sessions` table has
no status or activity, and a historical read folds a whole log (fine for one session, wrong for a
list — every partial the agent committed is a row). Decide deliberately: bound the fold by
compaction, or keep a derived projection table (D7 allows exactly this, and it must stay droppable).

_Done when:_ a list endpoint exists whose cost does not grow with the number of sessions, and
`factory ls` reads it.

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
- **Titles live in the log and in an index.** The `sessions` row (id, title, request id, created_at)
  is a droppable index; `factory.title` entries in the log are what make it rebuildable. The first
  message names a session that has no title yet.
- **The model backend is configuration.** `MODEL_BACKEND=anthropic|faux`, defaulting by whether
  `ANTHROPIC_API_KEY` is set. `faux` is pi-ai's scripted provider: it runs a _real_ `bash` tool call
  and answers with that output, so the tool path, the log, and the stream are real while the model
  is not. Every verification run uses it.
- **Session working directories** are `SESSION_ROOT/<session-id>` (`.factory/sessions` locally,
  gitignored). M6 replaces this with a per-session git worktree.

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
- The adapter takes an `SqlClient` and is Promise-shaped because Pi Durable's `Storage` is. Effect
  runs only inside it (`Effect.runPromise` around SQL).

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
