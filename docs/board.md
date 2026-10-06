# The board

The factory's unit of work is a **task on a board**, not a session. This document holds the settled
board decisions (B1–B12), the default pipeline, and the MVP/wave-2 cut. `docs/design.md` holds the
decisions the board rests on (D17 introduces it); `docs/features.md` §11 holds the sixteen-system
survey it was designed against; `docs/roadmap.md` holds milestone **B** and the issues.

Status: design agreed through 2026-10-05, after a full interview round. Nothing here is built yet.

---

## B1 — A task owns runs; a run is a session

A **task** is the unit: its repo, its column, its history, its artifacts. A **run** is one attempt at
advancing it, and a run is exactly one Pi Durable session — so the run's log is the truth for what the
run did (D7), and `run_id` is the session id. A multi-step run may use `defineTask` _inside_ itself;
the card is never a Pi Durable `Task`, because Pi Durable tasks are created through a `Session` commit
and a card must exist before any session does. One cardinality rule: **one card, many runs.**

## B2 — The board is definitions plus instances, in the factory's own database

A board **definition** declares columns and their policies; a board **instance** is bound to one
repository and references a definition version. Every task pins the definition version it started
under, so editing a definition cannot mutate work in flight. Definitions live in the factory database
(not in the repository, not in the tracker), and one default definition ships in a migration.

## B3 — Cards are rows, not a log

`tasks` + append-only `task_events`, one transaction per mutation, `revision` on the task for
optimistic concurrency. A board-scope log under `commits` is _possible_ — `log_id` is free-form text
and `rebuild.ts` deliberately skips ids that are not `ses_…` — but a log is a single-writer resource
requiring owner routing, and a card is **input**: a person typed it, and there is no log to replay it
from. D7's "droppable projection" reasoning covers derived tables, not inputs; `sessions` is the
precedent ("an index, not a projection").

## B4 — The default pipeline

| Column       | Kind     | Role        | Exit requires                                                            |
| ------------ | -------- | ----------- | ------------------------------------------------------------------------ |
| `intake`     | resting  | —           | a person moves it on (nothing auto-starts; the card may be nearly empty) |
| `specifying` | working  | `specifier` | a `spec` doc, gaps declared (explicitly `[]` when there are none)        |
| `planning`   | working  | `planner`   | a plan doc **and a human move**                                          |
| `building`   | working  | `builder`   | a run that completed, a non-empty diff, and a PR link                    |
| `review`     | working  | `reviewer`  | a review verdict, and a human merge (the move into `done`)               |
| `done`       | terminal | —           | —                                                                        |
| `canceled`   | terminal | —           | —                                                                        |

`blocked` is a **card state**, not a column: a typed reason (`dependency | needs_input | capability |
transient`) plus the column it blocked from, so a blocked card stays visible in its own lane and
there is no "return to where it was" ambiguity. There is **no `ready` column** in the MVP: nothing
auto-starts, so `ready` only means something once a dispatcher exists (wave 2).

## B5 — Moves are the consequential act, so they are attributed and gated

Every move carries an **actor** and an expected **revision** (a stale drag cannot clobber a newer
state). A run may only make transitions declared for its column, and a move that crosses a
human gate can only be made by a person — recorded as such. `requires[]` is checked on exit, and a
refusal names the failing requirement. In the MVP the two human gates are the plan approval
(`planning → building`) and the merge (`review → done`); Mastra's third gate, acceptance of the task
itself, is the recorded move that starts the first run.

## B6 — Columns bind roles and skills; skills live in the factory

A column declares `role`, `skills[]`, `requires[]` and its autonomy. A role resolves to model and
tool policy in one place, so changing a model is one edit rather than one per column. Skills are
factory-owned records: markdown plus optional attachments (a driver script is an attachment), seeded
by migration in the MVP and authored in the UI later. They are injected at `openSession` — today the
only model-facing seam, where `CodingTools` is the single installed extension — as prompt sections
alongside the role's tool policy. The stored shape mirrors `.pi/skills/<name>/SKILL.md` so importing
repository skills later is a copy rather than a translation.

## B7 — Asking a human happens on the task, never in the transcript

A run that needs something **ends** — parked, not hanging — with the question recorded on the task: a
comment plus a `needs_input` block. The answer is a comment on the same task, and the next run reads
the whole thread as context. Steering stays available for a live run but is not the question channel,
because runs here are headless: Hermes shipped exactly this bug (a worker asked through the
interactive channel, timed out, the card silently sat in `running`, the worker invented a fallback),
and OpenAI's Symphony spec states the rule normatively — a run must not stall indefinitely waiting for
input. When the source is Linear, the question rides Linear's `elicitation` activity and the reply
arrives as a session event: **answers are events, never re-read editable comments**, which is Linear's
own guidance about comments.

## B8 — Evidence gates, not evidence prose

`requires[]` is machine-checked on exit, which promotes verification-as-evidence (LOB-16) from a body
artifact a reviewer may skip into a condition of the move. A skill's output is what a gate checks, so
the verify-skill convention becomes mechanism.

## B9 — Ordering and caps

