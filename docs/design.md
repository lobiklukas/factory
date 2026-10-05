# Agent Software Factory — Design

An internal, agent-native software development platform: delegate a task, get back a
reviewable pull request. Built on Effect, Kubernetes, and Pi Durable.

Status: design agreed through 2026-10-05. All decisions settled; no open items.

---

## 1. Scope

**What it is.** A control plane that runs coding agents against our repositories and hands
back reviewable PRs. An operator delegates work from a CLI or a web dashboard, watches and
steers the agent while it runs, and reviews the result in GitHub.

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

### D8 — Read model: live when running, historical when not

If the sandbox is live, the UI attaches to the harness (`viewState()`, `watch()`) and streams.
If it is paused or gone, the control plane serves a cached read folded from the log. The UI
must label which mode it is in so a historical read is never mistaken for a live one. Steering
wakes the sandbox first.
_Rejected:_ always read the projection (two read paths with different staleness); always wake
(discards the cost argument in D4).

_As built (M2)._ Ownership decides the path, and it is a registry in the control plane process: a
session this process holds open streams from the live view; one it does not is a reader-mode fold.
The two paths project the _same_ active transcript (newest head marker onward), and both are
asserted to agree entry for entry. `mode` is on every snapshot, and a historical stream sends its
snapshot and then **ends**, so a completed fold is distinguishable from a dropped connection. The
projection diffs whole views rather than forwarding operations, so a subscriber that falls behind
still converges. `notify`-driven catch-up — the third branch, for a session owned elsewhere — waits
on D12.

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
_Rejected:_ an agent-authored review command (cheap to add later as another conversation with a
cheaper model and read-only tools, better once we know what our diffs look like); PR-level
review automation in CI (a different product surface, and it belongs after we trust our output).

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

**R5 — `Sandbox` CRD is `v1beta1`.** We inherit a SIG Apps controller and its API may shift.
Accepted because it replaces exactly the boring, bug-prone machinery (stable identity, pause
and resume, warm pools) we would otherwise own.

**R6 — The fold is on the critical read path.** D8 means a paused session's history is served by
folding the log. Bounded by compaction, cacheable, but it needs a benchmark before it becomes
the default path for a large session.

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
