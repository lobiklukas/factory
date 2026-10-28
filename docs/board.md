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

Built (LOB-260): a card carries a markdown **body**, a **base ref** and an **external ref** (the tracker
issue it was filed from), set by `createTask` and written into its `created` event as well as its row,
so `TaskService.replay` folds the card back out of `task_events` alone (`projectTask`). Every run on
the card is told the body verbatim as its `task_body` prompt section, beside `task_thread` — an empty
body is no section — and a run that names no base of its own cuts its worktree from the card's base
ref rather than the repository's default. A base ref that is not a plain git ref, or a body or ref
over its cap, is refused at create as `InvalidTaskInput`. `factory board show` prints all three.

## B2 — The board is definitions plus instances, in the factory's own database

A board **definition** declares columns and their policies; a board **instance** is bound to one
repository and references a definition version. Every task pins the definition version it started
under, so editing a definition cannot mutate work in flight. Definitions live in the factory database
(not in the repository, not in the tracker), and one default definition ships in a migration.

Built (LOB-270): definitions and a board's configuration are readable over RPC (`listDefinitions`,
`getDefinition`, `getBoardConfig`) and the CLI (`factory board definitions | definition show | list |
config`). Each column is described with its declared exits and human gates (what `TaskService`
refuses by), each requirement marked checked or unchecked (`CHECKED_REQUIREMENTS`), and
its role's model as the deployment's `ROLE_MODELS` resolves it (B6) — read-only, joined by
`describeDefinition` in `packages/core`.

Built (LOB-267): transitions, human gates and the initial column are definition data. A column
declares `transitions: [{ to, gate? }]` and a definition its `initialColumn`
(`board_definitions.initial_column`); `TaskService.move`, `create`, the attention view's gate rows and
the card pane all read the card's pinned version. Default version 4 (`0026_seed_definition_transitions`)
carries exactly the old code table; versions 1–3, which declare no transitions, still resolve through
that table (`columnTransitions` in `@repo/domain/Task`) and start a card in their first column.

## B3 — Cards are rows, not a log

`tasks` + append-only `task_events`, one transaction per mutation, `revision` on the task for
optimistic concurrency. A board-scope log under `commits` is _possible_ — `log_id` is free-form text
and `rebuild.ts` deliberately skips ids that are not `ses_…` — but a log is a single-writer resource
requiring owner routing, and a card is **input**: a person typed it, and there is no log to replay it
from. D7's "droppable projection" reasoning covers derived tables, not inputs; `sessions` is the
precedent ("an index, not a projection").

## B4 — The default pipeline

| Column       | Kind     | Role        | Exit requires                                                                                                              |
| ------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `intake`     | resting  | —           | a person moves it on (nothing auto-starts; the card may be nearly empty)                                                   |
| `specifying` | working  | `specifier` | a `spec` doc, gaps declared (explicitly `[]` when there are none)                                                          |
| `planning`   | working  | `planner`   | a plan doc **and a human move**                                                                                            |
| `building`   | working  | `builder`   | a run that completed, a non-empty diff, and a PR link                                                                      |
| `review`     | working  | `reviewer`  | a passing verification of the change (`verified`, from v3; B8), a review verdict, and a human merge (the move into `done`) |
| `done`       | terminal | —           | —                                                                                                                          |
| `canceled`   | terminal | —           | —                                                                                                                          |

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

Built (LOB-74): the first role → tool-policy row. A column whose role is `specifier` is the read-only
specifying stage (`READ_ONLY_ROLES` in `packages/harness/src/policy.ts`): `openSession` composes the
rule into the session's `ToolTask` hook from the run's column and role, and `write`, `edit` and
`verify` are refused, as is any `bash` command that is not on an allowlist of read commands (a read
command with a writing flag, `sed -i` or `find -delete`, included), with a reason naming the stage
and the column. The allowlist reads the command's text, so it stops the accident rather than a
determined agent (D15). Keyed by role rather than by skill or column name, so a renamed column keeps the rule and an
edited skill body cannot drop it.

