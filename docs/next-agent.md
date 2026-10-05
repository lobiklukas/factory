# Next agent brief

A self-contained starting brief for the next agent session. Paste it into a fresh session, or point
the agent at this file.

**Written:** 2026-10-05, against `main` at `50c3c9d`. **Scope:** finish milestone M2 — issues **LOB-7**
and **LOB-21** — then start milestone **B**, the board.

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

### Where M2 stands

Two of its four issues are done, at `cebb996`:

- **LOB-5 — session↔repo binding.** `createSession({ repo, baseRef })`; the binding is a
  `factory.session` document in the log and `sessions.repo`/`base_ref` in the index; the snapshot
  carries a resolved `workspace` (directory, commands from the repo's `.factory/config`,
  `commandsSource`); `registerRepo` is the registry; `repos` is droppable and rebuildable.
- **LOB-6 — session list.** `listSessions` over the derived `session_activity` index: one statement
  per page whatever the row count, keyset cursor, newest activity first. `rebuildIndexes` folds the
  logs back into `sessions`, `session_activity`, and `repos`.

Two remain, and both were **paused mid-flight** by the user:

1. **LOB-7 — CLI subcommands `factory run` / `watch` / `ls`** plus `.pi/skills/verify-cli/` driving
   them in tmux. A subagent wrote the three subcommands against `SessionRpc` and wired them into the
   root command, then was stopped before it wrote the skill or ran anything. That work is preserved
   but **not applied** at `.verify/scratch/paused-agents/` (a patch, the new files, and a README).
   Read it as a reviewer, do not trust it.
2. **LOB-21 — readiness, shutdown and request limits.** The typed `invalid_input` code and the
   message-length cap landed with LOB-5/6 and are proven over the wire by `verify-api`. The rest —
   `/livez` + `/readyz`, a SIGTERM handler calling `SessionService.close`, a request-body cap — was
   also paused mid-flight; its partial work is in the same directory. Two design points it must not
   get wrong: a liveness probe never depends on the database, and readiness that cannot answer while
   Postgres is down is not readiness (bind the server, report 503, let requests fail with typed
   `SessionError` codes).

### Read first, in this order

1. `AGENTS.md` — repo rules, the five gates, and the conventions that are not negotiable.
2. `docs/handoff.md` — the state of the work and the gotchas that have already cost hours. The
   gotchas section is the cheapest thing you will read today.
3. `docs/roadmap.md` — priority tiers, the milestone map, the tracks, and what "done" means for M2.
   Milestone **B** (the board) is the stretch after this one, and `docs/board.md` is its design:
   tasks as the unit of work, columns binding roles and skills, runs, gates, and what is explicitly
   wave 2. Read `docs/board.md` before touching anything that models work.
4. `docs/features.md` §3 (Group A) and §6 (unused Pi Durable primitives) — the evidence behind the
   work, with file:line, so you do not re-derive it.
5. `.pi/skills/verify-api/SKILL.md` and its `features/` directory — how this repo proves things. The
   skill is the model for the one LOB-7 needs.
6. `docs/parallel-work.md` — if you fan out slices.

### Work tracking

The Linear project **Factory MVP** (team `Lobiklukas`, workspace `lobiklukas`) is the backlog. In
this session the `mcp__linear_*` tools were **not mounted**, but the server is reachable over HTTP
with the cached `mcp-remote` OAuth token, which is enough to read the acceptance criteria and move
issues: `~/.mcp-auth/mcp-remote-v1/*_tokens.json` holds an `access_token` (scope `read write`), and
`POST https://mcp.linear.app/mcp` with `Authorization: Bearer <token>`, `Content-Type:
application/json`, `Accept: application/json, text/event-stream`, and `MCP-Protocol-Version:
2025-06-18` speaks JSON-RPC (`initialize`, then `tools/call` with `get_issue`/`save_issue`/`save_comment`).
Move each issue to In Progress when you start, and to In Review with a comment carrying your evidence
when it is done. Never invent an issue number.

### Constraints that will bite