Within a column: dependency readiness, then a `priority` flag (`urgent | normal`), then FIFO. No
manual drag ordering — a drag-ordered queue and an auto-claiming dispatcher are two sources of truth
about "what is next", and priority changes are recorded as events. Caps are board policy, extendable:
2 runs in flight per board, 1 per task, 2 per repo, plus a per-column WIP limit.

## B10 — Failure mapping (wave 2, recorded so the MVP does not contradict it)

`orphaned` → resume the same run; `faulted` → breaker, cleared by a person; `failed` → a new run
seeded with a handoff document, spending a per-column attempt budget; `aborted` (human) → back to the
previous column with no retry, recorded; "try another approach" → fork, both lineages visible. Pi
Durable supplies typed terminal outcomes, exactly-once submissions and resume; it supplies **no**
heartbeat, max runtime, breaker or completion gate, so those are ours.

## B11 — Outbound sync is a small, declarative map

Phase state is written out on entering `review`, on `done` and on `canceled`, plus the PR link
always. A column may declare an external state; the sync is idempotent and outbound-only for phase
state. One authority per field: the tracker owns issue text, the board owns lifecycle — the tracker
never writes our columns.

## B12 — Execution and the dispatcher

Runs execute in-process for the MVP (today's reality: the control-plane replica owns the harness, D3),
so the board must not assume a sandbox exists and run rows must be recoverable by folding the log. The
dispatcher — one loop in the control plane, claiming cards through Postgres lease rows with heartbeat,
TTL and fence — is wave 2, and it re-scopes LOB-18 so one lease table serves session presence and card
claims. Independence is by construction: **one worktree per run**, so two runs on one task (or a retry
beside a lingering old run) never share a working tree.

---

## MVP vs wave 2

**MVP (milestone B)** is the board with **no autonomy**: a person starts every run. That deletes, from
the first cut, the dispatcher, leases, claims, caps enforcement, breakers, attempt budgets, priority
bands, dependency links, the skills authoring UI, sync maps, identity beyond an actor string, board
customization, decomposition, and board metrics.

| Issue                                                   | What it lands                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| LOB-42 Board domain: tasks, columns, transitions, gates | B1–B5, B9, B11 — tables, definition, moves, gates, CLI parity |
| LOB-48 Skills kernel                                    | B6 — registry and injection at `openSession`                  |
| LOB-46 Specifying stage                                 | B7 — spec artifact, declared gaps, the ask on the task        |
| LOB-22 Board UI                                         | lanes, card pane, attention view — the cockpit _is_ the board |
| LOB-49 First board-driven local run                     | the gate: one local run driven end to end from the board      |

**Wave 2**, promoted when its trigger fires (recorded here rather than as speculative issues):

1. **Dispatcher and claims** — auto-start per column, LOB-18's leases, caps/WIP, TTL reclaim, priority
   bands, trusted-actor and created-after-enable rules. Trigger: the first run you want started without
   you. Milestone **S** is satisfiable without it; this is what makes S self-driving.
2. **Questions as durable objects** — dedup by question id, aging, resume after death, wake policy.
   Trigger: the first question asked while you are not watching. Linear's `elicitation` supplies the
   outward half, so this is smaller than it looks.
3. **Dependency links** — `task_links` (`decomposes` + `blockedBy`), Linear relation import, readiness
   gating. Trigger: the first multi-part body of work, or re-enabling decomposition.
4. **Failure policy** — B10 in full, plus `maxRuntime` and the breaker. Trigger: the first `faulted`
   run, or the first retry you care about.
5. **Skills platform** — authoring UI, version pinning per run, repo-skill import. Trigger: the second
   repository, or the first skill edit without a migration.
6. **Sync map** — per-column declarative mapping, Jira and GitHub, conflict rules. Trigger: the second
   tracker.
7. **Identity** — real authentication, per-column move permissions, audit views (LOB-20). Trigger: the
   second operator, or the first agent that should not be able to move a card.
8. **Board customization** — edit columns in the UI, more than one board per repository. Trigger: after
   the default has been used for real work.
9. **Decomposition** (LOB-43) into child cards. Trigger: after dependency links and once the specifier
   has proven itself.
10. **Board metrics** — cycle time, aging, WIP over time, cost per task (LOB-17, LOB-28, LOB-44).
    Trigger: once real cards exist to measure.

## What the board is not

No release or production-monitoring agents (D16 — the factory stops at a reviewable PR); no review UI
(GitHub owns merge); no Slack-first intake (D9); no cross-repo cards yet (C6); no vendor memory or
agent framework as a dependency (`features.md` §9/§10). And no auto-approve timers: Jules releases its
plan gate on a clock, which is a gate that exists in the interface and not in the system — any future
timeout here escalates instead of approving.

## Why this shape, in one line each

Hermes supplies the durable task/run split, typed block reasons and the collision rules (never let two
workers self-adjudicate; an orchestrator stamps shared decisions into every child); Mastra supplies
boards/phases as data, per-phase automation, and three separate gates; Linear supplies the typed
`elicitation` and the frozen-activity rule; Devin supplies the typed question and the
"always ask before planning" discipline; Factory and Cursor supply the read-only spec/plan stage;
Warren supplies dispatch-on-approved-plan; Symphony supplies the normative "never stall on input".
Full evidence with quotes: `docs/features.md` §11.
