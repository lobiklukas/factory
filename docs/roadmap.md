# Roadmap

What we build, in what order, and what "done" means. `docs/design.md` holds the settled decisions
(D1–D16) and the milestone definitions; `docs/features.md` holds the research behind each item.
This document is the plan: priority by MVP distance, and the Linear project that tracks it.

Tracked in Linear: **[Factory MVP](https://linear.app/lobiklukas/project/factory-mvp-8d860fd4312a)**
(team `Lobiklukas`). 45 issues, 11 milestones, 12 labels. `.mcp.json` in this repo wires Linear's MCP
server for every agent, so new work is created there rather than in a local backlog file.

**The immediate objective is milestone L:** run the whole workflow locally, end to end, before
anything is provisioned in the cloud. Every other milestone is ordered relative to that gate.

---

## Goal

**A delegated task goes in, a reviewable PR comes out — and then the factory runs its own backlog.**

Self-hosting is the target state: the issues in this project are executed by factory sessions
triggered from Linear, not by a human at a terminal. That is the same sentence as "MVP", which is why
the external trigger is MVP-critical rather than a v2 nicety. The roadmap's closing condition is
[LOB-41](https://linear.app/lobiklukas/issue/LOB-41) — three issues from this project implemented by
the factory in a row — and its first hard gate is milestone **L**, the same workflow run locally.

## MVP definition (the P0 line)

An operator — or a Linear issue — hands the factory a task bound to a repository, and gets back a
reviewable PR:

1. the task arrives from Linear, bound to a repo and a base ref;
2. the agent runs in a sandbox, not on the developer's machine;
3. its tool calls are policed by configuration, and dangerous ones ask for approval;
4. it pushes one branch (`factory/<session-id>`) with a short-lived, repo-narrowed credential;
5. the control plane opens the PR and the session links to it;
6. the operator watches and steers live, and can see what it cost.

Anything not needed for that sentence is P1 or lower — regardless of how much the commercial
products ship it.

---

## Priority tiers

| Tier   | Meaning                                                                         | Linear priority | Issues |
| ------ | ------------------------------------------------------------------------------- | --------------- | ------ |
| **P0** | On the MVP critical path. Without it there is no delegate→PR loop.              | Urgent          | 12     |
| **P1** | MVP is untrustworthy or unusable without it: evidence, cost, identity, cockpit. | High            | 12     |
| **P2** | Cheap leverage: rides along with P0/P1 work, or closes a known risk.            | Medium          | 11     |
| **P3** | After the factory runs its own backlog: more triggers, orchestration, replay.   | Low             | 10     |

### P0 — the MVP critical path

| Issue                                                                                          | Milestone | Why it is P0                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [LOB-5](https://linear.app/lobiklukas/issue/LOB-5) Session↔repo binding and repo registry      | M2        | Nothing downstream exists without it: no branch to cut, no sandbox to mount, no repo for a trigger to bind. Do this first.           |
| [LOB-6](https://linear.app/lobiklukas/issue/LOB-6) Session list and activity index             | M2        | Both the CLI and the dashboard sidebar need it; the in-flight web work is already faking it client-side.                             |
| [LOB-7](https://linear.app/lobiklukas/issue/LOB-7) CLI subcommands (`run`/`watch`/`ls`)        | M2        | D9's dogfooding surface, and the cheapest place to find contract bugs before a UI hides them.                                        |
| [LOB-8](https://linear.app/lobiklukas/issue/LOB-8) Policy service and tool hooks               | M3        | D11's autonomy boundary as data instead of prose; registers the first hook.                                                          |
| [LOB-9](https://linear.app/lobiklukas/issue/LOB-9) Approval surface                            | M3        | D9 promises approval prompts; D15's safety story needs them durable across restart.                                                  |
| [LOB-10](https://linear.app/lobiklukas/issue/LOB-10) CredentialProvider → GitHub App token     | M3        | D14. Without it there is no push, only a local commit.                                                                               |
| [LOB-11](https://linear.app/lobiklukas/issue/LOB-11) Worktree and branch lifecycle             | M6        | D10. The unit of isolation for the agent's own work.                                                                                 |
| [LOB-12](https://linear.app/lobiklukas/issue/LOB-12) PR creation and PR link                   | M6        | The product's output. Exactly-once across retries.                                                                                   |
| [LOB-13](https://linear.app/lobiklukas/issue/LOB-13) Sandbox `ExecutionEnv` over agent-sandbox | M4        | D3/D6. Leaves the developer's machine; the same seam later serves GKE and Cloudflare.                                                |
| [LOB-14](https://linear.app/lobiklukas/issue/LOB-14) Linear → session trigger                  | T         | The input half of self-hosting. Cheap once LOB-5/6 and the PR path exist.                                                            |
| [LOB-15](https://linear.app/lobiklukas/issue/LOB-15) Session → Linear write-back               | T         | The output half. A trigger without write-back is a queue nobody can see.                                                             |
| [LOB-40](https://linear.app/lobiklukas/issue/LOB-40) First local end-to-end run                | L         | The gate. Individually-tested parts can still be a broken loop; nothing is trusted until this script runs locally against this repo. |

### P1 — trustworthy enough to hand real work to

| Issue                                                                                               | Milestone | Why                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [LOB-16](https://linear.app/lobiklukas/issue/LOB-16) Verification-as-evidence on the PR             | M6        | Our differentiator: the repo's own verify-skill convention becomes the PR's proof.                                                                                                                |
| [LOB-17](https://linear.app/lobiklukas/issue/LOB-17) Per-session and per-repo cost attribution      | M5        | R4. Inference dwarfs infrastructure; spend without attribution is unmanageable.                                                                                                                   |
| [LOB-18](https://linear.app/lobiklukas/issue/LOB-18) Presence lease + SessionBus                    | M4        | Makes D12 true: a sandbox can own a session and still be streamed by a replica.                                                                                                                   |
| [LOB-19](https://linear.app/lobiklukas/issue/LOB-19) Queue visibility                               | M5        | Steering is real but invisible, so nobody trusts it.                                                                                                                                              |
| [LOB-20](https://linear.app/lobiklukas/issue/LOB-20) Control-plane identity and actor               | M7        | Every session, approval and dollar needs an owner before anything is exposed.                                                                                                                     |
| [LOB-21](https://linear.app/lobiklukas/issue/LOB-21) Readiness, shutdown, request limits            | M2        | Deployment floor: real probes, no dropped in-flight state on SIGTERM, bounded input.                                                                                                              |
| [LOB-22](https://linear.app/lobiklukas/issue/LOB-22) Board UI: lanes, card pane, attention view     | B         | The cockpit _is_ the board: lanes from the definition, a card pane, and what needs a person. Replaces the session list, and deletes the browser-local registry.                                   |
| [LOB-41](https://linear.app/lobiklukas/issue/LOB-41) Self-hosting: three issues done by the factory | S         | The closing condition for the whole roadmap, and it is testable: three issues implemented, steered where needed, and merged.                                                                      |
| [LOB-42](https://linear.app/lobiklukas/issue/LOB-42) Board domain: tasks, columns, gates            | B         | The unit of work stops being a session. Every board decision in `docs/board.md` lands here: tasks + events, a versioned definition, moves that carry an actor and a revision, and evidence gates. |
| [LOB-46](https://linear.app/lobiklukas/issue/LOB-46) Specifying stage                               | B         | A card need not be complete; this is where the pipeline extracts what is missing, and where a question gets parked on the task instead of hanging in a transcript (§11).                          |
| [LOB-48](https://linear.app/lobiklukas/issue/LOB-48) Skills kernel                                  | B         | A column can only bind skills if skills exist in the factory. Registry plus the injection point at `openSession`, seeded with three written skills.                                               |
| [LOB-49](https://linear.app/lobiklukas/issue/LOB-49) First board-driven local run                   | B         | Milestone B's gate: the whole path driven from the board, with the refusals proven, not just the happy path.                                                                                      |

### P2 — leverage, and the risks already on the books

| Issue                                                                                        | Milestone | Why now-ish                                                                                            |
| -------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| [LOB-23](https://linear.app/lobiklukas/issue/LOB-23) Typed session documents (`defineDoc`)   | M5        | Removes stringly-typed reads and gives the PR URL a home that survives restart.                        |
| [LOB-24](https://linear.app/lobiklukas/issue/LOB-24) Fork, rewind and reset                  | M5        | Recovery from a bad turn, already paid for by Pi Durable.                                              |
| [LOB-25](https://linear.app/lobiklukas/issue/LOB-25) Explicit `Harness.resume()`             | M4        | Makes crash recovery deliberate and testable instead of incidental.                                    |
| [LOB-26](https://linear.app/lobiklukas/issue/LOB-26) Live task panel (`inspect`/`taskGraph`) | M5        | "What is live right now", and the debugging surface for Missions later.                                |
| [LOB-27](https://linear.app/lobiklukas/issue/LOB-27) Compaction and fast log open            | M5        | Closes R6 before long sessions make the fold the default path.                                         |
| [LOB-28](https://linear.app/lobiklukas/issue/LOB-28) OTel metrics and admission control      | M7        | Queue depth is a differentiator (almost nobody exposes it) and an operational need.                    |
| [LOB-29](https://linear.app/lobiklukas/issue/LOB-29) Agent-readiness gate                    | M3        | One product has this; it is content, not infrastructure, and it gates autonomy.                        |
| [LOB-30](https://linear.app/lobiklukas/issue/LOB-30) Rulesets as reviewed code               | M7        | R3: today the security boundary could be missing without anyone noticing.                              |
| [LOB-31](https://linear.app/lobiklukas/issue/LOB-31) Repro hygiene                           | M3        | Sandbox image, CI, and three pieces of dead weight.                                                    |
| [LOB-32](https://linear.app/lobiklukas/issue/LOB-32) `usage.tools`: fix or withdraw          | M5        | An unverified cost claim is worse than an absent one.                                                  |
| [LOB-44](https://linear.app/lobiklukas/issue/LOB-44) Outcome metrics                         | M7        | Rides LOB-28's OTel path. Without it "working" is an opinion and PR counts are a metric that lies. §9. |

### P3 — after the factory runs its own backlog

| Issue                                                                                     | Milestone | Why later                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [LOB-33](https://linear.app/lobiklukas/issue/LOB-33) Sentry trigger                       | T         | Highest-value trigger after Linear, but a wrong fix PR is worse than no PR: wait for trust.                                                                                          |
| [LOB-34](https://linear.app/lobiklukas/issue/LOB-34) Jira, GitHub, Slack, generic webhook | T         | Extract the trigger abstraction from Linear first, then each surface is an adapter.                                                                                                  |
| [LOB-35](https://linear.app/lobiklukas/issue/LOB-35) Missions on `defineTask`             | V2        | The design's v2; primitives are shipped, so it is an extension rather than a subsystem.                                                                                              |
| [LOB-36](https://linear.app/lobiklukas/issue/LOB-36) Review agent                         | V2        | The review _agent_ is table stakes; the review _UI_ stays in GitHub (D16).                                                                                                           |
| [LOB-37](https://linear.app/lobiklukas/issue/LOB-37) Docs automation                      | V2        | Idempotence is the whole feature; it needs quiet PR machinery first.                                                                                                                 |
| [LOB-38](https://linear.app/lobiklukas/issue/LOB-38) Cost prediction before a run         | V2        | Needs session history to predict from — i.e. it needs P0 to have produced runs.                                                                                                      |
| [LOB-39](https://linear.app/lobiklukas/issue/LOB-39) Deterministic replay across models   | V2        | The strongest "better than the products" candidate, and it needs real sessions to replay.                                                                                            |
| [LOB-43](https://linear.app/lobiklukas/issue/LOB-43) Spec → tickets                       | V2        | Decomposition is hand-written today; it needs LOB-23's typed spec and a dispatcher that consumes the edges it writes. Talk input, §9.                                                |
| [LOB-45](https://linear.app/lobiklukas/issue/LOB-45) Plan freshness                       | V2        | What the plan left out is learned by doing the work. Needs LOB-42 (the loop) and LOB-23 (the goal of record); proposals are human-cut, never auto-dispatched. Talk input, §9.        |
| [LOB-47](https://linear.app/lobiklukas/issue/LOB-47) Knowledge base: session-cited pages  | V2        | Mastra credits its curated wiki for triage accuracy; without it every session re-derives the same traps. Rebuilds the technique on the log rather than taking `@mastra/memory`. §10. |

---

## Tracks: backend, CLI, UI

Work is split into three tracks, each independently verifiable — a change in one is provable without
the other two being finished.

| Track       | Scope                                                                         | Linear label | Verified by                                                                         |
| ----------- | ----------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| **Backend** | `apps/api`, `packages/*` — control plane, harness, sandbox, storage, triggers | `backend`    | `.pi/skills/verify-api/` (16 checks today) plus the package suites with Postgres up |
| **CLI**     | `apps/cli` — `factory run` / `watch` / `ls`                                   | `cli`        | `.pi/skills/verify-cli/`, driven in tmux (does not exist yet — LOB-7 creates it)    |
| **UI**      | `apps/web` — the operator cockpit                                             | `ui`         | `.pi/skills/verify-web/`, driven in a real browser against the routed cockpit       |

Rules that keep the split honest:

- **The cockpit is already half-built, uncommitted.** A routed multi-pane UI exists in the working
  tree (sessions / approvals / sandboxes routes, sidebar, session pane, transcript entries) with
  `verify-web/drive.mjs` already rewritten for it. LOB-22 must be re-read against that tree before
  anyone starts it, and LOB-6 (the server-side list) is what replaces the sidebar's browser-local
  `sessionRegistry`.
- **Every issue belongs to a track** and says so in its labels; the counters above are the Linear
  filter (`label:backend`, `label:cli`, `label:ui`).
- **Every issue names its acceptance as an observable result at its own track.** An issue that can
  only be checked by reading code is not ready to be worked.
- **A track's driver is part of that track's work, not a follow-up.** The UI's historical-read and
  steering cases (LOB-22), the CLI's tmux driver (LOB-7), and the backend's per-method RPC coverage
  all land with their feature.
- **The whole loop is its own slice** (LOB-40, `.pi/skills/verify-workflow/`) because three green
  tracks can still be a broken workflow.
- **How to run slices at once, locally:** `docs/parallel-work.md` — isolated subagents are enabled
  for this repo (`.omp/config.yml`), and that document carries the shared-Postgres, port and
  one-writer-per-checkout hazards, plus the hand-off line to the factory.

---

## Milestones

| Milestone                                   | Done when                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M2 — session surface complete**           | A session names its repo, `factory ls` reads the server, and the CLI drives create → stream → answer. Closes M2 from `docs/design.md`.                                                                                                                                                                                                                                                                                               |
| **B — board (MVP)**                         | A task is created, moved through the columns by a person, a run started from it, a question parked on the task and answered, the plan approved by a human move, and the card lands in review with the PR link — driven from the board, with the transitions and refusals proven. No autonomy: every run is started by a person. (LOB-42, LOB-46, LOB-48, LOB-22, LOB-49)                                                             |
| **M3 — policy, credentials, sandbox image** | A tool call is refused by configuration with a clear error, an approval survives a restart, and a static-token push works locally. `verify-policy` proves the refusals.                                                                                                                                                                                                                                                              |
| **M4 — sandbox runtime (local kind)**       | create → pause → resume → destroy on kind with PVC persistence, and the env passes Pi Durable's conformance suite. **Isolation is still not proven** (R2).                                                                                                                                                                                                                                                                           |
| **M5 — operator cockpit**                   | The dashboard lists sessions, streams one live, steers it, decides an approval, and shows spend and the PR link.                                                                                                                                                                                                                                                                                                                     |
| **M6 — worktree, push, PR**                 | Two concurrent sessions on one repo produce two branches and two PRs, each with evidence in the body, and no cleanup leaks.                                                                                                                                                                                                                                                                                                          |
| **T — external triggers**                   | A labeled Linear issue becomes a **task** with the right repo, and the issue gets the PR link and a state change back. No duplicates on replay; a question the run needs is posted as a Linear `elicitation` and the reply arrives as an event, never as a re-read comment; an issue whose blockers are unmerged does not start. The board that owns those moves is milestone **B**; automatic dispatch is wave 2 (`docs/board.md`). |
| **L — first local run (whole workflow)**    | The whole script runs on this machine: delegated issue → repo-bound session → local sandbox → policy refusal + approval → branch push → PR with evidence → Linear write-back → cost and list visible, with all three tracks' drivers passing. No cloud resource involved. This is the gate before M7.                                                                                                                                |
| **M7 — GKE and isolation**                  | A sandbox on gVisor is created, used and destroyed on the dedicated cluster, with rulesets applied as code, and LOB-44's outcome metrics report lead time, defect pressure and adoption. Requires explicit approval.                                                                                                                                                                                                                 |
| **S — self-hosting**                        | The next three issues in this project are executed by factory sessions and merged after review.                                                                                                                                                                                                                                                                                                                                      |
| **V2 — orchestration, review, replay**      | A mission completes across a restart with per-worker cost; a review agent comments on a real bug; a session replays on a second model; a typed spec decomposes into proposed child issues and the plan is re-read after work completes (LOB-43, LOB-45); cited knowledge pages are curated from completed work (LOB-47).                                                                                                             |

## Next three

The target is milestone **L** — the whole workflow, running locally. In order:

1. ~~**LOB-5** — session↔repo binding.~~ **Done 2026-10-05** (`cebb996`). `createSession({ repo,
baseRef })`, the `repos` registry, the resolved workspace in the snapshot, and the binding in the
   log so the index is rebuildable.
2. ~~**LOB-6** — the list endpoint.~~ **Done 2026-10-05** (`cebb996`): `listSessions` over the
   derived `session_activity` index, one statement per page, cursor-paged, with `rebuildIndexes` as
   the recovery path.
3. **LOB-7 + LOB-21** — the CLI and the deployment floor; together they finish M2. Both were paused
   mid-flight on 2026-10-05, with the partial work preserved (not applied) at
   `.verify/scratch/paused-agents/` and the remaining acceptance criteria in `docs/next-agent.md`.

The board (milestone **B**) runs alongside M3 and M6 rather than after them, because it is a second
contract on the same session API: LOB-42 (domain) → LOB-48 (skills kernel) → LOB-46 (specifying
stage) → LOB-22 (board UI), with LOB-49 as the gate. Two dependencies to respect: LOB-49 needs the PR
path (LOB-11, LOB-12) before the `review` gate can be exercised at all, and the M3 block stays where
it is — the agent is policed before anything runs unattended. Then LOB-13's sandbox. **L** is defined
by LOB-11 → LOB-12 with LOB-13 producing the PR, driven from the CLI first (D9) and from the board
once B lands.

## How this is tracked

- **Project:** `Factory MVP` (P-LOB-1), state In Progress, lead @lobiklukas.
- **Track labels:** `backend` (43 issues), `cli` (4), `ui` (7), `board` (5) — every issue carries at
  least one, so each track is a filter and is verifiable on its own.
- **Other labels:** `mvp` marks the P0 set; `control-plane`, `harness`, `sandbox`, `triggers`,
  `observability`, `infra`, `self-hosting`, `board` refine the area within a track.
- **Milestones:** the eleven above — M2 … M7, **B (the board MVP, before T)**, T, **L (the local-run
  gate)**, S, V2.
- **MCP:** `.mcp.json` at the repo root runs `npx mcp-remote https://mcp.linear.app/mcp`, which every
  stdio MCP client (OMP, Claude Code) picks up. First use authorizes in a browser; the token is
  cached in `~/.mcp-auth` and shared by all of them. No API key is stored in the repo.

## Not on this roadmap

Diff/review UI (GitHub owns review, D16 — the review _agent_ is LOB-36), SSO/SCIM/audit-log product,
plugin marketplace, airgapped or self-hosted tier, mobile apps, multi-vendor harness orchestration,
and an agent-readiness _service_. Reasons in `docs/features.md` §7. Also out: an internal MCP
gateway/context engine — the context corpus here is the repository itself (§9) — and any vendor
memory or agent framework as a dependency, Mastra included: the log plus typed docs are the memory
(§10).
