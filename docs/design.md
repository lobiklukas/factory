# Agent Software Factory — Design

An internal, agent-native software development platform: delegate a task, get back a
reviewable pull request. Built on Effect, Kubernetes, and Pi Durable.

Status: design agreed through 2026-10-05. All decisions settled; no open items.

---

## 1. Scope

**What it is.** A control plane that runs coding agents against our repositories and hands
back reviewable PRs. Work is a **task on a board** (D17, `docs/board.md`): an operator brings a task
in from a tracker or creates it, moves it through columns that bind a role and its skills, watches and
steers each run while it happens, and reviews the result in GitHub.

**Non-goals (v1).** No code review UI — GitHub owns review. No billing, SSO, audit log, or
plugin marketplace. No multi-tenant isolation; it is an internal tool for one team. No
agent harness of our own; we adopt one.

**Deferred to v2.** Missions (multi-feature orchestration), Automations (schedule/webhook/
event triggers), AutoWiki, Agent Readiness scoring, Slack/Linear/Jira delegation, security
review, incident response.

The reasoning behind deferring Missions: Pi Durable already supplies the primitives
orchestration needs — `defineTask` with phases and `waiting`/`on`/`failFast`, an ownership
tree with bottom-up `abort`, `defineDoc` for externalized state, and fresh-context subagents
as owned conversations. So a Mission becomes an extension we author rather than a subsystem
we build. It is still the largest single design and the piece most likely to be wrong in
ways that burn real money, so it ships after sessions earn trust.

---

## 2. Decisions

Each entry records what we chose, why, and what we rejected.

### D1 — Deployment target: single cluster, internal

Single-tenant, single-cluster, for our own team. `org_id` and tenant boundaries are carried
through the schema from day one so a multi-tenant product is a schema-compatible later step
rather than a rewrite.
_Rejected:_ multi-tenant SaaS (isolation and governance work with no current consumer);
open-source self-hosting (support surface with no current consumer).

### D2 — Harness: adopt Pi Durable, own the control plane

Pi Durable (`@earendil-works/pi-durable@1.0.3`) depends on `pi-ai` and `chord`. It provides
durable conversations with checkpointed tasks, resumable runs after a process dies, exactly-once
submissions via `requestId`, a pluggable `Storage` backend with a conformance suite, pluggable
`ExecutionEnv`, extensions/tools/hooks, typed documents committed atomically with the
transcript, compaction, conversation forking, and multi-client observation.
_Rejected:_ writing our own agent loop (the most commoditized and most expensive part of the
product); forking an OSS harness.

### D3 — Topology: one harness process per sandbox

The harness runs inside the sandbox next to the code, so tool calls are local syscalls rather
than network round-trips. The Effect control plane is a client, and owns identity, scheduling,
policy, and secrets.
_Rejected:_ a central harness with a remote `ExecutionEnv`; a split topology with an
orchestrator harness in the control plane. Two topologies means two sets of failure modes for
a small team.

### D4 — Compute: `agent-sandbox` CRD, paused when idle

Adopt the SIG Apps `Sandbox` CRD (`kubernetes-sigs/agent-sandbox`) rather than hand-rolling
StatefulSets. It provides stable identity, PVC-backed persistence, and controller-managed
lifecycle including pause and resume; extensions add `SandboxTemplate`, `SandboxWarmPool`, and
`SandboxClaim` for ~~2s provisioning from a warm pool. Isolation is delegated to `RuntimeClass`.
Per-session ephemeral sandboxes for delegated one-shot work; per-(user, repo) persistent
sandboxes that pause when idle and resume on attach.
Cost rationale: a suspended sandbox costs only its PVC (~~$4/mo for 50 GiB on gp3) versus
~$40–60/mo spot for a resident 4 vCPU sandbox, and inference spend (~$150–250/dev/month)
dwarfs both. Optimize compute for latency and simplicity, not dollars.
_Rejected:_ resident always-on pods; building our own suspend/resume and warm-pool machinery.

### D5 — Workspace: Alchemy for everything

Alchemy v2 is Effect-native IaC whose `Layer` owns both the resource and the service
implementation. Its Kubernetes provider is cluster-agnostic and its `Manifest` resource
explicitly covers CRDs and custom resources, so the `Sandbox` CRD is declarable. GCP provider
covers Cloud Run, Secret Manager, Pub/Sub, Firestore, BigQuery, Memorystore with IAM granted
by bindings. `Kubernetes.LocalCluster` is kind-in-Docker for local development.
Control plane deployment target is a **GKE Deployment**, not Cloud Run — see D12.
Gap: Alchemy does not provision GKE clusters, so cluster and node-pool creation is manual.

