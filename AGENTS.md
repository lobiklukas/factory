<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# factory

An internal, agent-native software development platform: delegate a task, get back a reviewable
pull request. Effect control plane, Pi Durable harness, Kubernetes sandboxes.

## Read first

- `docs/design.md` — the settled decisions with their rationale, the component
  inventory, the local-first build order (M0–M7), and the open risks (R1–R6). Read it before
  proposing an architecture change.
- `docs/features.md` — what to build next and why: a ranked backlog from a code audit, the
  installed Pi Durable API surface, and a survey of 13 comparable products. It changes no
  decision in `docs/design.md`.
- `docs/roadmap.md` — the plan: priority by distance to MVP, the milestone map, and the Linear
  project that tracks it. Read it before starting work that is not already an issue.
- `docs/board.md` — the board: a task as the unit of work, columns binding roles and skills, runs,
  gates, and the MVP/wave-2 cut. Read it before touching anything that models work.
- `docs/parallel-work.md` — how to run several streams of work at once here: subagent isolation,
  worktrees, the shared-Postgres and port hazards, and where local agent work should stop and a
  factory session should start instead.
- `docs/handoff.md` — what is done, what is next, and the completion criterion for each step.
- `docs/next-agent.md` — the brief for the current stretch of work: points at the issues, the gates,
  and the traps. Stale by design; rewrite it when the stretch changes, from `docs/roadmap.md`.
- `.pi/skills/verify-web/features/README.md` — the feature map: what works, what fails, and how
  each feature is proven.

## Conventions

- **Local first.** Docker, kind, and local processes only. Nothing is provisioned in Google Cloud
  until a task says so explicitly.
- **Local Postgres is part of the gate.** `docker compose up -d --wait postgres` (host port 5442) before `bun run test`; the storage suite fails loudly rather than skipping when it is
  down. On this machine the active docker context may be a stopped Docker Desktop while Colima
  is running — use `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.
- **Gate every change** with `bun run format:check`, `build`, `lint`, `test`, `type-check`. The
  Effect diagnostics run with `denyWarnings: true`, so a warning fails the build.
- **Work is tracked in Linear, not in the repo.** Project `Factory MVP` in
  [lobiklukas](https://linear.app/lobiklukas) holds the roadmap: milestones, priorities, and the
  acceptance criteria per issue. `.mcp.json` at the repo root wires Linear's MCP server for any
  agent (first use authorizes in a browser; the token is cached in `~/.mcp-auth` and shared across
  clients). No Linear key is stored in the repo. `docs/roadmap.md` is the Markdown mirror.
- **`.pi/` is shared tooling for every agent and belongs in git**, committed alongside the work
  that needs it. Skills, prompts, and agents that help any agent working in this repo go there.
  It holds no credentials and no machine-local state.
- **Verification is a skill, not an afterthought.** `.pi/skills/verify-<surface>/` launches the
  surface on isolated ports, drives it through its real user path, and writes evidence to
  `.verify/`. Add one before claiming a surface works.
- **Pi Durable is consumed as an interface, not modified.** When implementing one of its
  interfaces, its conformance suites are the oracle: `Storage` (23 cases) and `ExecutionEnv`.
- **Runtime evidence is in motel, not in a log tail.** `apps/api` and `apps/cli` export OTLP
  logs and traces to a local [motel](https://github.com/kitlangton/motel) when `MOTEL_URL` is
  set; `bun run motel` reads it and `bun run motel:start` runs it headless for agents. When a
  bug needs facts about what actually ran, query motel — see `.pi/skills/motel-debug`. The
  exporters are `effect/observability` on effect 4 stable, never `@effect/opentelemetry`, and
  they live in `apps/*/src/observability/Motel.ts` beside `DevTools.ts`. `tools/motel/` holds
  an isolated install because motel pins an effect beta; see its README before touching it.
