# Handoff

State of the work and what to do next. Read `docs/design.md` before changing an architectural
decision — the decisions (D1–D16), the build order (M0–M7), and the open risks (R1–R6) are all
settled there and this document does not restate them.

Repo: `github.com/lobiklukas/factory` (private, `lobiklukas`), branch `main`, working tree clean,
all gates green (with Postgres up — see "Local environment").

## Where things stand

Last verified 2026-10-06: `format:check`, `build`, `lint`, `test`, `type-check` all green, and
`.pi/skills/verify-web/drive.mjs` passes all three checks (shell, API reachability, streaming).

| Workspace                    | State                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                   | Control-plane skeleton. One HTTP API group (`GET /` → `"Hello Effect!"`) and the streaming RPC transport at `POST /rpc` (a `tick` demo stream). Boots on `PORT` (default 9000). Does not use Postgres yet. |
| `apps/web`                   | Dashboard shell in React. Its one card streams the demo RPC end to end (verified in a browser).                                                                                                            |
| `apps/cli`                   | Bare `factory` root command, no subcommands. Installed bin is `factory`.                                                                                                                                   |
| `packages/domain`            | `Api.ts` (HttpApi) and `Rpc.ts` (the demo `tick` stream group). No session types yet.                                                                                                                      |
| `packages/harness`           | Pi Durable wiring. One disposable M0 spike, `bun run m0` (works; runs over `MemoryStorage`, not Postgres).                                                                                                 |
| `packages/storage-postgres`  | **Done for M1.** `PostgresStorage` (owner + reader modes), the `commits` migration, connection, health check. Passes the 23-case conformance suite.                                                        |
| `packages/config-typescript` | Shared tsconfig presets (base, vite).                                                                                                                                                                      |

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

### Not proven

- `Harness.open` over `PostgresStorage` — the two have only been tested separately. Do this first
  in task 4; it is the first real integration of M0 and M1.
- Anything on a cluster, and any isolation claim whatsoever (design R2).
- Reader mode under a concurrent writer's load, and replay cost on a long log (see "Storage
  notes" below).

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

## What to do next

In order. Each task states its completion criterion.

**1. ~~Resolve the streaming card.~~** Done. Two bugs hid behind one symptom: a scoped layer
provided inside the atom's stream (closed the client before it sent a request), and
`Queue.shutdown` on the server (discarded the tail, including `end`). `drive.mjs` now requires
`end`. Details and the rules they imply: `.pi/skills/verify-web/features/rpc-stream.md`.

**2. ~~Build the Postgres `Storage` backend (D7, M1).~~** Done. Design deviations are recorded in
D7: `log_id` column, `seq` minted by the owner rather than `bigserial`, `json` not `jsonb`,
immutable rows.

**3. ~~Prove the model path.~~** Done. Open finding: `usage.tools` came back `{}` even though a
tool ran, so per-tool rollups (R4) are unverified. Per-model usage and cost work.

**4. Session entity and endpoints.** _Next._ Sessions, messages, interrupt, and a live stream,
following D8 (live attach when the sandbox runs, historical fold when it does not) and D12
(`SessionBus` over Postgres `LISTEN`/`NOTIFY`, in-process impl for local dev).
_Done when:_ a session can be created, driven, and replayed through the API, and `verify-api`
proves it by driving the real Effect RPC client rather than curl.

Suggested order, because each step de-risks the next:

1. `Harness.open(PostgresStorage.open(sql, { logId }), …)` and one turn — extend or replace the
   m0 spike. Confirm commits land in `commits` and a fresh `PostgresStorage` reopen in owner
   mode replays the transcript.
2. Define the session types in `packages/domain` (replace the demo `tick` stream). Decide the
   mapping `session id ↔ log_id` first: the natural choice is one `log_id` per session.
