# factory

> An internal, agent-native software development platform: delegate a task, get back a reviewable
> pull request.

Effect control plane, Pi Durable harness, Kubernetes sandboxes. What makes it different from Devin,
Cursor, or other Factory-style tools: the unit of work is a task on a board with columns, human
gates, and machine-checked evidence (`docs/board.md` B1, B4, B5, B8), and every run is a durable Pi
Durable session whose append-only log is the truth (`docs/design.md` D7). The board is the product's
spine; a session is the execution primitive underneath it.

If you are an agent working in this repo, read [`AGENTS.md`](AGENTS.md) first. This file is the
human front door.

## The loop

1. **A task arrives,** bound to a repo and a base ref. The control plane is `apps/api`; the wire
   contracts live in `packages/domain`; the repo binding and the derived session index live in
   `packages/core` (session creation records a `factory.session` document, and the binding is
   replayable from the log).
2. **The board holds it.** A task is a row, not a session. It sits in a column that binds a role and
   its skills, and leaving a column checks that column's requirements, including the two human gates
   (plan approval, and merge). This is designed (`docs/board.md`) and is milestone **B**; the board
   domain package is not built yet.
3. **Moving a task starts one run.** A run is exactly one Pi Durable session. `packages/harness` is
   the only package that touches Pi Durable: it opens the session over the append-only log in
   `packages/storage-postgres`. Today a person starts the run; nothing auto-starts.
4. **Watch and steer.** `apps/cli` (`factory run`, `watch`, `ls`) and the `apps/web` dashboard stream
   the same session. A live session streams from the owning process; anything else is a fold of the
   log (`docs/design.md` D8).
5. **A branch comes back.** The agent commits to `factory/<session-id>`, pushes it, and the control
   plane opens the PR; review happens in GitHub (`docs/design.md` D10, D16). This is milestone
   **M6** and it is not built yet. Today the loop stops at a proven session, not a PR.

## What is built today

The honest cut. A shell and a product read differently here on purpose. Last verified 2026-10-05
(`docs/handoff.md`); the web feature map was last verified 2026-10-06.