### D6 — Executor seam: `SandboxRuntime` + capability descriptor

One Effect service with the operations both a Kubernetes and a Cloudflare implementation could
honestly serve — create/start, exec, read/write file, expose port, snapshot/pause, resume,
destroy, metrics — plus a capability descriptor (`isolation`, `persistence`, `maxDiskGb`,
`pauseResume`, `requiresKeepaliveForLongTasks`). The control plane adapts to capabilities
instead of assuming.
Why: the control plane must be portable to Cloudflare for free, the harness already is (Pi
Durable's storage adapters are Node-API-free and run inside a Durable Object; `ExecutionEnv`
is a seam), but the **executor is not** — Cloudflare Container instances are activity-driven
and documented to stop "even while a build, a test suite, or an agent task still runs inside
it" without request traffic, cap at 4 vCPU / 12 GiB / 20 GB disk, and use snapshots rather than
PVCs.
_Rejected:_ no interface (makes the Cloudflare question permanently expensive); a stub
Cloudflare impl we never run (drifts and lies).

_Host-only extension (LOB-244):_ a session's worktree is cut on the host before the session opens
(D10), so the harness runs a session's commands in a sandbox **bound** to that existing directory
rather than in a fresh `create`d one. `bind` is not a D6 operation: only a runtime whose commands run
on the host the directory is on can serve it, so it lives on `BindableSandboxRuntimeShape`
(`SandboxRuntimeShape & { bind }`), which the in-process runtime implements, and today
`OpenSessionOptions.sandbox` and `SessionServiceOptions.sandbox` require it. apps/api selects the
runtime with `SANDBOX_RUNTIME` and passes it as an option, not as the `SandboxRuntime` service, because
the harness needs `bind`. A non-bindable runtime (Kubernetes, LOB-89) plugs in by the control plane
cutting the worktree inside the sandbox it `create`s — the session's workdir becomes the sandbox's,
not the host's — at which point the session's option widens to `SandboxRuntimeShape` and a bound
sandbox is the in-process special case. A capability flag is not needed for that: a runtime either
has `bind` or the control plane creates. A session's bound sandbox keeps its exec spill files when
it ends (`BindOptions.keepSpillFiles`), because the session's transcript names them (Pi Durable's
bash tool reports `Full output: <path>`) and outlives the sandbox through an idle release.

### D7 — Storage: append-only log is truth, projections are derived

Postgres holds `commits(log_id, seq, writes json)` — one `log_id` per Pi Durable `Storage` (one
session), `seq` minted by the owning process (`PRIMARY KEY (log_id, seq)` fences a second owner),
`json` rather than `jsonb` because Pi Durable requires strings to round-trip unchanged and
`jsonb` rejects lone surrogates and U+0000, and a trigger makes rows immutable. The `Storage` interface is inherently a
commit log — `commit(writes) → Seq`, with cursor-based `scan*` reads — so one fold of the log
serves three consumers: the harness's in-memory state, the control-plane read model, and the
dashboards. Derived relational tables exist only for what we actually query (session status,
usage and cost, tool-call rollups) and are explicitly droppable and rebuildable.
Requirements this creates: the Postgres `Storage` adapter needs a **read-only, non-owning mode**
so the control plane can read without opening a `Harness` (Pi Durable's contract is one owning
process per storage).
_Rejected:_ a full relational projection of every record kind (reimplements ~3,000 lines of
SQLite semantics as SQL, makes record-shape changes into DDL against an experimental
dependency, and loses "delete the cache and replay" as a universal repair); SQLite on the
sandbox PVC (couples session history to a running sandbox).

_As built (M2)._ A `sessions` table (`id`, `title`, `request_id`, `created_at`) is the first such
derived table: it is an index, not a projection. `id` is the `log_id`, so the join back to the log
needs no lookup; `request_id` makes a retried create idempotent; and the title is _also_ committed
as a `factory.title` entry, so dropping the table loses nothing but the index. A session id is
`ses_` + ten Crockford base32 characters of millisecond timestamp + sixteen of randomness: one
identifier that is a `log_id`, a URL segment, and a git branch (D10).

