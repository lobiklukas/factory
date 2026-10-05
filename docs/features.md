# Agent Software Factory — Feature Research

What to build next, ranked, with the evidence for each call. `docs/design.md` holds the settled
decisions (D1–D16) and the build order (M0–M7); `docs/handoff.md` holds the state. This document
does not restate either — it adds the thing both leave out: **which features are worth building,
in what order, and why.**

Method. Four inputs, all in this repo or cited:

1. A code audit of `apps/*`, `packages/*`, the migrations, and the last ~25 commits, with a
   file:line for every state claim below (evidence column).
2. The installed Pi Durable 1.0.3 type surface (`.d.ts` + README/CHANGELOG — the npm tarball ships
   no `docs/`), diffed against what `packages/harness` actually uses.
3. A survey of 13 autonomous-engineering products (Factory, Devin, Codex, Cursor, Jules, Amp,
   OpenHands, Copilot, Codegen, Tembo, Warren, Optio, Symphony-class supervisors) from vendor docs,
   changelogs, and one independent comparison (`https://rywalker.com/research/autonomous-agentic-engineering-tools`).
4. One conference talk: WorkOS's software factory (`https://youtube.com/watch?v=HvboD89DyQ8`,
   transcript, 2026-10-05) — the process-encoding argument behind §9, which added LOB-42 → LOB-45 to
   `docs/roadmap.md` and changes no decision in `docs/design.md`.
5. One comparable shipping system: Mastra Factory (§10) — open source, the same loop, read from its
   docs, launch posts and template rather than from a survey row. It added LOB-46 and LOB-47 and
   reshaped LOB-42.

Two caveats carried forward from the repo itself: nothing on a cluster is proven, and no local run
proves isolation (`docs/design.md` R2). Every "proven" in the table below means the repo's own
recorded verification run said so.

---

## 1. The finding

**The factory has no features that close the loop, and the design already knows it — the gap this
research finds is not the build order, it is four missing pieces in the contract around it.**

1. **A session cannot touch a repository.** `CreateSessionInput` is `{ title?, requestId? }`
   (`packages/domain/src/Session.ts:164-170`) and the working directory is a scratch folder,
   `SESSION_ROOT/<session-id>` (`apps/api/src/index.ts:35-36`). Every product surveyed binds work to
   a repo, a base ref, and a branch before the agent starts. This is the single cheapest change with
   the largest blast radius on everything downstream (worktree, sandbox, credentials, PR).
   **Shipped 2026-10-05 (LOB-5, `cebb996`).**
2. **Nothing lists sessions, and the dashboard is already working around it.** The `sessions` table
   has no status or activity column (`packages/storage-postgres/src/migrations/0003_create_sessions.ts:19-23`),
   and `apps/web` grew a _client-side_ `sessionStorage` registry because there is no server read
   (`apps/web/src/lib/atoms/session-registry.ts:1-13`). **The read shipped 2026-10-05** (LOB-6):
   `listSessions` answers from the derived `session_activity` index in one statement; the registry is
   still there and LOB-22 deletes it.
