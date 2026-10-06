# Next agent brief

A self-contained starting brief for the next agent session. Paste it into a fresh session, or point
the agent at this file.

**Written:** 2026-10-05, against `main` at `a40e2c9`. **Scope:** start milestone **B** — the board —
with **LOB-42** (board domain: tasks, columns, transitions, gates) and then **LOB-48** (skills
kernel). M2 is closed.

**It goes stale fast.** It is a brief for one stretch of work, not a document of record. When the
stretch changes — the issues close, or priorities move — rewrite it from `docs/roadmap.md`, whose
priority tiers and Linear project are the source of truth. Everything below that is _not_ specific to
this stretch is already in `AGENTS.md` and `docs/handoff.md`, and those two are the ones to keep
current.

---

## The brief

You are continuing work in `/opt/dev/factory` — an internal, agent-native software development
platform (Effect 4 control plane, Pi Durable harness, Kubernetes sandboxes). Delegate a task, get back
a reviewable PR. Your stretch: **milestone B's first two issues**, exactly as scoped in the Linear
project "Factory MVP".

### Where the repo stands

M2 closed on 2026-10-05 (`a40e2c9`). The session surface is complete and driven from three places:
`.pi/skills/verify-api` (29 checks, plus `sigterm.sh` 10 and `degraded.sh` 11), `.pi/skills/verify-cli`
(14, in tmux) and `.pi/skills/verify-web` (10, in a browser). A session names its repo and resolves a
workspace, `listSessions` answers from a derived index, `factory run`/`watch`/`ls` work in a terminal,
and the API has `/livez` + `/readyz`, a SIGTERM release that leaves a resumable session, and a 1 MiB
request-body cap.

What milestone **B** adds is the missing noun. Today a **session** is the unit of work and "what is
this for, and where is it" lives in prose — `Rpc.ts` exposes sessions and `registerRepo` and nothing
else. `docs/board.md` is the settled design: a task on a board, columns that bind roles and skills,
runs, gates, and what is explicitly wave 2. Nothing in B is autonomous: a person starts every run,
which is what keeps it small.

### The two issues

**1. LOB-42 — board domain: tasks, columns, transitions and gates.** The next contract change, of the
same rank as LOB-5's repo binding. Its description in Linear is the contract; in outline:

- `tasks` — id, board, column, title, body, repo, base ref, priority, definition version, revision,
  blocked (typed reason + the column it blocked from), external refs (tracker issue, PR url), cost
  rollup, created/updated with actor.
- `task_events` — append-only `(task, seq, at, actor, kind, payload)`; every mutation writes its row
  **and** its event in one transaction.
- `task_runs` — task → run (session id), the column it ran in, outcome, timings. The run's log stays
  the truth for what the run did (D7), and the session carries a `factory.task` document so the link
  is **rebuildable** — the same move LOB-5 made for repos.
- `board_definitions` + instances — a versioned definition (columns with `kind: resting | working |
terminal`, `role`, `skills[]`, `requires[]`, declared transitions) and one instance per repository
  from the existing `repos` table; a task pins the definition version it started under, and one
  default definition ships in a migration.
- Actions: create, move (actor + expected revision; refuses an undeclared transition, and refuses a
  gate-crossing move unless the actor is a human), and whatever else the description names.

**2. LOB-48 — skills kernel: registry and injection at session open.** A `skills` table seeded by
migration with three written skills (specify, implement, review), a loader in `packages/harness` that
resolves the run's column (`role` → model and tool policy, `skills[]` → prompt sections), and the
injection point at `openSession` beside `CodingTools`. Its acceptance is behavioural: a run on a card
in `specifying` receives the `specify` skill text and a run in `building` does not; editing a seeded
body changes the next run's prompt with no code change; the injected section is bounded and its size
measurable.

### Read first, in this order

1. `AGENTS.md` — repo rules, the five gates, and the conventions that are not negotiable.
2. `docs/board.md` — the design LOB-42 implements: tasks as the unit of work, columns binding roles
   and skills, runs, gates, and the MVP/wave-2 cut. Read it before touching anything that models work.
3. `docs/handoff.md` — the state of the work and the gotchas that have already cost hours. The
   gotchas section is the cheapest thing you will read today.
4. `docs/design.md` — D7 (the log is truth, index tables are droppable and rebuildable), D8/D11/D12,
   and the milestone map. LOB-42 is a D7-shaped change: derive, do not duplicate.
5. LOB-42's description in Linear (its acceptance criteria are the contract), then LOB-48's.
6. `.pi/skills/verify-api/SKILL.md` and its `features/` directory — how this repo proves things. The
   board's refusals (an undeclared transition, a gate crossed by an agent) want their own driver,
   `.pi/skills/verify-board/`, in the same shape.
7. `docs/parallel-work.md` — if you fan out slices.

### Work tracking

The Linear project **Factory MVP** (team `Lobiklukas`, workspace `lobiklukas`) is the backlog. If the
`mcp__linear_*` tools are mounted, use them. If they are **not** mounted, the server is still reachable
over HTTP with the cached `mcp-remote` OAuth token: `~/.mcp-auth/mcp-remote-v1/*_tokens.json` holds an
`access_token` (scope `read write`), and `POST https://mcp.linear.app/mcp` with `Authorization: Bearer
<token>`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and
`MCP-Protocol-Version: 2025-06-18` speaks JSON-RPC (`initialize`, then `tools/call` with `get_issue` /
`save_issue` / `save_comment`). The server is stateless: it answers without an `mcp-session-id` header.
`save_issue` takes `{"id": "LOB-42", "state": "In Review"}`. A comment is created by
`save_comment` with `{"issueId": "LOB-42", "body": "…"}`; its own `id` updates an existing comment.
Move each issue to In Progress when you start, and to In Review with a comment carrying your evidence
when it is done. Never invent an issue number.

