# Next agent brief

A self-contained starting brief for the next agent session. Paste it into a fresh session, or point
the agent at this file.

**Written:** 2026-10-05, against `main` at `4261278`. **Scope:** finish milestone M2 (issues LOB-5,
LOB-6, LOB-7, LOB-21) and nothing else.

**It goes stale fast.** It is a brief for one stretch of work, not a document of record. When the
stretch changes — the issues close, or priorities move — rewrite it from `docs/roadmap.md`, whose
priority tiers and Linear project are the source of truth. Everything below that is _not_ specific to
this stretch is already in `AGENTS.md` and `docs/handoff.md`, and those two are the ones to keep
current.

---

## The brief

You are continuing work in `/opt/dev/factory` — an internal, agent-native software development
platform (Effect 4 control plane, Pi Durable harness, Kubernetes sandboxes). Delegate a task, get back
a reviewable PR. Your stretch: **finish milestone M2**, exactly as scoped in the Linear project
"Factory MVP".

### Read first, in this order

1. `AGENTS.md` — repo rules, the five gates, and the conventions that are not negotiable.
2. `docs/handoff.md` — the state of the work and the gotchas that have already cost hours. The
   gotchas section is the cheapest thing you will read today.
3. `docs/roadmap.md` — priority tiers, the milestone map, the three tracks (backend / CLI / UI), and
   what "done" means for each milestone. Read the one you are closing.
4. `docs/features.md` §3 (Group A) and §6 (unused Pi Durable primitives) — the evidence behind the
   work, with file:line, so you do not re-derive it.
5. `.pi/skills/verify-api/SKILL.md` and its `features/` directory — how this repo proves things.
6. `docs/parallel-work.md` — only if you fan out slices.

### Work tracking

The Linear project **Factory MVP** (team `Lobiklukas`, workspace `lobiklukas`) is the backlog;
`.mcp.json` wires Linear's MCP server, so the `mcp__linear_*` tools should be mounted. Move each
issue to In Progress when you start, and to In Review with a comment carrying your evidence when it is
done. If the MCP tools are not available, say so once, continue from `docs/roadmap.md`, and report
what you could not update. Never invent an issue number.

### The tasks, in this order

Each is a Linear issue; read its description for the acceptance criteria in full.

1. **LOB-5 — Session↔repo binding and repo registry** (Urgent, M2, backend). The highest-leverage
   change in the repo: `CreateSessionInput` is currently `{ title?, requestId? }` with a scratch
   working directory, so nothing downstream — worktree, sandbox, trigger — has a repository to bind
   to. Add `repo`, `baseRef`, and per-repo config; keep the `repos` index droppable and rebuildable
   per D7; prove it in `verify-api`.
2. **LOB-6 — Session list and activity index** (Urgent, M2, backend). `listSessions` over a derived,
   droppable `session_activity` table written from the log. Its cost must not grow with the number of
   sessions, the table must be rebuildable from the log, and both must be asserted in a test. The
   dashboard sidebar currently fakes this client-side.
3. **LOB-7 — CLI subcommands: `factory run` / `watch` / `ls`** (Urgent, M2, CLI), plus
   `.pi/skills/verify-cli/` driving them in tmux with `MODEL_BACKEND=faux` and evidence in
   `.verify/`. This is what finishes M2.
4. **LOB-21 — Readiness, shutdown and request limits** (High, M2, backend). `/livez` + `/readyz`, a
   SIGTERM handler that calls `SessionService.close`, body and message-length caps, and a typed
   invalid-input error code. Ride it along with the three above rather than scheduling it separately.

**Do not start** M3 proper (policy hooks, `CredentialProvider`), M4 (sandbox runtime), M6
(worktree/push/PR), or `packages/bus`. Do not restructure packages. Do not touch `apps/web` — it was
just rebuilt as a routed cockpit and is not yours this stretch.

### Constraints that will bite

- **Postgres is part of the gate:** `docker compose up -d --wait postgres` (host port 5442). On this
  machine the active docker context may be a stopped Docker Desktop while Colima runs:
  `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.
- **Gate every change:** `bun run format:check`, `build`, `lint`, `test`, `type-check` — all five,
  green, before you claim anything works. The Effect diagnostics run with `denyWarnings`, so a warning
  fails the build, and `.pi/` / `.verify/` are excluded from lint on purpose.
- **Effect 4, not Effect 3.** `Config.String`, `Effect.result`/`Result`, `Effect.gen({ self: this }, …)`,
  `Layer.effect`, `Effect.forkChild`, `Effect.andThen`, `Stream.unwrap`, `Schema.Finite` for counters,
  and `Schema.optional` (not `optionalKey`) for anything a client can send. `docs/handoff.md` lists
  the rest.
- **Lint bans `async` everywhere**, and bans `Date.now` / `Math.random` / `crypto.randomUUID` /
  `JSON.parse` in library code — use `Clock`/`Random` in tests and `Schema.fromJsonString` for JSON
  text.
- **Pi Durable is consumed as an interface, never modified.** Its conformance suites are the oracle.
  Its ids are branded numbers: `harness.submission(8)` works, `harness.submission("8")` does not.
- **`MODEL_BACKEND=faux` for every drive run:** offline, deterministic, and still a real tool call.
- **One writer per checkout.** If you fan out, use isolated subagents (enabled in this repo by
  `.omp/config.yml`) or separate `git worktree add` checkouts, and give each parallel worktree its own
  database (`createdb factory_<slug>`) — Postgres is shared, and migrations run when the API boots.
- **Turbo can cache test results.** `packages/{core,harness,storage-postgres}` opt out because they
  need the live database. Keep that opt-out for any suite with an external dependency.

### Definition of done

- Each issue's acceptance criteria met, with the observable result it names — not a plausible subset.
- Verification lives in the repo's own skills: extend `.pi/skills/verify-api` with the repo-binding
  and list cases, create `.pi/skills/verify-cli` for LOB-7, and write evidence under `.verify/`.
- All five gates green, and you have run the thing you changed — a drive run, not only a unit test.
- Linear issues moved to In Review with a comment: what shipped, the commands you ran, what is
  provably done, and what is not proven.
- `docs/handoff.md`'s "what to do next" rewritten for the agent after you. Touch `docs/features.md`
  or `docs/roadmap.md` only where reality moved — a claim the code contradicts is a doc bug.

### Report back

Short and evidence-first: what shipped, the exact commands and their results, what you could not
prove, and which Linear issues you moved. If you hit something that changes the plan, say so
explicitly rather than quietly narrowing scope.

---

## After this stretch

The next brief should be written from the roadmap's P0 list once M2 closes: **M3** is LOB-8 (policy
hooks) → LOB-9 (approvals) → LOB-10 (credentials), and all three feed milestone **L**, the local
end-to-end run (LOB-40) that gates everything in Google Cloud.