_As built (LOB-268): one exception to "droppable"._ `sessions.workspace_released_at` and
`workspace_release_reason` record that a terminal event (the card's `done` or `canceled`, the PR's
merge, an operator's discard) tore the session's worktree and branch down. That is a fact about the
filesystem, not about the log, so `rebuildIndexes` cannot refold it; it leaves the columns alone, so a
rebuild over existing rows keeps them, but dropping the `sessions` table loses them, and every released
session would then cut a fresh worktree at its base and take a new run. Kept on `sessions` rather than
in a table of its own because it is read on every owner acquisition beside the rest of the row; if
this table is ever dropped as a repair, the releases are to be re-derived from the cards in a terminal
column, the merged PRs and the absent `factory/<id>` branches first.

### D8 — Read model: live when running, historical when not

If the sandbox is live, the UI attaches to the harness (`viewState()`, `watch()`) and streams.
If it is paused or gone, the control plane serves a cached read folded from the log. The UI
must label which mode it is in so a historical read is never mistaken for a live one. Steering
wakes the sandbox first.
_Rejected:_ always read the projection (two read paths with different staleness); always wake
(discards the cost argument in D4).

_As built (M2)._ Ownership decides the path, and it is a registry in the control plane process: a
session this process holds open streams from the live view; one it does not is a reader-mode fold.
The two paths project the _same_ transcript, read from the start of the log, and both are
asserted to agree entry for entry — a historical read of a long session carries the newest
entries and pages back through the rest on request (R6, LOB-243), and the pages join into the same
transcript. (A head marker — `pi.reset`, `pi.compaction` — says where the
_model's_ context begins, not where the transcript does: a reset keeps the past and marks where it
happened, LOB-181.) `mode` is on every snapshot, and a historical stream sends its
snapshot and then **ends**, so a completed fold is distinguishable from a dropped connection. The
projection diffs whole views rather than forwarding operations, so a subscriber that falls behind
still converges. `notify`-driven catch-up — the third branch, for a session owned elsewhere — waits
on D12.

_As built (LOB-18)._ The third branch exists. A session another process owns — a live presence lease
held by another holder (D12) — reads as `live` and streams from its log: the fold's snapshot with what
the log says is running (`pi.live`, `pi.inbox`, the spend, the live task records), then events diffed
from each read, in a live stream's order. The stream ends once the session is no longer owned
elsewhere, as a fold's ends after its snapshot, so a client that reattaches is told which path it is
on. Work on such a session is refused as `owned_elsewhere`; it is taken where the session is owned.

### D9 — Surfaces: CLI first, web dashboard second

Both are clients of the same HTTP + WebSocket API. The CLI comes first because it is what we
dogfood daily and it forces the session/stream/approval contract to be correct before any UI
hides a bug. Pi Durable's `watch()` and `viewState()` mean the web app consumes an API that
already exists.
The web UI is a **control plane for agents**, not a code surface: session list, live transcript
and tool calls, steer/interrupt/queue, pause/resume, sandbox status and metrics, approval
prompts, and a linked-out GitHub PR.
_Rejected:_ a diff viewer or review workspace (GitHub owns review); Slack first (cheap once the
API is real, painful if built first).

### D10 — Git: one branch per session, agent may push its own branch

Branch `factory/<session-id>` per session, worktree as the sandbox working directory. The agent
may commit and **push its own branch**. The control plane opens the PR.
_Rejected:_ agent working on the user's current branch (blast radius is the working tree);
control-plane-only pushes (the agent cannot iterate against real remote state).

### D11 — Autonomy: the branch is the boundary

Everything inside the session worktree is unattended. Push to `refs/heads/factory/<session-id>`
is unattended. Anything that escapes is gated. Always blocked rather than merely gated:
force-push, ref deletion, tag pushes, changing remotes, writes outside the worktree (`$HOME`,
`~/.ssh`), and network egress to non-allowlisted hosts.
Policy is an Effect service and the decision is data, so "what may run unattended" is a config
surface rather than logic scattered across hooks.
_Rejected:_ approve-everything (makes Missions impossible); full autonomy (how you discover
your token was over-scoped).

### D12 — Control plane: stateless replicas with Postgres fan-out

The control plane is a GKE Deployment, not Cloud Run. Cloud Run WebSockets are HTTP requests
subject to a request timeout (default 5 minutes, max 60), bill as instance-based CPU while any
connection is open, and offer only best-effort session affinity, so cross-instance fan-out
requires bolting on Redis or Firestore. A control plane whose job is holding long-lived
per-session streams is fighting that platform.
Fan-out uses Postgres `LISTEN`/`NOTIFY` — already our system of record, so no new dependency —
behind a `SessionBus` service, with an in-process implementation as a legitimate local-dev
Layer and Redis as a later replacement if `NOTIFY` becomes the bottleneck.
_Rejected:_ single replica with in-process subscriptions (the ceiling is fine, but "which
replica holds my session's stream" is the last bug you want to debug on a multi-hour session).

_As built (M2)._ There is one replica, and it is also the local sandbox (D3), so it owns the harness
in-process and streams from it. `SessionBus` is deliberately **not built yet**: a session owned by
another process is served by folding, which is the honest answer while nothing can say who owns
what. Two things unblock it, in order: **presence** (which process or sandbox owns a session, with a
lease and a heartbeat), then the bus itself — an `AFTER INSERT` trigger on `commits` calling
`pg_notify`, carrying a _cursor_ (`log_id`, `seq`) rather than an event, because `NOTIFY` payloads
cap at 8000 bytes and D7 makes the log truth. A subscriber reads the log from the cursor, so the
notification is a hint and the log stays authoritative.

_As built (LOB-18)._ Both pieces exist. **Presence** is one `leases` table keyed `(kind, key)` —
`session` today, the dispatcher's `card` claims in wave 2 (B12) — with a holder (one process, minted
at boot), a home (its host and absolute session root), a fence that rises each time a claim changes hands,
and an `expires_at` its holder renews every third of the TTL (30 s by default). Every owner claims its
session under the owners' gate before it opens the log and gives the claim back after the harness is
closed; a renewal that finds the claim gone (it lapsed and another process took it) releases the
owner. Time is the database's `now()`, so two machines agree on what has lapsed. A claim whose holder
shares this process's home — host and session root, where the worktrees are — is taken back at once
rather than waited out: it is the process this one replaced after a crash.
The **bus** is migration 0034's trigger notifying `factory_commits` with `{log_id, seq}`, one
`LISTEN` per process started by the first follower (`SessionBus`, `packages/core`: one consumer does
not earn `packages/bus`). A follower reads on every hint and on a poll (2 s) that also asks whether the
session is still owned elsewhere, so a lost hint costs a delay, never an event. There is no
in-process `SessionBus` Layer: one process's owners already stream in-process (D8's first branch), so
the bus is only ever needed between processes. The root scoping and `MISSION_RESUME=false` of LOB-231
and LOB-25 stay: they scope _which_ rows a boot sweeps, the lease decides whether it may take them.