- **Postgres is part of the gate:** `docker compose up -d --wait postgres` (host port 5442). On this
  machine the active docker context may be a stopped Docker Desktop while Colima runs:
  `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.
- **Gate every change:** `bun run format:check`, `build`, `lint`, `test`, `type-check` — all five,
  green, before you claim anything works. The Effect diagnostics run with `denyWarnings`, so a warning
  fails the build, and `.pi/` / `.verify/` are excluded from lint on purpose.
- **Another OMP session may share this checkout.** It had uncommitted work in `docs/features.md` and
  `docs/roadmap.md` while this brief was written. Commit by path, never `git add -A`, and re-read a
  file before editing it.
- **Effect 4, not Effect 3.** `Config.String`, `Effect.result`/`Result`, `Effect.gen`,
  `Layer.effect` (there is no `Layer.scoped`), `Effect.forkChild`/`Effect.forkIn`, `Effect.andThen`,
  `Stream.unwrap`, `Schema.Finite`/`Schema.Int` for counters, and `Schema.optional` (not
  `optionalKey`) for anything a client can send. `docs/handoff.md` lists the rest.
- **Lint bans `async` everywhere**, and bans `Date.now` / `Math.random` / `crypto.randomUUID` /
  `JSON.parse` in library code — use `Clock`/`Random` in tests and `Schema.fromJsonString` for JSON
  text.
- **Pi Durable is consumed as an interface, never modified.** Its conformance suites are the oracle.
  Its ids are branded numbers: `harness.submission(8)` works, `harness.submission("8")` does not.
- **`MODEL_BACKEND=faux` for every drive run:** offline, deterministic, and still a real tool call.
  `FAUX_COMMAND` overrides the command the faux script runs — `FAUX_COMMAND="sleep 5 && echo faux-ok"`
  is how LOB-21's SIGTERM-mid-run case gets a busy window.
- **One writer per checkout.** If you fan out, use isolated subagents (`isolated: true` per item —
  isolation is on for this repo by `.omp/config.yml`) or separate `git worktree add` checkouts, and
  give each parallel worktree its own database (`createdb factory_<slug>`) and port. A subagent
  spawned _without_ `isolated: true` edits this checkout directly, which is how the paused work got
  here.
- **Turbo can cache test results.** `packages/{core,harness,storage-postgres}` opt out because they
  need the live database. Keep that opt-out for any suite with an external dependency.

### Definition of done

- Each issue's acceptance criteria met, with the observable result it names — not a plausible subset.
- Verification lives in the repo's own skills: create `.pi/skills/verify-cli` for LOB-7, extend
  `.pi/skills/verify-api` for LOB-21's readiness and SIGTERM cases, and write evidence under
  `.verify/` that survives cleanup.
- All five gates green, and you have run the thing you changed — a drive run, not only a unit test.
- Linear issues moved to In Review with a comment: what shipped, the commands you ran, what is
  provably done, and what is not proven.
- `docs/handoff.md`'s "what to do next" rewritten for the agent after you. Touch `docs/features.md`
  or `docs/roadmap.md` only where reality moved — a claim the code contradicts is a doc bug. (A1 and
  A2 in `docs/features.md` §3 still describe themselves as missing; they shipped at `cebb996`.)

### Report back

Short and evidence-first: what shipped, the exact commands and their results, what you could not
prove, and which Linear issues you moved. If you hit something that changes the plan, say so
explicitly rather than quietly narrowing scope.

---

## After this stretch

M2 closes with LOB-7 and LOB-21. Two things then run in parallel, both tracked in Linear and both
described in `docs/board.md`:

- **Milestone B — the board**, because it is the surface everything after is driven from: LOB-42
  (board domain: tasks, columns, transitions, gates) → LOB-48 (skills kernel) → LOB-46 (the specifying
  stage) → LOB-22 (board UI), with LOB-49 as the gate. Nothing in B is autonomous: a person starts
  every run, which is what keeps it small. LOB-49 needs the PR path (LOB-11, LOB-12) before the
  `review` gate can be exercised at all.
- **The M3 block** — LOB-8 (policy hooks) → LOB-9 (approvals) → LOB-10 (credentials), the first
  milestone where the agent is policed, with `.pi/skills/verify-policy` proving the refusals rather
  than the happy path.

All of it feeds milestone **L**, the local end-to-end run (LOB-40) that gates everything in Google
Cloud — driven from the CLI first (D9) and from the board once B lands.