3. `SessionBus` service with an in-process Layer, then a Postgres `LISTEN`/`NOTIFY` Layer.
   `PostgresStorage` does **not** emit `NOTIFY` yet; that belongs in the owner's commit path or
   a trigger on `commits`.
4. Endpoints: create, send message, interrupt, stream. The historical stream is a reader-mode
   fold; the live stream attaches to the owning `Harness` (`viewState()`, `watch()`).
5. `verify-api` skill (task 5).

Things to settle with the user before building, not after: how a session is identified and
named, whether the API process owns the `Harness` in-process for local dev (D8 says the sandbox
owns it in production), and what a "message" is on the wire.

**5. Add the missing verification skills.** `.pi/skills/verify-api/` (drives the real client),
`.pi/skills/verify-policy/` (the negative tests from D15 — assert a push to `main` is refused),
and later `.pi/skills/verify-sandbox/` for M4. Also consider `.pi/skills/verify-storage/`: the
vitest suite proves the adapter, but nothing yet exercises it the way the control plane will.
_Done when:_ each skill's own instructions have been run once end to end, with evidence surviving
cleanup.

**6. Stop and ask before M7.** Nothing is provisioned in Google Cloud without explicit approval.
`apps/cli` needs real subcommands before it is worth a skill.

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

## Gotchas that cost time already

- **Port 3000 is often taken** on this machine and Vite is `strictPort`, so the dev server dies
  rather than relocating. Always launch through `.pi/skills/verify-web/up.sh`, which pairs
  `VITE_PORT` with the API's `ALLOWED_ORIGINS`.
- **Effect 4 is not Effect 3.** `Config.String` (not `Config.string`), `Effect.result` + `Result`
  (not `either` + `Either`), and a tagged error is yielded directly (no `Effect.fail` wrapper).
  The Effect language service reports these as `outdated-api` warnings, and warnings are errors.
- **`oxlint` runs with `denyWarnings: true`.** Fix the code; do not suppress the rule.
- **`.pi` and `.verify` are excluded from lint**, because skill helpers are Node tooling where
  `process.env`, `console`, and `fs` are correct.
- **pi-ai is ESM-only.** `require.resolve` on its subpaths fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`
  even though the export map lists them. Bun and Vitest are fine.
- **Local kind cannot run gVisor**, so no local run ever proves isolation (design R2).
- **Lint bans `async` function declarations and methods** (`effecttsgo(async-function)`), plus
  `Date.now`, `Math.random`, `crypto.randomUUID`, `JSON.parse`/`stringify`, `this` aliasing, and
  `unknown` in an Effect's error channel. At a Promise boundary (Pi Durable is Promise-based) write
  `Promise.resolve().then(…)` chains and `Effect.runPromise(effect)`; use
  `Effect.gen({ self: this }, function* () {…})` to use `this`; use
  `Schema.fromJsonString(Schema.Unknown)` for JSON text; use `Clock`/`Random` in tests. Async
  _arrow_ functions are not flagged.
- **`Effect.gen(this, …)` is Effect 3 syntax**; in Effect 4 it is `Effect.gen({ self: this }, …)`.
  The wrong form fails at runtime with `this` undefined, not at compile time.
- **`Data.TaggedError` has an empty `message`** unless you override it. Pi Durable surfaces storage
  errors as plain `Error`s and its tests match on message text, so define
  `override get message()`.
- **`@effect/sql-pg` rewrites JSON keys** (`transformJson`, and snake/camel result transforms, are
  on in `PostgresLive`). Anything that stores arbitrary JSON must cast to text on the way in and
  out (`${text}::json`, `col::text`) — as `PostgresStorage` does — or its keys will be renamed.
- **Test results from `turbo` can be cached.** `packages/storage-postgres` opts out
  (`turbo.json`) because its result depends on a live database; keep that for any suite with an
  external dependency.
- **Turbo writes a managed block into `AGENTS.md`** before repository-scoped commands. Keep it
  committed; the conventions below live after it on purpose.