| Surface                        | State                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` control plane       | Built and proven. `GET /` health, `/livez` + `/readyz` probes, and the session surface at `POST /rpc`: create, get, send, interrupt, list, registerRepo, watch. Boots without waiting for migrations. 29/29 checks in `.pi/skills/verify-api/drive.ts`.                                                                                                       |
| `packages/core`                | Built and proven. `SessionService` (create, get, send, interrupt, list, registerRepo, watch), owner registry, id minting, idle eviction, repo binding, the derived `session_activity` index, and the live-vs-fold read split. `rebuildIndexes` folds every log back into the index tables.                                                                    |
| `packages/storage-postgres`    | Built and proven. The append-only `Storage` backend plus six migrations and a read-only reader mode. Passes Pi Durable's 23-case conformance suite.                                                                                                                                                                                                           |
| `packages/harness`             | Built and proven. Pi Durable wiring, projection into domain shapes, faux and Anthropic model backends. The M0 live turn (`bun run m0`) called `bash` and returned per-model tokens and cost.                                                                                                                                                                  |
| `apps/cli`                     | Built and proven. `factory run "<task>"`, `factory watch <session-id>`, `factory ls`. 14/14 checks in `.pi/skills/verify-cli`, driving the real bin in tmux.                                                                                                                                                                                                  |
| `apps/web` dashboard           | Partial. Passing: dashboard shell renders, browser reaches the API, session stream (10/10 in `.pi/skills/verify-web/drive.mjs`). Named gaps: `/sandboxes` and `/approvals` name the milestone (M4, M3) that will back them, and the session list is still browser-local (`sessionStorage`); a server list exists now, and milestone B's board UI replaces it. |
| Board domain                   | Designed only, not built. `docs/board.md` B1-B12; milestone **B** lands it. The `packages/board` package does not exist yet.                                                                                                                                                                                                                                  |
| Policy, approvals, credentials | Not built. Milestone **M3** (LOB-8, LOB-9, LOB-10). No hook enforces a tool call today.                                                                                                                                                                                                                                                                       |
| Sandbox and Kubernetes tier    | Not built. Milestone **M4** and **M7**. No cluster manifest, no pod, no probe on a cluster. Isolation is not verifiable locally: kind cannot run gVisor (`docs/design.md` R2), so a green local suite says nothing about sandboxing.                                                                                                                          |
| PR creation and PR link        | Not built. Milestone **M6** (LOB-11, LOB-12).                                                                                                                                                                                                                                                                                                                 |
| Linear trigger and write-back  | Not built. Milestone **T** (LOB-14, LOB-15).                                                                                                                                                                                                                                                                                                                  |
| Local observability (motel)    | Available. `apps/api` and `apps/cli` export OTLP logs and traces when `MOTEL_URL` is set; `bun run motel` reads them. `tools/motel/` holds an isolated install.                                                                                                                                                                                               |

Also open, and named in `docs/handoff.md` rather than rounded up: cross-process fan-out (`docs/design.md`
D12) is not built, so a session owned by another process reads as `historical`; reader mode under a
concurrent writer's load is unmeasured; no drive run has pushed a historical read through the
dashboard; steering at the RPC surface (`whenBusy`) is unproven because the faux turn is too fast;
and `rebuildIndexes` has no runtime caller, only a test.

One documentation drift worth knowing: `.pi/skills/verify-web/features/README.md`'s gap list still
carries a stale line saying `apps/cli` has no subcommands. The subcommands and their skill landed
with LOB-7.

## Quickstart

Requires Bun (`bun@1.4.2`, per `package.json`; Node `>=24`), Docker, and the repo checked out.

```sh
bun install
docker compose up -d --wait postgres
bun run dev
```

- `bun install` runs the `prepare` script (`effect-tsgo patch --oxlint`, then the isolated `tools/motel`
  install).
- `docker compose up -d --wait postgres` starts the local Postgres from `compose.yaml`, user,
  password, and database all `factory`, on host port **5442** (not 5432, which developer machines
  routinely have taken).
- `bun run dev` runs `turbo run dev`: the API on port **9000** (root `package.json` -> `apps/api`'s
  `dev`), the Vite dashboard on port **3000** (`VITE_PORT` overrides), and the CLI in watch mode.
- `cp .env.example .env` if you want a real model. `ANTHROPIC_API_KEY` is optional: with no key,
  `MODEL_BACKEND` falls back to pi-ai's deterministic faux provider and sessions still run offline
  with scripted answers.

**Docker caveat, because it bites on this machine.** The active docker context may be a stopped
Docker Desktop while Colima is running. Export the host rather than changing the global context:

```sh
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
```

## The gate

Local Postgres is part of the gate, not an optional extra: `docker compose up -d --wait postgres`
first, then these five, in this order:

```sh
bun run format:check
bun run build
bun run lint
bun run test
bun run type-check
```

`bun run test` needs Postgres and fails loudly rather than skipping when it is down. The Effect
diagnostics run with `denyWarnings: true`, so a warning fails the build. `AGENTS.md` holds the
conventions around this.

## Where the truth lives

| Document                                         | The question it answers                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/design.md`](docs/design.md)               | What is the architecture, and which decisions (D1-D17) are settled, over which milestones (M0-M7) and risks (R1-R6)?                           |
| [`docs/board.md`](docs/board.md)                 | How does work move? The settled board decisions (B1-B12), the default pipeline, the human gates, and the MVP/wave-2 cut.                       |
| [`docs/roadmap.md`](docs/roadmap.md)             | In what order do we build, and what does "done" mean? Priority tiers and the Linear project that tracks them.                                  |
| [`docs/features.md`](docs/features.md)           | What should we build next, and why? A ranked backlog from a code audit, the installed Pi Durable surface, and a survey of comparable products. |
| [`docs/handoff.md`](docs/handoff.md)             | What is done, what is proven, what is not, and what is next? The state of the work.                                                            |
| [`docs/next-agent.md`](docs/next-agent.md)       | Where does an agent start right now? A self-contained brief for one stretch of work; stale by design.                                          |
| [`docs/parallel-work.md`](docs/parallel-work.md) | How do I run several streams of work at once without collisions? Subagents, worktrees, and where to hand off to the factory.                   |
| [`docs/README.md`](docs/README.md)               | Which document answers which question? The index of the docs tree.                                                                             |

## Verification as a skill

Verification here is a mechanism, not an afterthought, and it is a real differentiator. A
`.pi/skills/verify-<surface>/` skill launches its surface on isolated ports, drives it through the
real user path, and writes evidence to `.verify/`. Three exist today:

- `.pi/skills/verify-api/` drives the real Effect RPC client against the API, plus `sigterm.sh` and
  `degraded.sh` for shutdown and database-down behavior.
- `.pi/skills/verify-web/` launches the dashboard and drives it in a browser, with a per-feature map
  in `.pi/skills/verify-web/features/`.
- `.pi/skills/verify-cli/` drives the installed `factory` bin in a private tmux server.

Add one before claiming a surface works. `docs/board.md` B8 promotes this convention into the board
itself: a skill's output is what a move's evidence gate checks.

## Layout

```
apps/
  api/                 Effect control plane: HTTP + RPC, probes, hosts the harness in-process for local dev
  web/                 React dashboard on TanStack Router (the cockpit): sessions today; sandboxes and approvals are named gaps
  cli/                 factory run | watch | ls, the same RPC client as the dashboard minus the browser
packages/
  domain/              Schemas and API/RPC contracts, shared by every layer; knows nothing about Pi Durable
  core/                SessionService: owner registry, repo binding, workspace resolution, index rebuild
  harness/             The only place that touches Pi Durable: openSession, projection, model backends
  storage-postgres/    Append-only log Storage, migrations, reader mode, rebuildable index tables
  config-typescript/   Shared tsconfig presets (base, vite)
tools/
  motel/               Isolated OTLP log/trace reader for local debugging (see tools/motel/README.md)
.pi/
  skills/              Shared agent tooling: verify-*, motel-debug
docs/                  Design decisions, board, roadmap, handoff, feature research
compose.yaml           Local Postgres on host port 5442
turbo.json             Turbo task graph (build, dev, type-check, test, clean)
```
