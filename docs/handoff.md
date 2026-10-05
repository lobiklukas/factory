# Handoff

State of the work and what to do next. Read `docs/design.md` before changing an architectural
decision — the decisions (D1–D16), the build order (M0–M7), and the open risks (R1–R6) are all
settled there and this document does not restate them.

Repo: `github.com/lobiklukas/factory` (private, `lobiklukas`), branch `main`, working tree clean,
all gates green.

## Where things stand

| Workspace                    | State                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                   | Control-plane skeleton. One HTTP API group (`GET /` → `"Hello Effect!"`) and the streaming RPC transport mounted at `POST /rpc`. Boots on `PORT` (default 9000). |
| `apps/web`                   | Dashboard shell in React. Renders; its one card is broken (see below).                                                                                           |
| `apps/cli`                   | Bare `factory` root command, no subcommands. Installed bin is `factory`.                                                                                         |
| `packages/domain`            | `Api.ts` (HttpApi) and `Rpc.ts` (the streaming RPC group). Everything else demo-shaped was pruned.                                                               |
| `packages/harness`           | Pi Durable wiring. Contains one disposable M0 spike: `bun run m0`.                                                                                               |
| `packages/storage-postgres`  | Connection, migrations, health check. No `Storage` implementation yet.                                                                                           |
| `packages/config-typescript` | Shared tsconfig presets (base, vite).                                                                                                                            |

Proven working: Pi Durable 1.0.3 + `pi-ai` + `chord` install and run on bun; `Harness.open` over
`MemoryStorage` with `NodeExecutionEnv` and `CodingTools`; and pi-durable's **23-case storage
conformance suite passes against `MemoryStorage`** behind a ~40-line assertions adapter. That
suite is the M1 oracle.

Not proven: a live model turn (no `ANTHROPIC_API_KEY` was available), anything on a cluster, and
any isolation claim whatsoever.

## Known failure, reproduced with evidence

**The streaming RPC card on the dashboard does nothing when clicked.** The click is delivered,
`VITE_SERVER_URL` is inlined correctly, and the browser reaches the API across origins — yet no
request to `/rpc` is ever issued and no error surfaces. The failure is therefore in the
client-side atom wiring (`runtime.fn` + `useAtom`), not the server, the URL, or CORS. Full
diagnostic table in `.pi/skills/verify-web/features/rpc-stream.md`.

This matters beyond the card: it is the only end-to-end check of the streaming transport that
session event streams depend on (design D8/D9).

## What to do next

In order. Each task states its completion criterion.

**1. Resolve the streaming card.** Either repair the atom wiring, or delete the card when the real
session event stream replaces it. Do not leave it as-is: an end-to-end check that silently proves
nothing is worse than no check.
_Done when:_ `.pi/skills/verify-web/drive.mjs` reports PASS for the streaming path (or the card is
gone and the feature map is updated to match).

**2. Build the Postgres `Storage` backend (design D7, M1).** Append-only `commits(seq bigserial,
writes jsonb)` plus the single fold of the log into state, with a read-only non-owning mode so the
control plane can read without opening a `Harness`.
_Done when:_ pi-durable's `registerStorageConformance` runs as a vitest suite in
`packages/storage-postgres` and every case passes against Postgres, with the same case count as
`MemoryStorage` (23 at the time of writing).

**3. Prove the model path.** Run `bun run m0` with `ANTHROPIC_API_KEY` set in `.env`. It submits one
turn that calls the bash tool and prints the transcript and usage.
_Done when:_ the spike prints a transcript containing the tool call and a usage object.

**4. Session entity and endpoints.** Sessions, messages, interrupt, and a live stream, following
`docs/design.md` D8 (live attach when the sandbox runs, historical fold when it does not) and D12
(`SessionBus` over Postgres `LISTEN`/`NOTIFY`, in-process impl for local dev).
_Done when:_ a session can be created, driven, and replayed through the API, and `verify-api`
proves it by driving the real Effect RPC client rather than curl.

**5. Add the missing verification skills.** `.pi/skills/verify-api/` (drives the real client),
`.pi/skills/verify-policy/` (the negative tests from D15 — assert a push to `main` is refused),
and later `.pi/skills/verify-sandbox/` for M4.
_Done when:_ each skill's own instructions have been run once end to end, with evidence surviving
cleanup.

**6. Stop and ask before M7.** Nothing is provisioned in Google Cloud without explicit approval.
`apps/cli` needs real subcommands before it is worth a skill.

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
- **Turbo writes a managed block into `AGENTS.md`** before repository-scoped commands. Keep it
  committed; the conventions below live after it on purpose.