### Constraints that will bite

- **Postgres is part of the gate:** `docker compose up -d --wait postgres` (host port 5442). On this
  machine the active docker context may be a stopped Docker Desktop while Colima runs:
  `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.
- **Gate every change:** `bun run format:check`, `build`, `lint`, `test`, `type-check` — all five,
  green, before you claim anything works. The Effect diagnostics run with `denyWarnings`, so a warning
  fails the build, and `.pi/` / `.verify/` are excluded from lint on purpose. `turbo` caches results:
  `bunx turbo run test --force` when you need a real run.
- **Another OMP session shares this checkout.** While this brief was written one was mid-flight in
  `apps/web` (the UI aesthetic work: shadcn components, theme, nav rail), uncommitted. Commit by path,
  never `git add -A`, re-read a file before editing it, and do not touch `apps/web` unless you mean to
  take that work over.
- **Effect 4, not Effect 3.** `Config.String`, `Effect.result`/`Result`, `Effect.gen`, `Layer.effect`
  (there is no `Layer.scoped`), `Effect.forkChild`/`Effect.forkIn`, `Effect.andThen`, `Stream.unwrap`,
  `Schema.Finite`/`Schema.Int` for counters, and `Schema.optional` (not `optionalKey`) for anything a
  client can send. `docs/handoff.md` lists the rest.
- **Lint bans `async` everywhere**, and bans `Date.now` / `Math.random` / `crypto.randomUUID` /
  `JSON.parse` in library code — use `Clock`/`Random` in tests and `Schema.fromJsonString` for JSON
  text.
- **Pi Durable is consumed as an interface, never modified.** Its conformance suites are the oracle.
  Its ids are branded numbers: `harness.submission(8)` works, `harness.submission("8")` does not.
- **`MODEL_BACKEND=faux` for every drive run:** offline, deterministic, and still a real tool call.
  `FAUX_COMMAND` overrides the command the faux script runs — `FAUX_COMMAND="sleep 8 && echo faux-ok"`
  is how a run is held open long enough to be genuinely busy (that is how `verify-api/sigterm.sh`
  catches a SIGTERM mid-run).
- **One writer per checkout.** If you fan out, use isolated subagents (`isolated: true` per item —
  isolation is on for this repo by `.omp/config.yml`) or separate `git worktree add` checkouts, and
  give each parallel worktree its own database (`createdb factory_<slug>`) and port. A subagent spawned
  _without_ `isolated: true` edits this checkout directly.
- **The verify skills share `.verify/run/api.pid`** and each starts its own API, so run them one at a
  time: `verify-api` on `:9200`, `verify-cli` on `:9300` (private tmux server), `verify-web` on `:9100`
  - `:3100`. `verify-api/degraded.sh` stops the local Postgres container and always restarts it.
- **A board change is a second contract on the session API.** The task tables are derived like
  `sessions`/`session_activity`/`repos`: the log carries a `factory.task` document and
  `rebuildIndexes` folds it back. Do not invent a second storage convention, and do not let a
  projection failure fail a run.

### Definition of done

- Each issue's acceptance criteria met, with the observable result it names — not a plausible subset.
  For LOB-42 that includes the **refusals**: an undeclared transition and an agent crossing a gate
  must both be refused, and those are the checks that matter.
- Verification lives in the repo's own skills: create `.pi/skills/verify-board/` for LOB-42 (in the
  shape of `.pi/skills/verify-api`), and extend `verify-api` for LOB-48's injection if it is observable
  over the session surface. Evidence under `.verify/` that survives cleanup.
- All five gates green, and you have run the thing you changed — a drive run, not only a unit test.
- Linear issues moved to In Review with a comment: what shipped, the commands you ran, what is
  provably done, and what is not proven.
- `docs/handoff.md`'s "what to do next" rewritten for the agent after you. Touch `docs/features.md`,
  `docs/roadmap.md`, or `docs/board.md` only where reality moved — a claim the code contradicts is a
  doc bug.

### Report back

Short and evidence-first: what shipped, the exact commands and their results, what you could not
prove, and which Linear issues you moved. If you hit something that changes the plan, say so
explicitly rather than quietly narrowing scope.

---

## After this stretch

- **LOB-46** (the specifying stage) then **LOB-22** (the board UI), with **LOB-49** as milestone B's
  gate. LOB-49 needs the PR path (LOB-11, LOB-12) before the `review` gate can be exercised at all.
- **The M3 block** — LOB-8 (policy hooks) → LOB-9 (approvals) → LOB-10 (credentials) — runs in
  parallel with B rather than after it: the first milestone where the agent is policed, with
  `.pi/skills/verify-policy` proving the refusals rather than the happy path.
- **Two cheap verification holes are still open** from M2 (`docs/handoff.md` item 6): steering and the
  `busy` code at the RPC surface (now reachable — `FAUX_COMMAND` holds a turn open, which `sigterm.sh`
  already does), and `usage.tools` (fix the per-tool cost claim or withdraw it — LOB-32).
- All of it feeds milestone **L**, the local end-to-end run (LOB-40) that gates everything in Google
  Cloud — driven from the CLI first (D9) and from the board once B lands.
