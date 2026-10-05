# Parallel work: subagents, worktrees, and when to hand off to the factory

How to run several streams of work at once in this repo, what each mechanism actually isolates, and
the line where local agent work should stop and a factory session should start.

Companion documents: `docs/handoff.md` (what is next), `docs/roadmap.md` (priority and the Linear
project), `AGENTS.md` (the gates and the conventions).

---

## 1. Four shapes of parallelism

They differ in exactly one thing that matters: **what is isolated**.

| Shape                                                              | Isolates                                                                                        | Cost                                                    | Use when                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Subagents, shared checkout** (the default)                       | Nothing. Same filesystem, same cwd, same `node_modules`.                                        | Cheapest: context only.                                 | Read-only research, and edits to disjoint files with one integration owner.                            |
| **Isolated subagents** (`isolated: true` on a `task` item)         | A copy-on-write checkout per spawn, under `~/.omp/wt/<hash>/<n>`; changes come back as a patch. | A clone (APFS CoW — see §7) plus a merge.               | Several agents editing at once, when you want their work reviewed as patches rather than applied live. |
| **Separate OMP sessions in separate `git worktree add` checkouts** | Everything, including per-directory OMP session state, ports, `.verify/`, and the turbo cache.  | One more process, one more gate run, one more database. | Work that lasts hours and would otherwise fight your own session.                                      |
| **Factory sessions** (after milestone **L**)                       | A sandbox, the policy boundary, and your machine's CPU.                                         | An issue, a sandbox, and inference spend.               | Delegated, repo-bound, unattended work whose output is a PR.                                           |

Read the last two rows as the same idea at different levels of automation: the factory's per-session
worktree (design D10, `factory/<session-id>`) is this repo's manual `git worktree add` with a
sandbox, a policy, and a paper trail around it.

## 2. What OMP gives you here

**Enabled in this repo** by `.omp/config.yml` (the project settings layer, under
`~/.omp/agent/config.yml`):

```yaml
task:
  isolation:
    enabled: true
```

Verify it from any session with `read cfg://task/isolation/enabled` — it should report
`source: project config`. Turning it on does not change existing spawns: isolation is opt-in **per
task item**, so a plain `task` call behaves exactly as before.

What you get:

- **Batched fan-out.** `task` takes `{ context, tasks[] }`; one subagent per item, all sharing the
  `context` block, bounded by `task.maxConcurrency` (32). Items launch as their JSON closes
  (`task.speculativeLaunch`), so a slow item does not hold up the rest.
- **`isolated: true` per item.** The child runs in its own checkout. Changes are captured as a patch
  and, with the current defaults (`task.isolation.merge: patch`, `apply: true`), a _successful_ run's
  patch is applied back to your checkout automatically. Set `apply: false` in the project config if
  you would rather apply every patch by hand.
- **Fresh context per child**, plus the skill/context files of the checkout and the shared `local://`
  root. Children never inherit the conversation.
- **Agents:** `scout` (read-only research, cheap), `sonic` (strictly mechanical), `reviewer`,
  `security-reviewer`, `task` (general). Pick the narrowest that can do the job.
- **Steering:** `read proc://<id>` to watch, `write agent://<id>` to message a live child,
  `history://<id>` for its transcript, `agent://<id>/<json/path>` to pull one field out of a
  structured result, `write proc://<id>/kill` to cancel.
- **Follow-ups beat respawns.** Message an existing agent instead of spawning a fresh one for
  related work: it already holds the context.

Two honest caveats:

- **Non-isolated subagents are not sandboxes.** They share your cwd and can write anywhere you can.
  Isolation is what buys separation, and even that is a separation for coordination, not for
  security.
- **An isolated child cannot be resumed or messaged** after it settles; the workspace is released.
  Ask for everything you need before it yields.

## 3. The constraints that actually bite in this repo

These are the reasons a naive `N agents in N worktrees` plan goes wrong here.

1. **One Postgres.** Everything points at `postgres://factory:factory@localhost:5442/factory`
   (`compose.yaml`), migrations run when `apps/api` boots, and `packages/storage-postgres`,
   `packages/harness` and `packages/core` deliberately opt out of turbo caching, so they hit that
   database on every run. Two worktrees running `bun run test` concurrently race on migrations and
   share tables. **Give each parallel worktree its own database** —
   `docker compose exec postgres createdb factory_<slug>`, then
   `DATABASE_URL=postgres://factory:factory@localhost:5442/factory_<slug> bun run test` — or run the
   test suites one at a time.
2. **Ports and one run directory.** `.pi/skills/verify-api` uses port 9200; `.pi/skills/verify-web`
   uses 9100 (API) and 3100 (web). Both write `api.pid` into `.verify/run/`, so **one drive per
   checkout at a time**; pass `API_PORT` / `WEB_PORT` to run two, and do it from separate worktrees.
3. **One writer per checkout.** Two sessions in the same directory collide on files, on
   `bun install`, and on `.turbo`. If two agents must edit the same file, they need separate
   checkouts and an integration step — the conflict you get from merging two patches is the honest
   one.
4. **Branches are shared through `.git`.** A `git worktree add` worktree shares refs and config with
   the primary checkout, so use a unique branch per worktree (`wip/<slug>`, and `factory/<session-id>`
   for factory sessions).
5. **Turbo's cache is per checkout, and test caching is already off** where it matters
   (`packages/{core,harness,storage-postgres}/turbo.json`). A cached `build`/`type-check` is fine; do
   not let a cached `test` outlive the Postgres it lied about.