_As built (LOB-231)._ A booting API now takes owners nobody asked for: `resumeMissions` reopens and
resumes every session whose row says a mission is in flight (`sessions.mission_in_flight`), because a
mission waits on no client and would otherwise stay `pending` in its log. Without presence that is a
**single-process rule**: the row is marked with the absolute `SESSION_ROOT` of the process that ran
the mission (`mission_session_root`), and a boot resumes only the rows marked under its own root, so
an instance with another root — every verify skill's throwaway API on the shared development
database — leaves them alone. Two processes on one database _and_ one root would both resume a
mission and both own its log until Postgres poisons one of them on `PRIMARY KEY (log_id, seq)`; such a
second process sets `MISSION_RESUME=false`. The presence lease above replaces both the root scoping
and the flag when replicas arrive.

_As built (LOB-25)._ The same rule now covers a run in a conversation, not only a mission. Any owner
that opens a log continues the submissions its root conversation holds unsettled (`openSession` →
`resumePending`), so a run whose process died — a SIGTERM's close or a SIGKILL — carries on as the
same submission rather than waiting for the next message. Only the root's submissions decide it: a
mission worker's own conversation holds a placed submission while it talks to the model, and that
alone does not resume a log. But Pi Durable has one scheduler per harness, so once a root submission
is pending the reopen resumes everything pending in the log, a mission included — as any submit or
wait on that log always has. The boot finds those logs the way it finds missions: the owner's
projection writes `sessions.run_session_root` while a run is in flight, and `resumeRuns` reopens the
rows marked under its own root. `MISSION_RESUME=false` turns off only these two boot sweeps, for a
second process on the same database and root; an owner that process opens later still continues
what its root left unsettled. A released session's open does not resume: its run has no directory.
`interrupt` and `withdraw` take the owner paused, act, and then continue what is left, so a stop
lands on the dead run rather than racing a resumed one.

### D13 — Sandbox image: generic base, then templates where they pay

Bun, Node, git, gh, ripgrep, plus Pi Durable and the harness. Repo-specific toolchains install
on demand per sandbox; `SandboxWarmPool` absorbs the latency. Per-repo `SandboxTemplate`s are
the end state but are additive, and we cannot know which repos deserve one until we have
watched real sessions.
_Rejected:_ baking our repos' toolchains into one image; a template family per toolchain from
day one.

### D14 — Credentials: GitHub App, per-sandbox, narrow and short-lived

