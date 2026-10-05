# Agent Software Factory — Feature Research

What to build next, ranked, with the evidence for each call. `docs/design.md` holds the settled
decisions (D1–D16) and the build order (M0–M7); `docs/handoff.md` holds the state. This document
does not restate either — it adds the thing both leave out: **which features are worth building,
in what order, and why.**

Method. Three inputs, all in this repo or cited:

1. A code audit of `apps/*`, `packages/*`, the migrations, and the last ~25 commits, with a
   file:line for every state claim below (evidence column).
2. The installed Pi Durable 1.0.3 type surface (`.d.ts` + README/CHANGELOG — the npm tarball ships
   no `docs/`), diffed against what `packages/harness` actually uses.
3. A survey of 13 autonomous-engineering products (Factory, Devin, Codex, Cursor, Jules, Amp,
   OpenHands, Copilot, Codegen, Tembo, Warren, Optio, Symphony-class supervisors) from vendor docs,
   changelogs, and one independent comparison (`https://rywalker.com/research/autonomous-agentic-engineering-tools`).

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
2. **Nothing lists sessions, and the dashboard is already working around it.** The `sessions` table
   has no status or activity column (`packages/storage-postgres/src/migrations/0003_create_sessions.ts:19-23`),
   and `apps/web` grew a _client-side_ `sessionStorage` registry because there is no server read
   (`apps/web/src/lib/atoms/session-registry.ts:1-13`) — uncommitted work in progress.
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

| Surface               | State           | Evidence                                                                                       |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| M0 harness spike      | done            | `packages/harness/src/m0-live-turn.ts`, `session.test.ts:87-138`                               |
| M1 Postgres `Storage` | done            | `PostgresStorage.ts:71-382`; 23-case conformance, `PostgresStorage.test.ts:62,75`              |
| M2 control plane      | done            | `packages/core/src/SessionService.ts`; 16/16 in `.pi/skills/verify-api/drive.ts`               |
| M2 CLI                | **not started** | `apps/cli/src/index.ts:7-19` — bare root command, no RPC client                                |
| M2 `SessionBus`       | **not built**   | `packages/bus` absent; handoff task 7                                                          |
| M3 local deps         | **partial**     | `compose.yaml` only; no sandbox image, no `CredentialProvider`, no policy service              |
| M4 k8s tier           | not started     | `packages/sandbox*`, `infra` absent                                                            |
| M5 dashboard          | **partial**     | shell + one card, 5/5 in `.verify/evidence/latest/observed.json`; no list, steering, approvals |
| M6 git/PR path        | not started     | no worktree, branch, credential, or PR code anywhere                                           |
| M7 GKE                | not started     | gated on explicit approval                                                                     |

Production-readiness gaps that matter before any cluster (all verified in the audit):
`GET /` returns the constant `"Hello Effect!"` (`apps/api/src/Api/Health.ts:5-6`) and the DB health
check is only reachable from a script; no rate limiting; no body/text length caps; no HTTP status
mapping for `SessionError`; migrations are forward-only and run at boot
(`apps/api/src/index.ts:76-80` provides `DatabaseLive`, which is `PostgresLive + MigratedLive`,
`packages/storage-postgres/src/Migrations.ts:27-29`); `SessionService.close` is never called by any
app (`SessionService.test.ts:173` is the only caller), so a SIGTERM mid-run discards in-flight state
that the log would otherwise have made recoverable; no Dockerfile, no CI.

Drift and dead weight found: `packages/storage-postgres/docker-compose.yml` still points at port
5432 with `stack_effect` credentials, contradicting `AGENTS.md` and `docs/handoff.md` (5442,
`factory`); `effect-boxes` is a declared, never-imported dependency (`apps/cli/package.json:21`);
`ApiResponse` is exported and unused (`packages/domain/src/Api.ts:4-7`).

In flight, uncommitted: `apps/web` is being rebuilt as a routed multi-pane cockpit — TanStack Router
with a generated `routeTree.gen.ts`, routes for `sessions`, `sessions.$sessionId`, `approvals` and
`sandboxes`, and `session-sidebar` / `session-pane` / `transcript-entry` components. `app.tsx` and
`session-card.tsx` are deleted, and `.pi/skills/verify-web/drive.mjs` was updated with them (it now
clicks a "new session" control). `format:check`, `lint` and a forced `type-check` all pass on the
current tree. What has _not_ moved: the sidebar still reads the browser-local `sessionRegistry`
(`apps/web/src/components/session-sidebar.tsx:14-21`), which is LOB-6's job to replace.

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

**Now (finish M2, and it is mostly small):**

1. **A2 session list + activity table**, then the CLI (`factory run`, `factory watch`, `factory ls`)
   with a `verify-cli` skill driven in tmux — M2's own definition of done. It is also the unblock for
   the in-flight dashboard sidebar, which is currently guessing client-side.
2. **A1 session↔repo binding + repo config.** The highest-leverage contract change in the repo; it is
   the precondition for A4, A5, C3, and any Automation. Do it before the first worktree exists, or
   the worktree has nothing to attach to.
3. **B5 readiness/shutdown + B7 hygiene** while passing through: a real health probe, a SIGTERM
   handler, body caps, the stale compose file, the two dead exports.

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

## 9. Sources

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