6. **`.pi/` and `.omp/` are shared tooling.** A skill or agent added inside a worktree does not exist
   anywhere else until it is committed and merged. The same is true of `.omp/config.yml` — it is
   committed on purpose.
7. **Docker context.** The active context may be a stopped Docker Desktop while Colima runs:
   `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

## 4. Recipe: fan out N slices

```mermaid
flowchart TD
  A[Slice the work: disjoint files, named interfaces] --> B[task batch: one item per slice, isolated: true]
  B --> C[Each child works in its own checkout]
  C --> D[Patches return to the integrating checkout]
  D --> E[One gate run: format, build, lint, test, type-check]
  E --> F[Per-track verification: verify-api, verify-cli, verify-web]
  F --> G[Linear issue per slice closed with evidence]
```

1. **Slice before spawning.** Write down which files and interfaces each slice owns; overlapping file
   sets are not slices. Name the shared contract in the batch `context` so children do not invent
   their own.
2. **Fan out one `task` batch**, `isolated: true` per item, one Linear issue per item so the work has
   a name and an acceptance criterion.
3. **Do not run gates mid-flight.** Children neither build nor test; the integrating checkout runs
   `bun run format:check && bun run build && bun run lint && bun run test && bun run type-check` once,
   after the patches land.
4. **Verify per track, one at a time:** `verify-api` (backend), `verify-cli` (CLI), `verify-web` (UI).
   Ports and pids make these serial within a checkout.
5. **Keep the paper trail:** the Linear issue carries what changed, what proved it, and what is still
   unproven. The factory's PR body (LOB-12/LOB-16) is the same idea.

## 5. Where to stop and use the factory instead

**Today there is no factory option for repository work.** Sessions are not bound to a repository
(LOB-5), run in a scratch directory rather than a worktree, are not policed (LOB-8), and produce no
PR (LOB-12) — so every item on the roadmap is currently worked locally, with the mechanisms above.
Milestone **L** (LOB-40) is the gate that changes this; after it passes, the split below applies.

| Work                                                | Instrument                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Finding something out (read-only, one question)     | A `scout` subagent, or a few in one batch.                                                                     |
| A mechanical change with the answer already decided | `sonic`, ideally isolated.                                                                                     |
| Reviewing a diff or a design before it lands        | `reviewer` / `security-reviewer`.                                                                              |
| Two to five slices with disjoint files              | One `task` batch, `isolated: true`.                                                                            |
| Hours of work you want to leave and come back to    | **Factory session** — once L has passed.                                                                       |
| Work that should leave a PR and a cost trail        | **Factory session.**                                                                                           |
| Work whose commands should not run on your machine  | **Factory session** (sandbox + policy), and it is the whole reason the sandbox exists.                         |
| Work you would steer every thirty seconds           | Keep it local: the round trip is the point.                                                                    |
| Architecture, ambiguity, or an unresolved question  | Keep it local, or open a Linear issue first — an agent given a vague task produces a vague PR.                 |
| Debugging with motel / DevTools / a live dashboard  | Keep it local; the sandbox has no motel.                                                                       |
| Anything that needs your uncommitted tree           | Keep it local (or commit first — isolation snapshots the working tree, and a 1 GiB dirty checkout is the cap). |

**The handover contract.** Hand a task to the factory only when all four are true: (1) it is an issue
with a track label and an observable acceptance criterion; (2) it names a repository and base ref;
(3) "done" means green gates plus the evidence of that track's driver; (4) nobody has to answer a
question mid-run. If any is false, it is a local task or it is not yet an issue.

## 6. Measured cost

One isolated spawn on this checkout (2026-10-05, macOS/APFS):

|                     |                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation directory | `~/.omp/wt/<repo-hash>/<n>`, **1.1 GB apparent** — it is a copy-on-write clone that includes `node_modules`, so the real disk delta is far smaller, but it is not free. |
| Wall clock          | ~20 s for a trivial task, dominated by clone + spawn, not by the model.                                                                                                 |
| Visibility          | It is a **clone, not a linked worktree**: `git worktree list` does not show it, and the directory persists after the run.                                               |
| Apply               | With `apply: true`, the run reported _Applied patches: yes_ and the file appeared in the parent checkout (verified below).                                              |

## 7. What this document claims, and what was actually checked

Verified on 2026-10-05 in this checkout:

- `read cfg://task/isolation.enabled` reports `true` with `source: project config` — the committed
  `.omp/config.yml` is what turns isolation on.
- One `task` spawn with `isolated: true` ran in `/Users/llobik/.omp/wt/t2b740ead8/m`, i.e. in its own
  checkout rather than the parent, and its written file was applied back into the parent working tree
  (`git status` showed it untracked in `/opt/dev/factory`). The smoke file was removed afterwards.

Not checked, and therefore not claimed: several isolated spawns editing one file; concurrency at 32;
behavior on a checkout near the 1 GiB dirty-snapshot cap; `merge: branch` mode; and any two
high-level OMP sessions sharing one database (the §3 hazard).

## 8. Cleaning up

- **Isolation leftovers:** `omp worktree` (alias `wt`) adds, lists, and clears agent-managed
  worktrees; the base directory is `worktree.base` or `~/.omp/wt`.
- **Manual worktrees:** `git worktree list` then `git worktree remove <path>` — and remember the
  branch (`git branch -D wip/<slug>`) and the database (`dropdb factory_<slug>`).
- **Sessions and run state:** `.verify/` and `.factory/` are gitignored; delete them freely.