A GitHub App installation token per sandbox, narrowed to the session's repositories, obtained
on demand rather than persisted into the image, env, or disk. A `CredentialProvider` seam with
a static-token implementation so local development needs no registered GitHub App. Token
refresh is a first-class operation on a long session.
_Rejected:_ a shared service-account PAT (one prompt injection becomes the whole org's source);
forwarding each user's own key (makes CI-delegated and Slack-delegated sessions unreasoning).

### D15 — Enforcement: policy in hooks, boundary at GitHub

Pi Durable's hooks (`hook(ToolTask, { beforeTool, afterTool })`, plus `beforeRequest` /
`afterResponse` / `onYield` / `afterTools` on `GenerationTask`) are where policy, approval,
and intent live. `api.memo()` makes an approval durable across a restart, so a paused sandbox
can still ask and a resumed one does not re-ask.
An approval covers one run of the call it names, not the command for the rest of the session: the
same call after that run asks a person again, while a denial stands (LOB-52).
But hooks run in the same process and trust domain as the tools they gate, and pi's own
`docs/security.md` is explicit: _"Watching the transcript, using project trust, and reviewing
changes do not create a security boundary,"_ and _"Keep credentials outside the environment
where possible, or use narrowly scoped, short-lived credentials."_ So enforcement rests outside
the agent's reach:

1. The push credential is short-lived, repo-narrowed, and never materialized in the sandbox.
2. GitHub rulesets make the dangerous refs unwritable regardless of agent behavior —
   `main` PR-only with no app bypass; `factory/**` with block-force-push and restrict-deletions.

Hooks stop the accident with a clear error the agent can self-correct from. Rulesets stop the
bypass. This is cheaper than routing pushes through a relay we would then have to treat as
security-critical.
This refines D14: the push credential is obtained on demand and never persisted into the
sandbox, rather than being injected as a long-lived value. Hooks remain the policy layer and
are not treated as an enforcement boundary, per pi's own security documentation.
Residual risk: the app can still create new branches, and ruleset configuration is part of the
security surface, so it must be code. Alchemy's GitHub provider covers repositories,
Actions secrets/variables, and webhooks, but not rulesets — that is a custom provider or
Terraform's `github_repository_ruleset`.

### D16 — Review happens in GitHub