Built (LOB-207): the role resolves to both halves in one function, `resolveRole` in
`packages/harness/src/loader.ts`, and `openSession` takes the run's model, its withheld tools and its
read-only stage from that one answer. **The model** is the deployment's role table, `ROLE_MODELS`
(`specifier=anthropic/claude-haiku-4-5,reviewer=…`), resolved against the process's model catalog at
boot: a malformed row or a model the process cannot serve fails the boot, and a role with no row (or
a session with no card) runs the deployment's model. It is deployment config rather than a column of
the board definition because a model id is a fact about a deployment and a board is not. The model is
pinned into the run's root conversation when its session first opens, so an edit reaches the next run:
a reopened run keeps talking to the model its root was created with, and its compaction thresholds
follow that model's window, not today's row. One gap is the faux backend's: its catalog is only
`faux-1` and the `faux/*` ids the current `ROLE_MODELS` names, so dropping a row while a run is open on
it leaves that run with no model to send to after a restart (a real backend's catalog holds every model,
so it is not affected). Under faux, keep a row until the runs on it are done.
A run can also be started on a model of its own (LOB-274): `createSession`'s `model`
(`factory run --model`, the dashboard's New session picker) is resolved against the same catalog —
an unserved one is `invalid_input` before anything is written — and pinned ahead of the role's row.
The deployment's model is `DEFAULT_MODEL` when it is set (validated at boot, like a row), else the
backend's own. So a run's model is: its session's > its column role's row > `DEFAULT_MODEL` > the
backend's, decided once, when its root is created.
**The tool policy** is a filter on what a run is _offered_: a read-only role is not given `write`,
`edit` or `verify` at all (`STAGE_REFUSED_TOOLS`), so a call to one meets Pi Durable's
`tool_unavailable`. LOB-74's hook refusal still judges every `bash` call, and it is the only line for
`write` and `edit` on a root whose tool list still offers them: one pinned before the filter existed (a
run in flight across the deploy that brought it), or one configured since. `READ_ONLY_ROLES` stays
the one table of which roles read only.

Built (LOB-238): the specifier's writer. A run whose role is in `SPEC_ROLES`
(`packages/harness/src/specify.ts`, `resolveRole().writesSpec`) is offered the `spec` tool, and no
other run is. The tool validates with LOB-72's `decodeSpec`, so a spec with no `gaps` is refused in
words the model reads, and the run retries. It commits the `factory.spec` document to the run's log,
then posts the same spec on the card as a `specified` task event, idempotent by
`<session id>:<tool call id>`. The card's spec is its newest `specified` event, read with
`getTaskSpec`. That is a second record next to the log (D7): the log is the truth for what the run
declared, and the event is the card's copy, written in the same call, so the board reads it without
folding every run's log. The event records the run's own column, the one its role came from, so a
specifier resumed after a person moved the card on still declares its spec from `specifying`. A spec
is not an ask: a gap still parks the card through `ask`, and the `spec_doc` exit requirement is
still not checked.

Built (LOB-36): the reviewer. A **review run** — a session opened for one pull request's head, which
its log records as `factory.review`'s target — is the read-only `reviewing` stage whatever its
column (`REVIEWING_STAGE`, `RunProfile.reviewing`), and it is the one run offered the `review` tool
(`packages/harness/src/review.ts`, `resolveRole().writesReview`): a verdict and findings for each of
correctness, security, tests and performance, checked against the P0/P1/P2 rubric (a dimension fails
exactly when it holds a P0 or P1) and against the files the PR changes, committed as
`factory.review`, then posted as one `COMMENT` review — nothing when there is no finding. Its model
is its column's role's (`ROLE_MODELS`' `reviewer` row). Keyed by the run being a review rather than
by the `reviewer` role, because a person may still start a run in `review` that changes and
verifies (a fix-up, B8) — that run is not a review and is not limited.
The run is started by the PR, not by a person: a `pull_request` (`opened`, `reopened`,
`ready_for_review`, `synchronize`) on a PR a run of the card opened starts one run in the card's
reviewer column, cut at the PR's head, one per head (`packages/core/src/ReviewTrigger.ts`). It posts
as the reviewer's own GitHub identity, never the worker's (`GITHUB_REVIEWER_TOKEN` or
`GITHUB_REVIEWER_APP_*`, `packages/core/src/GitHubReview.ts`), and a post whose PR moved past the
reviewed head is `stale` and posts nothing. A head the registered checkout lacks (a person's push,
GitHub's "Update branch") is fetched first with the worker's read credential, and one that still
cannot be had is `skipped`, naming the commit. A review run is not one of the card's runs as the
exit checks read them: it starts while the card is still in `building`, and `pr_link` and
`non_empty_diff` judge the latest run that makes the change. The review is not trusted until it is
measured on our own PRs (LOB-242).

Built (LOB-241): the verdict is the gate. `review_verdict`, which `review` declares in every version
of the default pipeline, is checked on exit (`packages/core/src/requirements.ts`): `review → done`
goes through only when the review of the **card's PR** — the newest PR a run of its change recorded —
at the **head that PR was last reported at** recorded `pass`. The head is not "the newest review
run": the review trigger opens one run per head, so a push back to a head the PR had before (a
force-push undoing one) replays that head's old run, and another head's run stays the newest. Every
review delivery on a card's PR, a replay included, records its head in `review_heads` before its run
is opened (`ReviewTrigger.recordReviewHead`), and that row picks the run (migration 0030). No review
run ("no review ran"), only another PR's review, a reported head with no review run yet (still being
opened, or skipped as unfetchable), a run with no verdict yet (naming the head under review), a
`fail` (naming the failing dimensions) and a pass its post found `stale` are each refused naming the
requirement, so an older head's approval never survives a push at the gate. What it cannot see is a
push the trigger has not been told of yet: until its `synchronize` arrives, the reported head is the
previous one. The verdict is read from the run's log (`factory.review`, D7), not from GitHub, so an
unposted or withheld verdict counts the same as a posted one.

**Operational requirement.** A review run is opened only by a signed `pull_request` delivery to
`POST /webhooks/github` (`GITHUB_WEBHOOK_SECRET` set, and GitHub able to reach the control plane — a
tunnel for a local run). A deployment without inbound webhooks has no review runs, so none of its
cards can move from `review` to `done`; they can only be canceled. The API warns at boot when the
secret is unset, and the refusal says where review runs come from. A person's or the CLI's way to
request a review of the PR's current head is a follow-up on LOB-241, not built.

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

Built (LOB-73): the thread is `task_events` itself — a comment is a `commented` event with a kind
(`question | answer | note`), so the ask (comment + block) and the answer (comment + unblock) are each
one transaction over one table, and B3's "cards are rows" holds for the thread too. The run asks with
the harness's `ask` tool, which ends the run (`control: { terminate: true }`); every run opened on the
card carries the thread as its `task_thread` prompt section.

## B8 — Evidence gates, not evidence prose

`requires[]` is machine-checked on exit, which promotes verification-as-evidence (LOB-16) from a body
artifact a reviewer may skip into a condition of the move. A skill's output is what a gate checks, so
the verify-skill convention becomes mechanism.

Built (LOB-80): `TaskService.move` checks the leaving column's `requires[]` under the card's pinned
definition version, after the declared transition and the human gate, and refuses with
`RequirementUnmet` naming the key. The default pipeline's `review` declares `verified` from version 3:
the card's newest `verify` call over a change (across all its runs) must have passed for every surface
that change touched — a passing verification of another surface does not count. "Newest" is by when
the call was recorded, so a resumed older run's later call counts; a newest call that left no record
(blocked or crashed) refuses the move rather than falling back to an older pass. A move into
`canceled` is never gated. Since LOB-240 `building`'s `non_empty_diff` and `pr_link` are checked too,
on every version (all of them declare both): the card's latest run's branch must change at least one
file against its base, measured as the PR step measures it (`git diff --numstat base...head`, LOB-196),
and that run's log must record a PR (`factory.pr`, LOB-177) — so a card cannot leave `building` with no
change or no PR. Only keys with a recorded artifact are checked (`packages/core/src/requirements.ts`
lists why the others are not yet); the logs are read, and the branch measured, before the card is
locked, at the revision the move expected.

A board that gates on `verified` needs every surface its changes touch to be verifiable: the repo
declares its verify command (`commands.verify` in `.factory/config`, which covers every surface), or
carries a `verify-<surface>` skill for each one. A surface with neither — or a path outside every
package, with no declared command — records no evidence, which never passes, so such a card can only
leave `review` for `canceled`; the refusal names that remedy. "Nothing could check it" is not a pass.

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
   has proven itself. Built: the proposing half (LOB-201) — `proposeDecomposition` reads a
   session's spec and commits proposed child issues (`factory.proposedIssues`, read back through
   `getSession`); it creates no card, no tracker issue and no session — and the approving half
   (LOB-202) — `approveProposals` creates the approved ones as Linear issues, children of the issue
   the session was delegated from, in its team, with the `blockedBy` edges whose ends exist, and
   records each created id in the document. Still not built: child cards and `task_links` (wave 2)
   and idempotent re-runs of the same spec (LOB-203).
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