3. **There is no approval surface**, even though D9 names approval prompts as a dashboard feature and
   D15 rests the entire autonomy story on hooks that `packages/harness` never registers
   (`apps/api/src/Rpc/Session.ts` — 5 methods; `packages/domain/src/Rpc.ts:44` "NOTE: Sandbox,
   approval, and sandbox-status groups merge in here").
4. **There is no identity and no spend accounting.** The RPC surface has no authn of any kind
   (`apps/api/src/index.ts:92-97` is CORS and nothing else), and while `SessionUsage` is already in
   the domain contract, per-session cost is never aggregated (`usage.tools` comes back `{}` —
   `docs/handoff.md` task 6).

The second finding is strategic: **several of the market's biggest unsolved problems are ones this
design already paid for.** The survey's "unmet in market" list includes a portable, replayable
session log, cross-machine presence, portable policy-as-code, and pre-execution cost prediction. D7
(the append-only log is truth), D6 (the executor is a seam), D8/D12 (presence then bus), and D11
(policy is data) are each a direct answer to one of them. That is where this factory can be better
than the products rather than a worse copy of them — see §5.

---

## 2. Where the factory actually is

| Surface               | State         | Evidence                                                                                                                                                                   |
| --------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 harness spike      | done          | `packages/harness/src/m0-live-turn.ts`, `session.test.ts:87-138`                                                                                                           |
| M1 Postgres `Storage` | done          | `PostgresStorage.ts:71-382`; 23-case conformance, `PostgresStorage.test.ts:62,75`                                                                                          |
| M2 control plane      | done          | `packages/core/src/SessionService.ts`; 25/25 in `.pi/skills/verify-api/drive.ts`                                                                                           |
| M2 CLI                | done          | `apps/cli/src/index.ts` + `commands/{run,watch,ls}.ts`; 14/14 in `.pi/skills/verify-cli`, driven in tmux                                                                   |
| M2 deployment floor   | done          | `/livez` + `/readyz` (`apps/api/src/Api/Probes.ts`), SIGTERM owner release, 1 MiB body cap; `verify-api` `sigterm.sh` 10/10 and `degraded.sh` 11/11                        |
| M2 `SessionBus`       | **not built** | `packages/bus` absent; handoff task 7                                                                                                                                      |
| M3 local deps         | **partial**   | `compose.yaml` only; no sandbox image, no `CredentialProvider`, no policy service                                                                                          |
| M4 k8s tier           | not started   | `packages/sandbox*`, `infra` absent                                                                                                                                        |
| M5 dashboard          | **partial**   | routed cockpit (TanStack Router: sessions, approvals, sandboxes), 10/10 in `verify-web`; `listSessions` exists but the sidebar reads a browser-local registry until LOB-22 |
| M6 git/PR path        | not started   | no worktree, branch, credential, or PR code anywhere                                                                                                                       |
| M7 GKE                | not started   | gated on explicit approval                                                                                                                                                 |

Production-readiness gaps that matter before any cluster (all verified in the audit): `GET /`
returns the constant `"Hello Effect!"` (`apps/api/src/Api/Health.ts:5-6`) — the probes are the health
surface now; no rate limiting or admission control; no HTTP status mapping for `SessionError` (the
RPC path carries typed errors, the plain routes answer 200 or 503); migrations are forward-only
(`packages/storage-postgres/src/Migrations.ts`), and since LOB-21 they run in a background retry
loop instead of the boot path, so a pod binds while its database is down; no Dockerfile, no CI.

Closed since the audit: the probes, the body cap, and `SessionService.close` on SIGTERM (LOB-21 —
`apps/api/src/Api/Probes.ts`, `apps/api/src/index.ts`).

Drift and dead weight found: `packages/storage-postgres/docker-compose.yml` still points at port
5432 with `stack_effect` credentials, contradicting `AGENTS.md` and `docs/handoff.md` (5442,
`factory`); `effect-boxes` is a declared, never-imported dependency (`apps/cli/package.json:21`);
`ApiResponse` is exported and unused (`packages/domain/src/Api.ts:4-7`).

**Status, 2026-10-05.** The cockpit rebuild is no longer in flight — it landed with the M2 work
(`cebb996` and the docs commits after it): TanStack Router with a generated `routeTree.gen.ts`,
routes for `sessions`, `sessions.$sessionId`, `approvals` and `sandboxes`, and `session-sidebar` /
`session-pane` / `transcript-entry`. What has _not_ moved: the sidebar still reads the browser-local
`sessionRegistry` (`apps/web/src/components/session-sidebar.tsx`), which is LOB-22's job to replace —
and LOB-22 now reshapes those routes into the board instead of adding to them (`docs/board.md`).

---

## 3. Group A — close the loop (must build; the loop is the product)

These are ordered by dependency, not by size. Each one is already implied by the design; what this
research adds is the contract detail the design leaves out and the evidence that it is missing.

| #   | Feature                                                                                                                                                                                                                                                         | Cost | What it adds beyond the design                                                                                                                                                                                           | Evidence it is missing                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| A1  | **Session↔repo binding + repo registry.** `CreateSessionInput` gains `repo`, `baseRef`, `template?`, `model?`, `autonomy?`; a `repos` index row (droppable, D7) plus a repo config file (`AGENTS.md` or `.factory/config`) for build/test/verify commands.      | S–M  | Design D13 covers `SandboxTemplate` but nothing binds a session to a repository at all — D10's branch and worktree have nothing to branch from. Repo config is what makes "run the tests" a fact instead of a guess.     | `Session.ts:164-170`; `apps/api/src/index.ts:35-36`                     |
| A2  | **Session list + `factory ls`** (handoff task 8). A derived `session_activity` table written from the same log (status, last activity, repo, cost), and a `listSessions` RPC.                                                                                   | S    | Resolves R6 deliberately: a list must not fold N logs. The `sessions` index already proves the pattern. Unblocks A6, the dashboard sidebar, and the CLI.                                                                 | `0003_create_sessions.ts:19-23`; `session-registry.ts:1-13`             |
| A3  | **Policy hooks + approval surface.** `hook(ToolTask, { beforeTool, afterTool })` in a policy extension; `ApprovalRequest`/`ApprovalDecision` schemas and an `approvals` RPC group; `api.memo` for durability across restart; an approval card in the dashboard. | M    | D15's enforcement is currently prose. This is also the first hook in the process, so it establishes the extension point for everything after. D9 already promises approval prompts.                                      | no hook registered in `packages/harness/src/*`; `Rpc.ts:44`             |
| A4  | **Credentials + worktree + PR** (M6, D14). `CredentialProvider` with a static-token impl first; `git worktree` at `factory/<session-id>`; PR open via the GitHub App.                                                                                           | M–L  | Small, high-frequency features hide here: `gh` auth bootstrap inside the sandbox, a PR body that carries session id and usage, and a "PR opened" session doc (A5's `defineDoc`).                                         | `packages/sandbox*` absent; no git code outside the harness `bash` tool |
| A5  | **Sandbox runtime** (M4, D6). A custom `ExecutionEnv` (pod exec + file ops) behind the existing `env` callback; `agent-sandbox` CRD via Alchemy; `registerEnvConformance` as the acceptance suite.                                                              | L    | The seam already exists: `packages/harness/src/session.ts:126-128` returns `NodeExecutionEnv` and nothing else in the harness knows where the code lives. The unclaimed `registerEnvConformance` suite is a free oracle. | `Session.ts` env callback; conformance runner unused                    |
| A6  | **Presence + `SessionBus`** (handoff task 7, D12). A Postgres lease table with heartbeat, then an `AFTER INSERT` trigger on `commits` calling `pg_notify` with a cursor.                                                                                        | M    | Prerequisite for the sandbox owning its own session in M4 (today "ownership" is a registry in one process). Also productizes as "who is working on what" — the survey's #1 unmet capability.                             | `packages/bus` absent; `mode: "historical"` is the honest fallback      |

> **Status, 2026-10-05.** **A1 and A2 shipped** at `cebb996` (`docs/handoff.md` §Proven, and
> `.pi/skills/verify-api` drives both). A1 landed as `repo`/`baseRef` + the `repos` registry +
> `.factory/config` (evidence: `packages/domain/src/Session.ts`, `.factory/session` doc in the log);
> `template?`, `model?`, and `autonomy?` were deliberately _not_ added as inert input fields —
> `autonomy` is A3/D11 and `template` is A5/D13, and a field nothing reads is worse than an absent
> one. A2 landed as `session_activity` + `listSessions` + `rebuildIndexes`; `factory ls` shipped with
> LOB-7 and is driven by `.pi/skills/verify-cli` (14/14 in tmux), so what remains of A2 is its UI half:
> LOB-22 replaces the sidebar's browser-local registry with the server list.
>
> **A3's policy half shipped** (LOB-8): `packages/harness/src/policy.ts` is D11's boundary as data —
> `AutonomyConfig` / `AutonomyRules` / a pure `decideToolCall` — installed as a `ToolTask` hook beside
> `CodingTools` and read from `SessionServiceOptions.autonomy` through the `Policy` service. The
> refusals are driven through the real session API by `.pi/skills/verify-policy` (8/8 cases, and the
> refused write is asserted absent from the filesystem). The classification is textual, so it is
> neither complete nor free of false positives: `packages/harness/src/policy.attack.test.ts` holds a
> row for each hole and each over-refusal it found (a write reached through `cd`, a force-push with
> combined short flags, a push to a URL remote, `curl -o out.json` read as egress), and
> `.pi/skills/verify-policy/features/refusals.md` states them in prose. What remains of A3 is the
> approval half — LOB-50 (contract and pending list), LOB-52 (durability via `api.memo`, riding this
> hook) and LOB-53 (CLI and dashboard consumers) — and D15's enforcement outside the agent, which is
> LOB-51/LOB-54 (credentials) and LOB-30 (rulesets).

---

## 4. Group B — table stakes our architecture already paid for

Every product surveyed ships these; for us each is wiring, not invention. Cheapest first.

| #   | Feature                                                                                                                                                                                                                                              | Why it is cheap here                                                                                                                                                                                | Market evidence                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **Per-session/repo/user cost attribution** (R4). Rollup a derived `usage` table from the log's `pi.usage` doc; a `usage` RPC and a spend pane; a per-session budget cap.                                                                             | `SessionUsage`/`ModelUsage` are already in the domain contract (`Session.ts:88-104`); the log already carries every revision. Also fix `usage.tools` or withdraw per-tool rollups (handoff task 6). | Usage metering + analytics API is table stakes (Factory credits, Devin ACU, Copilot AI Credits); per-task cost shock is the documented criticism of every vendor |
| B2  | **Signals worth exporting.** OTel **metrics** beside the existing logs/traces (queue depth, session outcomes, tokens/cost, tool error rates), to the motel collector already wired.                                                                  | `apps/api` and `apps/cli` already export OTLP logs+traces (`apps/*/src/observability/Motel.ts`). Metrics are a config change, not a project.                                                        | OTel export + a customer-owned collector, and operator-visible queue depth, are both on the survey's table-stakes list                                           |
| B3  | **Queue visibility.** Project `pi.inbox` (`InboxDoc`, unused) into the snapshot so steers and follow-ups show as queued and can be withdrawn.                                                                                                        | Pi Durable already queues and reports `whenBusy` placement; nothing reads the doc.                                                                                                                  | "Message queueing distinct from interruption" is table stakes                                                                                                    |
| B4  | **Long-session health.** Set a compaction policy, expose a manual compact action (the UI already renders `pi.compaction` entries — `packages/harness/src/projection.ts:112-113`), and add a snapshot/checkpoint for log open when a session is long. | Compaction, `selectCut`, `estimateContext` all exist in the installed package; only the policy is missing.                                                                                          | Context management is the difference between a 20-minute and a multi-hour session                                                                                |
| B5  | **Readiness and shutdown.** A real `/healthz` (DB + migration state) and `/readyz`; call `SessionService.close` on SIGTERM; a request-body cap and a length check on `content`.                                                                      | Both are one-liners around code that already exists. GKE will not accept the current placeholder probe.                                                                                             | — (this is the deployment floor, not a feature)                                                                                                                  |
| B6  | **Minimal identity.** A shared-token or GitHub-OAuth middleware that stamps `actor` onto every session, plus an `actor` column. No SSO/SCIM.                                                                                                         | D1 says single team; a control plane that runs arbitrary code with no authN is still not shippable, even internally. `actor` is also what makes B1 per-user rather than per-repo.                   | SSO/SCIM/audit log are enterprise table stakes; identity on every action is the floor                                                                            |
| B7  | **Repro hygiene.** Delete the stale compose file, drop `effect-boxes`/`ApiResponse`, pin the web deps, add a Dockerfile for the sandbox image, add CI that runs the five gates.                                                                      | Existing scripts; `.oxlintrc`/`turbo.json` already encode the rules.                                                                                                                                | —                                                                                                                                                                |

---

## 5. Group C — differentiators that fit this architecture

Ranked by "is it a moat, or is it parity". Each is grounded in a capability the survey found in _no_
major product, or in an asset this repo already has.

| #   | Feature                                                                                                                                                                                                                                                                                          | Why it fits here                                                                                                                                                                                                                                                                                                             | Cost           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| C1  | **Verification-as-evidence.** Promote the repo's `.pi/skills/verify-*` convention into a factory feature: a harness tool that runs the surface's verify skill and a PR body that carries the evidence (screenshot, driver output, exit codes) — plus a "no feature without a verify skill" gate. | The convention already exists in this repo (`AGENTS.md`: "Verification is a skill, not an afterthought"). The market sells exactly this — Factory's Droid Control `/verify` anti-fabrication protocol and annotated browser video, Devin's video evidence — and both are heavier than what we need.                          | S–M            |
| C2  | **Deterministic replay across models/harnesses.** `factory replay <session-id> --model <other>` — re-run a session's task against a different model (or later, a different harness) and diff the outcome and the spend.                                                                          | D7 makes the log the truth; D2 keeps Pi Durable behind `packages/harness`; D6 keeps execution behind `ExecutionEnv`. The survey found no product that offers replay-on-another-harness, and cites a harness-vs-model study showing harness regressions are real. This is the strongest "better than the products" candidate. | L, after A1–A6 |
| C3  | **Agent-readiness gate.** Score a repo before granting autonomy: AGENTS.md present and accurate, build/test/lint commands runnable in the sandbox image, a verify skill for each surface, a `.pi`-style skill dir. Feed the score into the default autonomy level.                               | The survey found this in exactly one product (Factory Agent Readiness) and nowhere else, and it is content, not infrastructure — a read-only skill plus one derived table. It also converts A1's repo config from a convenience into a precondition.                                                                         | S–M            |
| C4  | **Queue depth and admission control as operator metrics.** Max concurrent sessions, per-repo concurrency, backpressure visible on the dashboard.                                                                                                                                                 | Falls out of A6's presence lease and B2's metrics export. The survey: only Devin exposes queue health; nobody else does.                                                                                                                                                                                                     | S, after A6    |
| C5  | **Portable policy-as-code.** Keep D11's "the decision is data" and make the policy document a versioned file that also feeds the GitHub rulesets (R3).                                                                                                                                           | The survey's #8 unmet capability: policy formats are per-vendor and nothing is neutral. We already decided the decision is data; making it reviewable and testable is a small step from there.                                                                                                                               | S–M, with A3   |
| C6  | **Cross-repo coordinated change.** One session that touches two repositories with a single merge gate and atomic rollback.                                                                                                                                                                       | The survey's #4 unmet capability. Explicitly _not now_: it contradicts D10's one-branch-per-session and there is no consumer yet. Recording it here so the contract (A1's `repo` field) can be a list later without a migration.                                                                                             | L, v3          |

---

## 6. Group D — cheap wins from unused Pi Durable primitives

Verified against the installed 1.0.3 `.d.ts`. All are "the dependency already does this and we never
called it". Each is a candidate to ride along with A1–A6 rather than a project of its own.

| Primitive                                                                                      | Unused today                                                                      | Enables                                                                                                                                                   | Cost |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `defineDoc` / `defineDocFamily`                                                                | yes (built-in docs read by raw string kind)                                       | Typed per-session state committed atomically with the transcript: job spec, acceptance criteria, PR URL, retry counter. Removes the stringly-typed reads. | S    |
| `Conversation.fork` / `reset` / `Tx.forkConversation`                                          | yes                                                                               | "Try a different approach" and "undo a bad turn" as first-class actions; the basis for a reviewable branch per attempt.                                   | M    |
| Ownership tree (`ownership`, `background`, `abortTask`, `ConversationAbortOptions.background`) | yes (only a flat `conversation.abort()` at `packages/harness/src/session.ts:222`) | Cascade-abort a subagent tree; detached background work that survives an Esc.                                                                             | M    |
| `defineTask` + `waiting`/`on`/`failFast`                                                       | yes                                                                               | The first real Mission: a checkpointed plan→code→test→PR task with fan-out/join, not a new subsystem (matches the design's v2 argument).                  | M    |
| `Harness.resume()`                                                                             | yes                                                                               | Explicit recovery of pending runs after a crash or a raised idle timeout; today reopen only works because `submit()` restarts the scheduler.              | S    |
| `Harness.inspect()` / `taskGraph()` / `watchTaskGraph()`                                       | yes                                                                               | An operator "what is live right now" panel; detect blocked or orphaned tasks.                                                                             | S–M  |
| `Harness.usage()` + the `UsageDoc` token                                                       | yes (string kind only)                                                            | Session-total spend and quota reads, type-safe. Feeds B1.                                                                                                 | S    |
| `Conversation.configure()`                                                                     | yes (model/cwd set only at creation, `session.ts:135-142`)                        | Runtime model/toolset/working-directory switch = per-session policy without a new session.                                                                | S    |
| `ToolControl` (`terminate`/`handoff`/`addTools`)                                               | yes                                                                               | End a run, hand off to another agent, change tool loadout mid-run.                                                                                        | S    |
| `api.memo`                                                                                     | yes                                                                               | Exactly-once side effects across recovery: one PR per session, one sandbox per session. Load-bearing for A4.                                              | S    |
| `submissionByRequest` lookup side                                                              | partial (write side only)                                                         | Reacquire a submission and dedupe a retried interrupt/send after a restart.                                                                               | S    |
| `ToolSlot` type + `droppedBytes`/`details`/`diagnostics`                                       | structural re-parse in `projection.ts` (`projectToolSlot`), drops them            | Type-safe live tool rendering; surfacing truncated output instead of losing it silently.                                                                  | S    |
| `registerEnvConformance`                                                                       | yes                                                                               | The oracle for A5.                                                                                                                                        | S    |
| `Storage.scanConversations`                                                                    | yes                                                                               | The A2 list without folding logs.                                                                                                                         | S    |

Two corrections to assumptions worth recording: Pi Durable has **no** `skills` primitive (the
Extension/Section/Tool machinery is the closest — skills will be our concept, and the market's
`SKILL.md` convention is worth copying for portability); and the npm tarball ships no `docs/`, so
"read the bundled docs" means README + CHANGELOG only.

---

## 7. Group E — consciously not building

| Not building                                                                                         | Why                                                                                                                                                                                                                        | Market note                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Diff/review UI                                                                                       | D16: GitHub owns review.                                                                                                                                                                                                   | Unanimous in the survey; even the vendors that ship a review surface keep GitHub as the merge gate. Keep D16.                     |
| A review **agent** — as a headless session, not a UI                                                 | The design rejected the UI, not the conversation. It is table stakes in the survey (Bugbot, Codex auto-review, Factory code review), and it is one read-only session with a cheaper model once A1–A4 exist.                | Revisit right after M6, not before.                                                                                               |
| SSO/SCIM, audit-log product, plugin marketplace, airgapped/self-hosted tier, mobile apps             | Enterprise table stakes for vendors with enterprise buyers. D1 says one team, internal. Revisit only if the factory is sold or spans orgs.                                                                                 | Named in the survey as table stakes; irrelevant to a single-team internal tool.                                                   |
| Our own harness, or multi-vendor harness orchestration                                               | D2; the latter is Tembo/Conductor's product, not a capability gap for us.                                                                                                                                                  | —                                                                                                                                 |
| IDE plugins / ACP surface                                                                            | Distribution, not capability, and it needs a stable RPC first. ACP has become the cross-editor standard, so this is a later cheap surface.                                                                                 | —                                                                                                                                 |
| Missions as a subsystem, Automations, AutoWiki, Agent Readiness _scoring service_, Slack/Linear/Jira | Design v2. Note what this research changes: the first slice of each is small because Pi Durable supplies the primitives (Group D) — Missions ≈ `defineTask`; the first Automation ≈ one webhook + A1 + A2; readiness ≈ C3. | Scheduled/webhook triggers and tracker delegation are table stakes; one entry point (GitHub PR issues/labels) is enough to start. |
| Cross-machine presence _protocol_, cross-vendor run-log format                                       | A6 gives presence inside our own control plane; an open, vendor-neutral protocol is a standards play with no consumer.                                                                                                     | The survey's #1/#2 unmet capabilities — worth watching, not worth pioneering now.                                                 |

---

## 8. Recommended sequence

**The plan itself now lives in `docs/roadmap.md`** — this section is the research's reasoning; the
roadmap is the priority tiers, the Linear issues, and what "done" means for each milestone.

The design's M0–M7 order is still right; this research only reorders the _inside_ of M2/M3 and adds
what the design leaves out. Concretely:

**Status, 2026-10-05.** A1, A2, and M2's remaining two issues shipped — the CLI (LOB-7, 14/14 in
`.pi/skills/verify-cli`) and the deployment floor (LOB-21: `/livez`+`/readyz`, SIGTERM owner release,
the body cap). M2 is closed; the board (milestone **B**, `docs/board.md`) now sits alongside M3/M6
rather than after them: it is the operator surface, and LOB-42 is the next contract change of the
same rank as A1 was.

**Now (M3, with the board alongside):**

1. ~~**A2 session list + activity table**, then the CLI (`factory run`, `factory watch`, `factory ls`)
   with a `verify-cli` skill driven in tmux — M2's own definition of done.~~ **Done 2026-10-05**
   (LOB-6, LOB-7): the list is one statement over `session_activity`, and the CLI is driven in a real
   tmux terminal.
2. ~~**A1 session↔repo binding + repo config.**~~ **Done 2026-10-05** (`cebb996`): `repo`/`baseRef` +
   the `repos` registry + `.factory/config`, and the binding is a document in the log so the index
   rebuilds from it. It is the precondition for A4, A5, C3, and any Automation.
3. ~~**B5 readiness/shutdown + B7 hygiene** while passing through: a real health probe, a SIGTERM
   handler, body caps, the stale compose file, the two dead exports.~~ **Readiness, shutdown and body
   caps done 2026-10-05** (LOB-21, `verify-api`'s `sigterm.sh` and `degraded.sh`). The hygiene half —
   the stale compose file and the two dead exports — is LOB-31 and still open.

**Then the design's M3, with the two additions this research justifies:**

4. **A3 policy hooks + approval surface** — the first hook in the process; negative-case tested
   (`verify-policy`: refuse a push to `main`, a force-push, a ref deletion, a write outside the
   worktree), per handoff task 9.
5. **A4 credentials → worktree → PR**, with **C1 verification-as-evidence** riding on the PR body.
   This is the first moment the factory produces the thing it exists to produce.
6. **B1 cost attribution + B2 metrics** alongside A4, because a PR with a spend number attached is
   strictly more reviewable, and R4 is cheapest to close while the usage path is fresh.
7. **A5 sandbox runtime** (M4) with `registerEnvConformance` as its oracle, then **A6 presence/bus**
   and **B6 minimal identity** before M7 — an unauthenticated control plane is not something to
   learn about on GKE.
8. **C3 readiness gate**, then **C6→C2** (replay) once sessions have produced enough PRs to have
   something worth replaying.

**Deliberately last:** everything in §7, and Missions as a subsystem — the first Mission should be
`defineTask` plus subagents, not a new component.

---

## 9. Talk input: WorkOS software factory — TARS and Horizon (2026-10-05)

Source: `https://youtube.com/watch?v=HvboD89DyQ8` (transcript; a WorkOS engineer on building an
internal software factory). Recorded after `docs/roadmap.md` was written. It changes no decision in
`docs/design.md`; it added four issues (LOB-42 → LOB-45) to the roadmap.

**What it argues.** The standard factory — sandbox, agent, prompt, PR — is table stakes, and in
their words it was "indistinguishable" from engineers running Claude Code on their laptops. So they
moved the engineering _process_ into the factory:

- a **hilltop document** (purpose, customer need, competitive analysis, early design, milestones)
  that an agent decomposes into tracker tickets, with a human reviewing at each stage — the blank
  page, not the autonomy, is what the agent fixes;
- **ticket dependencies drive execution**: because TARS subscribes to tracker webhooks, it picks up
  the next unblocked ticket when one completes;
- **plan freshness**: between steps they ask the agent to re-read the project and say what the plan
  is now missing, because doing the work is what reveals the gaps;
- success measured as **outcomes, not output** — delivery acceleration, defect rate, time to
  recovery, and whether engineers elect to move out of local harnesses. Their opening claim is that
  "percentage of PRs by AI" is a metric that lies.

Architecturally they split an interaction layer (TARS, embedded in Slack/Linear/GitHub) from an
infrastructure layer (Horizon) sitting in front of an **MCP gateway** — a context engine that
connects internal systems (Snowflake semantic tables, and so on) and, more importantly, carries
descriptions that teach the agent how the organization organizes its information. They call it their
biggest piece of leverage and their most reusable one. They end by asking the room how anyone
handles **authorization**, which they have not solved.

**What it validates here.** The PR as the product (D10/D16); self-hosting as the target
(LOB-41); verification-as-evidence as the trust mechanism (LOB-16) — under autonomy, proof on the PR
matters more, not less; repo readiness as content rather than infrastructure (LOB-29); and the
tracker graph as a first-class input, which Linear already holds: reading relations back for every
issue then in the project shows the real edges (LOB-5 → LOB-14/LOB-11, LOB-10/LOB-11 → LOB-12,
LOB-12 → LOB-15/LOB-16) that nothing consumed.

**What it adds.**

| Issue                                                                          | Milestone | One line                                                                                                                 |
| ------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| [LOB-42](https://linear.app/lobiklukas/issue/LOB-42) Dependency-ready dispatch | T         | Start an issue only when its `blockedBy` edges are satisfied, and recompute the frontier on merge — the graph, consumed. |
| [LOB-45](https://linear.app/lobiklukas/issue/LOB-45) Plan freshness            | V2        | After work completes, a read-only session proposes what the plan is missing, for a human to cut.                         |
| [LOB-43](https://linear.app/lobiklukas/issue/LOB-43) Spec → tickets            | V2        | The hilltop move, bounded: a typed spec doc decomposes into proposed child issues with acceptance criteria and edges.    |
| [LOB-44](https://linear.app/lobiklukas/issue/LOB-44) Outcome metrics           | M7        | Lead time, defect pressure, recovery rates, adoption — so "working" is evidence and not an opinion.                      |

**Where this repo is ahead.** Authorization. The talk ends asking the audience for it; D14/D15
already answer it — a per-sandbox, on-demand, repo-narrowed GitHub App token that is never
materialized in the sandbox (LOB-10), policy hooks as the accident stopper (LOB-8), GitHub rulesets
as the actual boundary (LOB-30), and an attributable actor on every session (LOB-20). That is worth
protecting as dispatch becomes automatic.

**Caution, and the one disagreement.** Dependency-driven autonomy multiplies a bad plan: a
mislabeled edge or an overestimating decomposition now start chains without a human. Their own
reports support this — the agent "grossly overestimates what we're trying to accomplish with this
project". So the dispatcher is downstream of the L gate and of LOB-16's evidence, and every
automatic start is attributable and skippable with a recorded reason.

**Recorded, not built.** Two ideas that do not survive translation to a single-team internal tool,
kept here so they are not re-derived from the talk:

- **An MCP gateway / context engine.** No data lake, no cross-team consumer, and the context corpus
  is the repository itself: `AGENTS.md`, the repo config from LOB-5, `.pi/skills/verify-*`, and
  LOB-29's readiness score. The transferable part is the discipline — tool descriptions and system
  prompts are the interface — which `packages/harness` already owns.
- **Session mining for missing or obsolete skills.** D7 makes it cheap in principle, but there is
  nothing to mine until **S** has produced sessions; the quality signals belong to LOB-44 when it
  exists.

## 10. Comparable system: Mastra Factory (2026-07 → 2026-09)

Sources: `mastra.ai/blog/software-factory` (2026-07-16, the six-agent build guide),
`mastra.ai/blog/announcing-mastra-factory` (2026-07-27), `mastra.ai/blog/announcing-mastra-factory-beta`
(2026-09-08, results and failures), `mastra.ai/factory`, the `factory.mastra.ai` docs
(`what-is-factory`, `using/work-and-approvals`, `using/sessions`, `configure/boards-and-rules`,
`configure/github`, `reference/mastra-factory-api`), and
`github.com/mastra-ai/softwarefactory-template` (Apache-2.0).

**What it is.** An open-source, TypeScript software factory running the same delegate → PR loop as
this project: intake boards, one sandboxed session per work item, GitHub/Linear/Slack/Jira/GitLab/
incident.io integrations, and a shared dashboard instead of one person's terminal. Reported adoption
is 25–35% of merged PRs and 50–60% of issues closed — while the post's own chart shows 277 of 1,627
merged PRs (17.0%) over a wider window, which is the denominator lesson LOB-44 now carries.

**The two ideas worth taking.**

1. **Lifecycle as data.** `defineBoard()` declares phases (`resting` / `working` / `terminal`), a
   `role` per working phase, allowed `outcomes`, per-phase `onEnter`/`onExit` rules keyed by source
   (`manual`, `issue`, `pullRequest`, `linearIssue`), and a `transitionPolicy` that rejects
   undeclared moves or demands a human one. Rule decisions — start a session with a prompt or a
   skill, transition, write back, notify, reject — carry idempotency keys. That is D11's "the
   decision is data" one level up, and it is the shape **LOB-42** now takes: dependency gating
   becomes one rule, and per-stage automation becomes configuration instead of code.
2. **Investigation before implementation.** Their triage stage produces a reviewable artifact —
   diagnosis, supporting evidence, assumptions, reproduction results, questions — and non-bug work
   needs recorded human acceptance before planning or building. Their production account is the
   argument: full automation across every stage was "bursty when importing backlogs, causing infra
   issues and generating a lot of difficult-to-review work", and wrong upstream assumptions
   generated PRs that had to be closed. That is **LOB-46**.

**Taken in smaller pieces.** The metric set and its window/denominator discipline (LOB-44); review as
its own item with its own identity, and re-review on new commits (LOB-15, LOB-36); agent-addressable
steering signals (LOB-35); the credential traps — installation tokens cannot drive `gh` inside a
sandbox, reviewer identity must differ from the author's, stored credentials need a stable
encryption key (LOB-10); `setupCommand` as part of sandbox-template identity (D13, LOB-5); intake
that never imports a pre-existing backlog, and automatic starts only for trusted authors (LOB-42,
LOB-20).

**Deliberately not taken.**

- **Release and production-monitoring agents.** Their pipeline versions, changelogs, deploys,
  verifies, rolls back and watches production on a 15-minute cron. This project stops at a reviewable
  PR (D16), and their own rule agrees: merging always waits for a person.
- **`@mastra/memory`'s observational memory, as a dependency.** The technique is right — a
  background pass (Observer, then Reflector) compresses a growing transcript into a dense observation
  log, with temporal gap markers, activation on a token threshold, and a failure policy that can let
  the turn continue. But the package is coupled to Mastra's `Agent`/`Memory` and to its own storage
  adapters; adopting it puts a second memory truth beside D7's log, breaks replay-from-log, and hides
  the Observer/Reflector model calls from LOB-17's attribution. We rebuild the equivalent on our own
  primitives: compaction inside the log (LOB-27), typed extractors as docs (LOB-23), and
  cross-session cited pages (LOB-47). Their configuration is a good checklist for LOB-27's
  acceptance — especially the failure path, because their docs warn that `failurePolicy: 'continue'`
  plus a sustained outage moves the failure into the model's context limit, which is exactly the
  silent compaction failure we must assert against.

**Strategic read.** The loop is now commodity: an open-source factory with this exact shape exists,
and its agents/tools/workflows are adaptable by design. The moat stays the §5 list — evidence on the
PR, a replayable log, presence, policy-as-code, cost attribution — and Mastra's existence strengthens
the case for deterministic replay across models and harnesses (C2), which is a machine they do not
have.

---

## 11. How the market handles an underspecified task (2026-10-05)

Sixteen systems, read from their own documentation, on four questions: who asks when a task is thin,
where the question lands, does the run pause, and is the plan gated. This is the survey behind
`docs/board.md` B7 and the `specifying` stage.

**The common shape.** A distinct scoping stage before any code — Factory's Spec Mode and Missions
planning, Devin's Ask mode, Cursor's Plan mode, Jules's Interactive Plan, Hermes's "✨ Specify", and
Linear's own rule that "requests to investigate, debug, research, plan… are treated as scoping the
problem, not implementing it" — then a **human-approved plan** (Factory's `ExitSpecMode`, Devin's
Markdown plan with an Implement button, Cursor's Build button, Jules's approve plan, Codegen's opt-in
`Propose Plan`, Warren's approved-plan-then-dispatch), then the pull request.

**Who does not do it.** Copilot's coding agent has no back-channel at all: it "does not see comments
added after assignment", and its docs steer ambiguous work away from the agent. Amp has no
clarification phase and no plan gate — prompt discipline only. Codex cloud documents no
wait-for-input state and no plan gate. Tembo has neither. OpenHands keeps the agent out of it
entirely and gates _issues_ upstream instead — a parsed template with acceptance checklists and a
`ready-for-dev` label before any agent sees the task.

**Waiting is nearly universal.** Jules's `AWAITING_PLAN_APPROVAL` / `AWAITING_USER_FEEDBACK`,
Devin's Blocked group and "orange favicon when it's waiting for you", Linear's `awaitingInput`,
Mastra's Needs attention, Optio's `needs_you`, Hermes's `blocked` with a typed kind. The exception is
deliberate: Cursor's Q&A tool is explicitly non-blocking — "the agent can continue reading files,
making edits, or running commands, then incorporate your answer as soon as it arrives" — and its
cloud waits are event subscriptions rather than pauses.

**Typed questions are rare.** Linear's `elicitation` activity (server-validated, auto-posted as a
comment), Devin's CLI `ask_user_question` (a first-class, revertable step), Optio's typed inbox
envelope. Every other product asks in prose, and several make dispatchability depend on prose
prefixes — Hermes's own deferred issue names that as "fragile for autonomous Kanban dispatch".

**Two universal gaps.** (1) **Nobody escalates an unanswered question.** Across all sixteen; no timeout,
no reassignment, no auto-close — the work simply waits, and only a person noticing rescues it. (2)
**Gates get defeated quietly:** Jules auto-approves its plan on an undisclosed timer with
`requirePlanApproval` defaulting to false — a gate that exists in the interface and not in the
system. Both are cheap for us to do concretely: a blocked card is a first-class, ageing, visible state
(B7), and nothing in this design self-releases.

**The failure mode we designed out.** Hermes shipped the anti-pattern — workers were instructed not to
call `clarify` because "you are running headless — there is no live user to answer", and the bug was
a worker asking anyway: the tool timed out (~120s default), the card sat silently in `running`, and
the worker invented a fallback. Their fix is our B7: the question is durable board state (a comment
plus a block), and a respawned worker re-reads the thread. OpenAI's Symphony spec states the rule
normatively — "a run MUST NOT stall indefinitely waiting for user input".

**What it changes here.** Nothing in the MVP cut: it confirms the pipeline (`intake → specifying →
planning → building → review`), the plan as a human-gated artifact, and the question parked on the
task. It moved one thing earlier — the specifier must declare gaps explicitly, including the "none"
case (Devin's `megaplan` rule) — and it hands the wave-2 question object its outward half for free,
since Linear's `elicitation` already exists and replies arrive as events.

Sources: `docs.factory.ai` (Missions, planning, specification mode, automations, triage, remote
delegations) · `docs.devin.ai` (Ask Devin, CLI changelog, release notes, session tools) ·
`cursor.com/docs` (agent/plan-mode, cloud-agent/capabilities, integrations/slack) · `ampcode.com/docs`
(prompting, orbs, deep mode) · `jules.google/docs` (review-plan, running-tasks, errors, changelogs,
REST API sessions/activities) · `developers.openai.com/codex` (`learn/best-practices`, workflows,
third-party/github) · `docs.github.com/en/copilot` (cloud agent, research-plan-iterate, kick-off) ·
`linear.app/developers` (agent-interaction, agent-best-practices, coding-sessions) ·
`docs.openhands.dev` (issue lifecycle, security, stuck detector) · `docs.codegen.com` (agent behavior,
API resume-run, checks auto-fixer) · `docs.tembo.io` · `optio.host/docs/task-lifecycle` +
`github.com/jonwiggins/optio` · `github.com/jayminwest/warren` (`plan-run-coordinator.md`) ·
`github.com/openai/symphony/SPEC.md` · `factory.mastra.ai` (work-and-approvals, boards-and-rules) ·
`github.com/NousResearch/hermes-agent` (kanban docs, `kanban_db.py`, issue #29171).

---

## 12. Sources

Repo: `docs/design.md` (D1–D16, M0–M7, R1–R6), `docs/handoff.md`, the audit's file:line evidence
(§2), `packages/harness/src/*`, and the installed
`@earendil-works/pi-durable@1.0.3` type surface (`dist/**/*.d.ts`, README, CHANGELOG).

Market: `https://rywalker.com/research/autonomous-agentic-engineering-tools` (13-product comparison,
verified 2026-09-15); `https://docs.factory.com/llms.txt` and the pages read directly —
`software-factory/automations.md`, `agent-effectiveness/cost-and-productivity.md`; the vendor doc
URLs behind the survey, notably `docs.factory.com/remote-delegations/{slack,linear,jira}.md`,
`docs.factory.com/api-reference.md`, `docs.factory.com/software-factory/{triage,code-review-ci,security-review,automated-qa,droid-control,release}.md`,
`docs.factory.com/missions/overview.md`, `docs.factory.com/agent-readiness/overview.md`,
`docs.factory.com/droid-computers/overview.md`, `docs.factory.com/enterprise/telemetry/data-reference.md`,
`docs.devin.ai/product-guides/automations`, `code.claude.com/docs/en/agent-sdk/overview`,
`cursor.com/docs/integrations/slack.md`, `openhands.dev/blog/openhands-enterprise-agent-control-plane`,
`github.blog/news-insights/company-news/welcome-home-agents/`.