The system's output is a pull request. The UI links to it.
_Amended (LOB-36):_ the factory now adds one agent-authored review to its own PRs, and it still
happens in GitHub. A `pull_request` on a PR a card's run opened starts a reviewer run — another
conversation, on the reviewer role's (cheaper) model, in a read-only stage — that posts one
`COMMENT` review per head under its own GitHub identity, never the author's, and never approves:
the human merge gate is the decision (B5). There is still no review UI. It is not trusted until it
is measured on our own PRs (LOB-242). Since LOB-241 its verdict is also a condition of
`review → done` (B5's `review_verdict`): the person still merges, but not over a newest head the
reviewer failed or has not finished.
_Rejected:_ PR-level review automation in CI (a different product surface, and it belongs after we
trust our output).

### D17 — The unit of work is a task on a board, not a session

Sessions remain the execution primitive, but the product's spine is a board: tasks with columns, runs
attached to tasks, and moves that are gated. `docs/board.md` holds the settled board decisions
(B1–B12), the default pipeline and the MVP/wave-2 cut; milestone **B** builds it with no autonomy — a
person starts every run — and the dispatcher that makes it self-driving is wave 2.
_Rejected:_ Linear as the only board (the tracker cannot express per-column automation, run lineage,
admission, or "waiting on a blocked issue", and mirroring micro-states into it turns two systems into a
reconciliation job); a board-scope log under `commits` (possible — `log_id` is free-form and
`rebuild.ts` deliberately skips non-`ses_` ids — but a log is a single-writer resource, and a card is
_input_: a person typed it, and there is no log to replay it from); modeling cards as Pi Durable
`Task`s (tasks are created through a `Session` commit, and a card must exist before any session does).

### D18 — `listSessions` walk is best-effort, not a snapshot

A page-by-page walk of `listSessions` is **not** a snapshot of the table as of its first page. The
ordering key is `session_activity.last_activity_at`, which every live event for an owned session
rewrites to "now" (`recordActivity` → `touch` / `setActivityStatus` / `setActivityCost`), so a row can
move between two pages of the same walk: it can leave the range being traversed and be omitted, or
move back below the cursor and be returned twice (the latter needs `rebuildIndexes`, the only writer
that moves a key backwards). A walk is a client's loop across independent calls, so a true snapshot
would need either one transaction spanning every page or a materialised snapshot id carried in the
cursor; both change the contract and carry costs (pinning `xmin` for the walk's duration, or growing
the cursor with a third field that collides with the millisecond-truncated cursor case). We keep the
best-effort walk and document the contract in `SessionService.list`'s doc comment; callers that page
the whole table re-walk from the top.
_Rejected:_ materialised snapshot via `pg_export_snapshot()` (collides with the millisecond-truncated
cursor tolerance in `parseCursor` and pins `xmin` for the walk's duration, for a case ordinary traffic
can only reach in the skip direction).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Control plane (GKE Deployment, Effect)                               │
│   sessions · sandboxes · policy · credentials · PRs · usage rollups  │
│   SessionBus (Postgres LISTEN/NOTIFY) · read model (fold of the log) │
└───────┬─────────────────────────┬───────────────────────┬────────────┘
        │ HTTP + WS               │ Kubernetes API         │ GitHub API
        ▼                         ▼                        ▼
   CLI / web dashboard      Sandbox CRD + controller    GitHub App
                              (agent-sandbox)            rulesets
                                   │
                            ┌──────▼──────────────────────────┐
                            │ Sandbox (kind local / GKE prod)  │
                            │  harness process (Pi Durable)    │
                            │  worktree on PVC                 │
                            │  other tools · policy hooks      │
                            └──────┬───────────────────────────┘
                                   │ Storage (log)
                                   ▼
                              Postgres
```

### Component and seam inventory

| Package                       | Responsibility                                                             | Seam it exposes                                                    |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/domain`             | Schemas for product entities and API contracts, shared by every layer      | `Schema` definitions only                                          |
| `packages/core`               | Session, sandbox, credential, and policy services as Effect `Layer`s       | `SessionService`, `SandboxService`, `Policy`, `CredentialProvider` |
| `packages/board`              | Board domain: definitions, tasks, runs, transitions, evidence gates        | `BoardService`, column rules                                       |
| `packages/storage-postgres`   | `Storage` implementation: append-only log + read-only non-owning mode      | Pi Durable's `Storage`                                             |
| `packages/storage-projection` | The single fold of the log into state, plus derived query tables           | `Projection`, `ReadModel`                                          |
| `packages/sandbox`            | `SandboxRuntime` interface and capability descriptor                       | `SandboxRuntime`                                                   |
| `packages/sandbox-kubernetes` | `SandboxRuntime` over the `agent-sandbox` CRD                              | efficient implementation of the above                              |
| `packages/harness`            | Extension, tools, hooks, policy, and system prompt assembly for Pi Durable | `Extension` registrations                                          |
| `packages/bus`                | Fan-out between control-plane replicas                                     | `SessionBus`                                                       |
| `apps/api`                    | HTTP + RPC surface for CLI and web                                         | `HttpApi` / `RpcServer`                                            |
| `apps/cli`                    | Interactive and headless operator client                                   | —                                                                  |
| `apps/web`                    | Dashboard: sessions, live transcript, steering, approvals                  | —                                                                  |
| `infra`                       | `alchemy.run.ts` composition root                                          | Alchemy `Stack`                                                    |

### What we do not build

Session durability, resumable runs, exactly-once submissions, transcript storage primitives,
compaction, conversation forking, subagent plumbing, tool registration, approval memoization,
streaming event delivery, token and cost accounting (`UsageDoc`), live state for UIs
(`LiveDoc`, `ToolSlot`), and queued-message state (`InboxDoc`).

---

## 4. Local-first build order

Nothing is provisioned in Google Cloud until M7 is explicitly approved. Everything through M6
runs on this machine.

**M0 — Harness spike.** Pi Durable as a local process with `NodeExecutionEnv` against a repo
checkout and memory storage. Goal: prove the session, stream, steering, and approval contract
end to end. No Kubernetes, no Postgres, no cluster.

**M1 — Postgres `Storage`.** Append-only log plus the fold, with Pi Durable's
`StorageConformanceRunner` as the acceptance suite. Both the owning mode and the read-only
non-owning mode.

**M2 — Control plane and CLI.** Session lifecycle, messages, interrupt, streaming; `SessionBus`
with an in-process implementation; `packages/domain` schemas. First dogfoodable milestone.

**B — board (local, human-driven).** The unit of work becomes a task on a board (D17): `packages/board`
over `tasks`/`task_events`, a versioned board definition, columns binding roles and skills, moves that
carry an actor and a revision, evidence gates, the board UI as the cockpit, and a skill registry
injected at `openSession`. Nothing auto-starts — a person begins every run — which is what keeps this
milestone small. The dispatcher, leases, caps, durable questions, dependency links and the failure
policy are wave 2 (`docs/board.md`). B is the surface milestone **L** is driven from; L's own
acceptance stays the scripted CLI loop (D9).

**M3 — Local dependencies.** Docker provider for Postgres and the sandbox image;
`CredentialProvider` with a static-token implementation; policy service with hook enforcement
and the D11 boundary.

**M4 — Kubernetes tier.** `Kubernetes.LocalCluster` (kind), the released agent-sandbox
manifest, and `packages/sandbox-kubernetes`. Validates `Sandbox` lifecycle, pause/resume, PVC
persistence, and warm-pool behavior. Node pools are not needed; kind gives a default
local-path provisioner so PVC persistence is genuinely testable.
Caveat: **isolation cannot be tested here.** Kind nodes are containers running containerd and
`runsc` needs a node-level runtime handler, so locally `isolation: none` and the
`RuntimeClass` is omitted. Local never proves sandboxing.

**M5 — Web dashboard.** Sessions, live transcript, steering, approvals, sandbox status, PR link.
A client of the M2 API.

**M6 — Git relay-free push path.** Short-lived on-demand credential, branch/worktree lifecycle,
PR creation.

**M7 — GKE (requires approval).** New dedicated cluster in `silver-pact-221712`: one system node
pool (required — GKE needs a non-sandbox pool for its own system workloads) and one sandbox
node pool via `--sandbox=type=gvisor`, plus the GitHub rulesets from D15. This is where
isolation gets validated. `microvm` is the stronger option later if we need it: it requires GKE
1.37.0-gke.4713000+ and `--enable-nested-virtualization`.

**v2 — Missions**, then Automations.

For reference, the project already contains three clusters in `europe-west1` (`ci-crane`,
`ci-nat`, `ci-public`) and a `k8s-gke-dev` context. We chose a new dedicated cluster because a
sandbox platform wants its own node pool, its own autoscaling policy, and freedom to churn
nodes — and GKE Sandbox requires node-level configuration we would not want on a production CI
pool.

---

## 5. Open risks

**R1 — Pi Durable is experimental.** Its launch post says the API "might still change." D7
absorbs most of this (record-shape changes touch projection code, not the log), but the surface
should be isolated behind `packages/harness` so churn is one file. Pin the exact version.

**R2 — Isolation is untestable locally.** Reported as a risk rather than a nuisance because a
green local suite will say nothing about sandboxing. Treat M7 as the real isolation milestone.

**R3 — Ruleset configuration is now a security surface.** The enforcement in D15 lives partly
in GitHub settings. Get it wrong and the boundary silently is not there. It needs to be code,
reviewed, and tested — and this is the same class of risk as a relay bug would have been.

**R4 — Cost attribution.** Inference spend dominates infrastructure by an order of magnitude,
and per-session attribution is what makes it manageable. Pi Durable's `UsageDoc` gives us the
raw material; turning it into per-repo, per-user reporting is ours to build.
_As built (LOB-163)._ A session may carry a spend ceiling (`createSession({ budget })`, or the
server's `SESSION_BUDGET`), committed to its log as `factory.budget`. A `beforeRequest` hook in
`packages/harness/src/budget.ts` checks it before every model request a run sends: once the session's
`pi.usage` total has reached the cap, the stop is recorded (a `budget` transcript entry and
`budget.stopped` on the snapshot) and the root conversation is aborted, as an interrupt would, so the
request is never sent. A request already in flight is paid for, so a session ends above its cap by at
most one request. A stop the log refuses to commit fails closed: the request is held, not sent. A
fork keeps its parent's cap and carries its spend; a replay keeps its source's cap at no spend; a fork
or a replay of an uncapped session gets `SESSION_BUDGET`, as a create does. The full stop semantics
are that module's header.
_As built (LOB-162)._ Spend is keyed by repo and actor. It is committed as `factory.actor` and
indexed as `sessions.actor`. `listSpend` groups the list's own `cost_total` by the pair, and the
dashboard's `/spend` shows it per repo, per actor and per pair.
_As built (LOB-20)._ The actor is the one the control plane authenticated, not the one the caller
typed. Every RPC group carries one middleware, `ControlPlaneAuth` (`@repo/domain/Auth`), which reads
`Authorization: Bearer <token>`, looks it up in the deployment's token table and hands the handler a
`Caller`; a call with no credential or an unknown one — unary or the `watchSession` stream — fails
with the typed `Unauthenticated` before its handler runs. The table is `FACTORY_API_TOKEN` (one shared
token, the actor `FACTORY_API_ACTOR`, `operator` by default — the whole local setup, and the variable
the CLI sends) plus `FACTORY_API_TOKENS` (`actor=token,…`, one per person or service); the dashboard
sends `VITE_FACTORY_API_TOKEN`. `createSession`, a fork and a replay (which now take the caller's actor
rather than their source's), `decideApproval`, and the board's create / move / block / unblock /
comment record the `Caller`'s actor and ignore a body `actor`; the board's `start` is `createSession`
with a card. A token's actor may be neither a session id (a run's actor, B5) nor `trigger:<source>`:
a trigger's credential is its route's signing secret, checked before the in-process trigger seam
mints `trigger:<source>`, so neither namespace can be claimed over RPC. The webhook routes are not
behind the middleware and keep their own signatures (LOB-81). A deployment with no token runs with
auth **off** — every call is served and a declared actor is recorded, as before — and its boot says so
in a warning. An open control plane is a loopback one: `HOST` defaults to `127.0.0.1`, and no token on
a `HOST` beyond loopback refuses the boot (`ApiAuthRequired`) unless `FACTORY_API_AUTH=off` declares
it on purpose. This is the seam where GitHub OAuth or SSO fills `Caller` later (D1 rules out SSO/SCIM
for now, not identity).

**R5 — `Sandbox` CRD is `v1beta1`.** We inherit a SIG Apps controller and its API may shift.
Accepted because it replaces exactly the boring, bug-prone machinery (stable identity, pause
and resume, warm pools) we would otherwise own.

**R6 — The fold is on the critical read path.** D8 means a paused session's history is served by
folding the log. Bounded by compaction, cacheable, but it needs a benchmark before it becomes
the default path for a large session. The storage open is bounded (LOB-186): `Storage.open`
restores the log's checkpoint and folds only the commits after it, with the full fold as the
fallback — on a 10 250-commit log, 37–46 ms and 250 commits read against 167–204 ms and 10 250.
The historical session read on top of it is bounded too (LOB-243): `readHistoricalSnapshot` reads
documents and the newest `HISTORY_WINDOW` (200) transcript entries — one scan of one page — and
says where they start (`earlier`); `readSessionHistory` pages back through the rest on request, one
page per call. The pending approvals it reports, which used to need the whole transcript, come from
the root's approval ledger (`factory.approvals`), a document every approval entry's commit copies
itself into and that the first open of an older log seeds once. The ledger records the newest entry
it accounts for (`through`), because a build from before it — a rollback, a mixed-version deploy,
worktrees on different commits sharing one database — appends approval entries without the copy:
this build's next approval write catches the ledger up from `through`, and a historical read that
finds such an entry in its window folds the transcript instead. One such entry older than the
window and newer than the ledger's last write is not seen until that next write. Measured with
`packages/harness/scripts/bench-historical-read.ts` (median of 7, a loaded machine): at 2 500 and
10 250 entries the read touched 200 entries both times, against 2 501 and 10 251 for the full
projection it replaced, and the projection over the open took 6–9 ms against 11–47 ms. The board's
run evidence opens each run's log from its checkpoint too (`PostgresStorage.readers` with
`checkpoints: true`; 32 against 194 ms on the 10 250-commit log). What stays O(log): the fold's size
in memory and the checkpoint's bytes — restoring one is most of a historical read's time on a long
log (42 of 56 ms at 10 250 entries); the index rebuild, which folds from the first commit on purpose
(a recovery path does not start from a derived row) and projects every entry; a fork and a replay,
which copy the whole transcript; the run evidence's verify records, read off every entry of the
restored fold in memory; and the first historical read of a log written before the ledger and not
opened since, which folds the transcript for its approvals.

---

## 6. Sources

- `https://factory.com/openapi.json` — Factory Public API surface
- `https://docs.factory.com/llms.txt` — documentation index
- `factory.ai/articles/what-is-a-software-factory-architecture`, `factory.ai/news/missions-architecture`
- `https://earendil.com/posts/pi-durable/` — Pi Durable
- `@earendil-works/pi-durable@1.0.3` — `Storage`, `ToolTask`, hook types, `StorageConformanceRunner`
- pi 1.0.3 `docs/security.md`, `docs/containerization.md` — the trust model quoted in D15
- `https://alchemy.run/llms.txt` — provider inventory
- `kubernetes-sigs/agent-sandbox` — `Sandbox`, `SandboxTemplate`, `SandboxWarmPool`
- `cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods` — gVisor and microVM sandbox types
- `cloud.google.com/run/docs/triggering/websockets` — the constraints behind D12
- `developers.cloudflare.com/containers/platform/pricing/`, `.../sandbox/concepts/lifetime/` — the portability limits in D6
