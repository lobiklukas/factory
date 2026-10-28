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
`describeDefinition` in `packages/core`. The dashboard renders the same `getBoardConfig` answer
read-only at `/boards/<id>/settings` and in each lane header's disclosure, and says when a version
newer than the board's pin exists (`.pi/skills/verify-web/features/board-settings.md`).

Built (D4): a new definition version is authored without a migration — `defineBoard` over RPC and
`factory board define --file def.json [--dry-run]`. It is written as the id's newest version + 1, never
over a row (one transaction under an advisory lock on the id); content identical to the newest version
writes nothing and answers it; a dry run validates only. A version is refused as `InvalidDefinition`,
naming the field, for a duplicate column, no (or a terminal, or an undeclared) initial column, a move to
an undeclared column, a terminal column with exits, a non-terminal one with none, no terminal column, a
terminal column not named `done`/`canceled` or a non-terminal one so named (the workspace release and
the caps' in-flight count still decide "finished" by name), an unknown requires key, `human_move` or
`human_merge` on a column with no gated move (the transition's `gate` is what gates), a skill the skill
library lacks, or — when `ROLE_MODELS` has rows — a role it does not name that is neither one the
harness gives meaning to nor one a held definition declares (`ROLE_MODELS` is a partial override
table, so a typo is what this catches) (`authoredDefinitionFaults` in `packages/core`). An authored
version therefore always declares its own moves and its initial column.

Built (D6): the dashboard authors one too. **Edit as new version** on a board's settings page opens
`/boards/<id>/settings/edit` on the board's pinned version. There an admin adds, removes, reorders and
renames columns, sets kinds and roles, binds skills from `listSkills`, and requires keys and roles from
`getDefinitionVocabulary` (the keys and roles `defineBoard` accepts; pickers only, no free text). They
also edit moves and gates. A diff against the pinned version shows before Save, which calls
`defineBoard`: the page says "v<n> created", shows each `InvalidDefinition` fault next to its field,
and leaves the board on its pin (`.pi/skills/verify-web/features/definition-edit.md`). The draft
carries each column as stored, so a field the editor has no control for is kept.

Built (F5, F7, F8): a definition version records its author (`board_definitions.author`, nullable:
the credential's actor over `defineBoard`, as a skill version's is, and on an open control plane the
caller's own name: `cli` from `factory board define`, `dashboard` from the editor, as their card writes
are; seeded versions and an `unchanged` or dry-run answer have none), shown by `factory board definitions` (`by <actor>`),
`definition show` and the settings page. `factory board vocabulary` prints the requirement keys
(checked, human gate) and roles `getDefinitionVocabulary` answers, and `factory board definition show
<id> [--version N] --json` prints the version as the file `factory board define --file` accepts
(`getDefinitionSource`: a version that declares its moves is emitted as stored, a legacy one with its
moves and initial column spelled out), so editing a version is edit-the-file-and-define.

Built (D5): a board moves to a newer version of its definition — `upgradeBoard`, `factory board
upgrade`, and **Upgrade this board** on the settings page — at the version the caller read it at
(`StaleBoardVersion` otherwise). Only the pin moves: a new card pins the new version, and every card
already on the board keeps the one it pinned, its moves and exits unchanged, so a card's pin still
never changes under work in flight. Cards move only by an explicit migration (`migrateCards`, a column
mapping): each card is re-pinned in the column its own maps to, with a `repinned` event and a new
revision, or — when one has an unfinished run, sits in a column the mapping leaves out, or would land
in a column of another kind — none is and the pin stays (`CardMigrationRefused`, naming every such
card). A migration re-pins, it does not move: a column the new version still declares keeps its
cards, and only one it renamed or dropped may be mapped elsewhere, so no card is carried past an exit
it would have to meet in a move. Only a person upgrades a board; a run's actor is refused. The board page and `factory board ls` say when the cards pin more than one version
(`.pi/skills/verify-board/features/upgrade.md`).

**Seed migrations and authored versions share one id space.** The default pipeline's seeds write
`default` at a fixed version with `ON CONFLICT (id, version) DO NOTHING` (0026 v4, 0038 v5). Since D4
an operator may author `default` v6, and a later seed that writes `default` v6 would then do nothing,
silently. A seed migration of an id that already exists must insert at the id's newest version + 1
(read in the migration), never at a fixed number, and must not assume the newest version is the one
an earlier seed wrote.

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
transient | setup_failed | pr_closed`) plus the column it blocked from, so a blocked card stays visible in its own
lane and there is no "return to where it was" ambiguity. A person parks and frees a card from the card pane or `factory board block` / `unblock`, and fixes its
title or priority with `updateTask` (`factory board update`; C11), a revision-checked write that records
a `retitled` / `priorityChanged` event per changed field. `setup_failed` is written by a run, not a
person: its worktree's declared `install` or `build` failed before its first turn (S-env-setup), and
the note names the step, its exit code and its output's last lines. There is **no `ready` column** in the MVP: nothing
auto-starts, so `ready` only means something once a dispatcher exists (wave 2).

## B5 — Moves are the consequential act, so they are attributed and gated

Every move carries an **actor** and an expected **revision** (a stale drag cannot clobber a newer
state). A run may only make transitions declared for its column, and a move that crosses a
human gate can only be made by a person — recorded as such. `requires[]` is checked on exit, and a
refusal names the failing requirement. In the MVP the two human gates are the plan approval
(`planning → building`) and the merge (`review → done`); Mastra's third gate, acceptance of the task
itself, is the recorded move that starts the first run.

Built (C20): the merge gate reads the merge. `human_merge` is a checked requirement on a move into
`done`: a person's move is refused naming it until a run of the card recorded GitHub's merge of the
card's PR (`factory.merge`, LOB-44) — so a card cannot reach `done` while its PR is open or was closed
unmerged. A card no run opened a PR for has no merge to wait on and meets it (a box with no forge,
work that needed no PR): the actor gate holds that move alone, as before. The merge itself completes the card: a signed `pull_request` closed delivery
(`POST /webhooks/github`) moves the card whose current PR it names — the newest PR a run of the card
recorded — to `done`, from whichever column it is in and without its exit requirements (the work is on
the base already), recorded by the actor `merge:<PR page>`, and its runs' workspaces are released; an
unmerged close blocks it `pr_closed`, the note naming the PR. Both happen once however often GitHub
redelivers (`TaskService.settlePullRequest`, under the card's row lock), and a close blocks the card
once per PR, so a person who unblocks it carries on without the PR-state read blocking it again. A box GitHub cannot deliver to
learns the same by asking: opening the card (`getTaskExit`, the card pane's checklist and `factory board
show`) reads the PR's state (`GET …/pulls/{n}`, each answer kept 30 s, a failure 2 min, and a
read that takes over 5 s given up on) and settles the card the way the
delivery would, and a move into `done` reads it afresh and records a merge it finds, so the person's
move goes through (`packages/core/src/cardPullRequest.ts`).

## B6 — Columns bind roles and skills; skills live in the factory

A column declares `role`, `skills[]`, `requires[]` and its autonomy. A role resolves to model and
tool policy in one place, so changing a model is one edit rather than one per column. Skills are
factory-owned records: markdown plus optional attachments (a driver script is an attachment), seeded
by migration in the MVP and authored in the UI later. They are injected at `openSession` — today the
only model-facing seam, where `CodingTools` is the single installed extension — as prompt sections
alongside the role's tool policy. The stored shape mirrors `.pi/skills/<name>/SKILL.md` so importing
repository skills later is a copy rather than a translation.

Built (LOB-74): the first role → tool-policy row. A column whose role is `specifier` is the read-only
specifying stage (the `specifier` row of `packages/harness/src/rolePolicy.ts`; the planner is the planning stage since D10): `openSession` composes the
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

Built (D7): skills are versioned and edited without a migration. The table is keyed by `(name,
version)` (`0037_version_skills`, which kept every existing row as version 1); `putSkill` adds
version `newest + 1` and never rewrites a row. `listSkills`, `getSkill(name, version?)` and `putSkill`
are the `SkillsRpc` group, and `factory skill ls|show|put --file SKILL.md` drives them (`ls` names the
default definition's columns that bind each skill). The dashboard authors them too (D8): `/skills` lists them,
`/skills/<name>` shows a version's body, the columns that bind it and its history (`listSkillVersions`,
newest first, no bodies), and its Edit form publishes the next version with `putSkill`; the board
settings view links each column's skills there. A run's version is pinned like its model: the open
that first resolves its column's skills records `name@version` in the run's log (`factory.skills`), and
every later open resolves from those pins (`loadRun`'s `pinned`), so a put reaches the next run and a
reopened run keeps the body it opened with. A pinned version the table no longer holds refuses the open
by name and version rather than moving the run onto another body.

Built (S-repo-instructions-and-skills): the repository speaks too, beside the factory's skills rather
than as a copy of them. Every open of a session on a repository reads its `AGENTS.md` and its
`.pi/skills/*/SKILL.md` and `.agents/skills/*/SKILL.md` at the commit the session's base names — not
the worktree's files, which the run's own branch may have changed — and `openSession` installs them
as two capped sections: `repo_instructions` (the file verbatim, ahead of the column's skills) and
`repo_skills` (one line per skill — name, description, path — after them; the run reads a body on
demand with its own tools, and the factory's skills table never holds it). A repo skill whose name the
column binds is left out of the index: the factory's skill is authoritative. What both cost is the
log's `factory.repo.prompt` record. Importing a repository's skill _into_ the factory (wave 2, below)
is still a copy, `factory skill put --file`, and it is still unbuilt as a flow.

**The tool policy** is a filter on what a run is _offered_: a read-only role is not given `write`,
`edit` or `verify` at all (`STAGE_REFUSED_TOOLS`), so a call to one meets Pi Durable's
`tool_unavailable`. LOB-74's hook refusal still judges every `bash` call, and it is the only line for
`write` and `edit` on a root whose tool list still offers them: one pinned before the filter existed (a
run in flight across the deploy that brought it), or one configured since. Since D10 the role policy
table (`packages/harness/src/rolePolicy.ts`, `DEFAULT_ROLE_POLICIES`) is the one table of what a role
may do — `readOnly` (and the stage it names), `writesSpec`, `writesPlan` — replacing the per-feature
`READ_ONLY_ROLES` and `SPEC_ROLES` sets. A deployment extends it with rows for its own roles
(`ROLE_POLICIES=auditor=read-only,architect=read-only+plan`); a row redefining the factory's own
`specifier` or `planner` fails the boot, because the default pipeline's exits are checked against them,
and so does a `spec` or `plan` row without `read-only` (`architect=plan`): a declaration that meets a
checked exit comes only from a run that only reads.
A review run stays read-only because it is a review, not by a row.

Built (LOB-238): the specifier's writer. A run whose role `writesSpec` (since D10 a row of `rolePolicy.ts`; it was `SPEC_ROLES`)
(`packages/harness/src/specify.ts`, `resolveRole().writesSpec`) is offered the `spec` tool, and no
other run is. The tool validates with LOB-72's `decodeSpec`, so a spec with no `gaps` is refused in
words the model reads, and the run retries. It commits the `factory.spec` document to the run's log,
then posts the same spec on the card as a `specified` task event, idempotent by
`<session id>:<tool call id>`. The card's spec is its newest `specified` event, read with
`getTaskSpec`. That is a second record next to the log (D7): the log is the truth for what the run
declared, and the event is the card's copy, written in the same call, so the board reads it without
folding every run's log. The event records the run's own column, the one its role came from, so a
specifier resumed after a person moved the card on still declares its spec from `specifying`. A spec
is not an ask: a gap still parks the card through `ask`; the `spec_doc` exit requirement is met by
the event's existence (D9, below).

Built (D10): the planner. `planning` is a read-only stage like `specifying`: the `planner` row says
`readOnly` (stage `planning`) and `writesPlan`, so its runs are offered no `write`, `edit` or `verify`,
their `bash` may only read, and they are offered the `plan` tool (`packages/harness/src/planning.ts`).
The tool validates a typed plan — `summary`, `steps` and `surfaces` (at least one each), `risks`
(required, `[]` when there are none) — commits `factory.plan` to the run's log and posts it on the
card as a `planned` task event, idempotent by `<session id>:<tool call id>`, as the spec's is. The card's
plan is its newest `planned` event (`getTaskPlan`, `factory board show`, the card pane's Plan section):
what the person crossing the plan approval gate reads. The run does not move the card on.
`0044_seed_plan_skill.ts` binds the seeded `plan` skill to `planning` on a new version of `default`:
the id's newest version + 1, read under `defineBoard`'s advisory lock (v6 over the seeded v5; over an
operator's authored `default`, that version with the skill added), per the seed rule above. Earlier
versions keep a planning column with no skill, and their planners are still read-only and offered the
tool, because both follow the role.

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

Built (C22): **a column's autonomy**. `BoardColumn.autonomy` declares what a column's runs may do
without asking: `approvalRequired[]` (command prefixes, `APPROVAL_REQUIRED`'s shape), `write`
(`worktree`, `docs`, `none`) and `push` (`branch`, `none`). It narrows the deployment's policy and
never widens it (D11 makes widening the deployment's act, and a definition row is not the
deployment): a column's gates are added to the deployment's, `push: none` leaves no ref the run may
push itself (the PR step's push, C17, is the control plane's and still runs), `write: docs` is the
docs rule a `docs` skill already brings, and `write: none` is a read-only stage named after the
column, its tools withheld as a read-only role's are. A scope wider than what the column's role or
skills make it reads as the narrower one, so a specifier column that says `worktree` still writes
nothing. The merge is `withColumnAutonomy` and `columnWriteScope` (`packages/harness/src/policy.ts`):
the gates and push scope are applied when a run's column resolves (`runColumnFor`, then
`Policy.forWorktree(…, run.autonomy)` in `SessionService`'s acquisition), and `openSession` picks the
write rule from `columnWriteScope` — so a run in a column that gates `git push` parks on an approval
while the same call in a column that does not runs. A run starts in the column its start names, else
the card's own column; a name the card's pinned definition does not declare is refused
(`invalid_input`) rather than run under no column's autonomy. `getDefinition` describes every
column's **effective** autonomy with the same functions (`ColumnConfig.autonomy`: each gate with whose
it is, and both scopes), which the settings view, the lane disclosures and `factory board definition
show` print. An absent `autonomy` — every version written before the field — is the deployment's
policy unchanged.

Built (S-factory-config-as-code): **a repository's policy**, between the deployment's and the
column's. A repo's `.factory/config` may carry a `policy` block — `approvalRequired[]` (gates added
to `APPROVAL_REQUIRED`), `deny[]` (command prefixes refused outright, read the way a gate is) and
`allowedHosts[]` (the session's egress allowlist narrowed to these, each one the deployment allows).
It is read at the session's base ref in the registered checkout or the factory's mirror
(`packages/core/src/repoPolicy.ts`, `git cat-file`), never from the worktree, and pinned in the log
by the first open (`factory.policy`, which also records the effective rules the run met), so an
agent that edits `.factory/config` on its branch — or a base that moves under a running session —
changes nothing for that run; the next session reads the base again. The order is deployment, then
repository (`withRepoPolicy`), then column (`withColumnAutonomy`), each tighten-only. A block that
tries to allow something the deployment denies (a host off its allowlist), has a key the policy does
not know, or a config that is not JSON, is refused at load (`RepoPolicyRejected`), and the session
does not open (`policy_rejected`) and leaves no worktree behind; a base git could not read (failed or
timed out) is never read as no policy, and refuses the open as transient (`policy_unreadable`). A
review run is read at its pull request's base, fetched from the forge first, not at the head under
review. For a repo with no remote, the base is the checkout's
local branch, whose refs every session worktree shares, so it holds only as long as no run writes
that ref (`.pi/skills/verify-api/features/repo-policy.md`). Per-repo `roles` model overrides and
trigger rules in the same file are not built.

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

Built (C24): an answer offers the run that reads it. After an answer lifts a `needs_input` block the
card pane offers **Start the next run** (the column the question was asked in, the card's default
prompt), and `factory board comment --start` does the same from the CLI. The offer is spent by the
first run that starts on the card afterwards, however it was started, and `--start` is refused before
anything is written on a card that is not blocked `needs_input` or when `--actor` is a run (its
comment would be a note); a comment that lands but leaves the card blocked fails with
`start_not_started`.

Built (T5): for a card filed from a Linear issue, the same ask also posts the question to Linear as
one `elicitation` activity (`AskWriteBack`, `LinearAskWriteBack`; deduped by the ask id in
`linear_elicitations`), and the person's reply in that agent session arrives as an
`AgentSessionEvent` `prompted` webhook, which the trigger seam records as the card's `answer`
comment — the event's own text, never a re-read comment — lifting the block.

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
and the card must have a PR from that branch (`factory.pr`, LOB-177: the latest run's, or since C19 an
earlier run's whose head is the branch the latest run continues, while that branch is still at the
commit the PR was published at) — so a card cannot leave `building` with no change, no PR, or commits
its PR lacks. Only keys with a recorded artifact are checked (`packages/core/src/requirements.ts`
lists why the others are not yet); the logs are read, and the branch measured, before the card is
locked, at the revision the move expected.

Built (D9): `spec_doc` and `run_completed` are checked too. `spec_doc` (`specifying`) is met when the
card holds a `specified` event — a specifying run's `spec` tool wrote one (LOB-238) — whatever its gaps,
which stay the ask's to raise. `run_completed` (`building`, first among its keys) reads the card's
_newest run started in the column being left_ (a planner's run is not the builder's), and is met when
that run's newest turn ended on its own (`runTurnOf`): a run still working or parked, one ending on a
failed or aborted model answer or one cut off at the output limit, one interrupted (C8) or one its
budget stopped has not completed, and a card with no run started there has completed nothing. Since
D10 `plan_doc` (`planning`) is checked the same way as `spec_doc`, by a `planned` event: `planning →
building` with no plan is refused naming it. The `human_move` label stays unchecked (`human_merge` is checked since C20, above). The same verdicts feed `getTaskExit`,
which the card pane reads to list "Leaves <column> when" — each key `met`, `unmet` with the refusal's
own reason, or `not checked` — and to say, before a click, why a move would be refused; the move stays
clickable, because the server's answer is the decision. `factory board show` prints the same list
(`leaves <column> when`). The pane re-reads it every ten seconds, not the board's two, because each
read folds the runs' logs and measures the branch.

Built (C18): a run whose column requires `pr_link` opens its PR itself. When this process sees the run
settle (its session goes idle), the control plane runs the same PR step `factory pr` and the
dashboard's Open pull request call — measured, capped, pushed with the provider's token and recorded
as `factory.pr` — with no operator call (`packages/core/src/prOnSettle.ts`). A session a trigger opened
with no card (`trigger:<source>`: Linear, Jira, GitHub, Slack, Sentry, the generic webhook, docs) does
the same. Every other run's PR stays a person's call: a card's run in a column that requires no PR
(the specifier, the reviewer), a person's own session, a fork or a replay (a trigger's session is
read from the delivery it was created for, which a replay does not carry), and a working directory
that is not its own checkout. Only a run that finished opens its PR: one parked on a person (an
undecided approval, a blocked card) holds it until a later run settles done, which the process's log
records as `parked`; one interrupted by an operator, stopped by its budget, or whose model answer
failed opens none and says so. A settled run whose step opened nothing — stopped, no change, a
diff over the cap, a remote branch the push may not overwrite, a failure — says so in its transcript
(no-change's line, or `factory.pr.not-opened`) and as a note by the run on its card, which the card's
next run is told; a later settle at the same commit an even branch was found at is not stepped again.
The PR opens at the first settle that finds a change: commits a later run of the same session makes
are not pushed by a later settle yet (the step answers `already-open` without pushing), a follow-up.

Built (C19): a card's runs share one branch and one PR (`packages/core/src/cardBranch.ts`). The card's
branch is its first change run's — a run started in a column that requires `pr_link` or
`non_empty_diff` — for as long as an unreleased run of the card is bound to it; a run of an earlier
column (a specifier, a planner) keeps a branch of its own. Every later run of the card is bound to the
card's branch by name (LOB-197), on the base it was cut from, so a second building run and a run in
`review` start from the change the first building run made; a run that names its own branch, or a
base other than that one, starts afresh as before. Git checks a branch out in one worktree
at a time, so the newest run's worktree takes it over and the earlier run's is left on a detached
HEAD at the commit it was on, its files and uncommitted edits untouched. So that nothing commits on
that detached HEAD, a start is refused (`busy`, naming the run) while a run on the card's branch is
still busy in this process, and a message to a run whose worktree was handed over is refused, naming
the later run that took the branch. A run of any column that continues the branch while the card has
an unmerged PR from it takes the PR step on settle (a fix run in `review` included), so its commits
reach the PR. A later run's PR step, finding no PR in its own log, adopts the PR an earlier run of
the card recorded on the same head and base (unmerged): it is measured, capped and pushed as an open
is — so its commits reach the PR — but GitHub is asked for nothing, the card's PR is recorded in its
log, and the answer is `already-open`. A workspace release keeps a branch another unreleased session
is bound to, so discarding one run never deletes the branch the others work on.

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

Built (LOB-71): the caps are definition data, enforced where a run starts. A version's `caps`
(`board`, `task`, `repo`; `board_definitions.caps`, migration 0038) and a column's `wipLimit` (in
`columns`) are read from the version the card **pins**, so a new version with other caps moves the
threshold for its cards only; default version 5 carries 2/1/2 and no WIP limit, and versions 1–4 cap
nothing. `SessionService.create` with a card checks them in the transaction that writes the run's
session and `task_runs` rows, under an advisory lock on the card's repository, and refuses a start
past one as LOB-70's `at_capacity` with the cap typed (`SessionError.cap`: kind, limit, the
definition field it is configured in, and the board, task, repository or column it counted) and the
runs holding it named — narrowest first (task, column, board, repository). A refused start writes no
row and opens no session. A run is in flight from its start until its session first goes idle
(`task_runs.finished_at`), unless its card reaches `done`/`canceled` or its workspace is released
first; a run opened with no prompt is in flight while it waits, and a person frees it by sending it its
message, discarding its session (`factory discard`), or finishing its card — the refusal names all
three. `finished_at` is written where this process sees the session go idle, so the paths that see no
such turn end the run themselves: a start whose owner or first log writes fail after its rows were
committed (a URL-only repo's fetch, LOB-265), a run a dead process left marked but already settled
(`resumeRuns`), and a `task_runs` row `rebuildIndexes` re-creates, which ends at its session's last
activity — a rebuild frees slots rather than holding them, except for a run whose `run_session_root`
it kept, which the boot resumes. A run left by a process that never boots again holds its slot until
someone sends to its session or discards it. The repo cap counts every board over the repository (`createBoard`
still makes one per repository, so today it binds only once board customization makes more). A
review run (LOB-36) is the PR's, not a person's: it counts, but no cap refuses it, because a refused
delivery would lose the review the merge gate needs. No dispatcher, lease or auto-start comes with it —
wave-2 item 1 still owns those, and will claim under these caps.

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
the first cut, the dispatcher, leases, claims, caps enforcement (since built ahead of the dispatcher, on
a person's start — B9, LOB-71), breakers, attempt budgets, priority
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

1. **Dispatcher and claims** — auto-start per column, LOB-18's leases, claiming under the caps/WIP
   limits (enforced on every start since LOB-71), TTL reclaim, priority
   bands, trusted-actor and created-after-enable rules (built for trigger intake, S-trigger-trust-gating:
   a rule's `trust` gate — an author allowlist, a GitHub role, created after the rule was enabled — so
   the dispatcher reuses it rather than inventing its own). Trigger: the first run you want started
   without you. Milestone **S** is satisfiable without it; this is what makes S self-driving.
2. **Questions as durable objects** — dedup by question id, aging, resume after death, wake policy.
   Trigger: the first question asked while you are not watching. Linear's `elicitation` supplies the
   outward half, so this is smaller than it looks.
3. **Dependency links** — `task_links` (`decomposes` + `blockedBy`), Linear relation import, readiness
   gating. Trigger: the first multi-part body of work, or re-enabling decomposition.
4. **Failure policy** — B10 in full, plus `maxRuntime` and the breaker. Trigger: the first `faulted`
   run, or the first retry you care about.
5. **Skills platform** — authoring UI and repo-skill import (version pinning per run and editing
   without a migration are built, D7; a repository's own skills are listed into every run, B6).
   Trigger: the second repository.
6. **Sync map** — per-column declarative mapping, Jira and GitHub, conflict rules. Trigger: the second
   tracker.
7. **Identity** — real authentication, per-column move permissions, audit views (LOB-20). Trigger: the
   second operator, or the first agent that should not be able to move a card. Built: the
   authentication (LOB-20) — every RPC needs a bearer token when the deployment configures one, and a
   board write records the token's actor, never the body's, so no client can move a card as a run or
   as someone else (docs/design.md, R4's _As built (LOB-20)_). Still not built: per-column move
   permissions and audit views.
8. **Board customization** — edit columns in the UI, more than one board per repository. Trigger: after
   the default has been used for real work. Built: editing a definition as a new version in the
   dashboard (D6). Still not built: moving a board to a newer version, and more than one board per
   repository.
9. **Decomposition** (LOB-43) into child cards. Trigger: after dependency links and once the specifier
   has proven itself. Built: the proposing half (LOB-201) — `proposeDecomposition` reads a
   session's spec and commits proposed child issues (`factory.proposedIssues`, read back through
   `getSession`); it creates no card, no tracker issue and no session — and the approving half
   (LOB-202) — `approveProposals` creates the approved ones as Linear issues, children of the issue
   the session was delegated from, in its team, with the `blockedBy` edges whose ends exist, and
   records each created id in the document — and idempotent re-runs (LOB-203): a decomposition is
   reconciled into the set the session holds by normalized title, so the same spec twice is the
   same proposals and creates nothing the second time, a changed spec answers a diff (added,
   updated, unchanged, removed), and a dropped proposal is marked `removed` with its tracker id
   rather than deleted. Plan freshness (LOB-45): with `PLAN_FRESHNESS=merged`, a merged factory PR
   re-reads the plan — the spec of record against the delegating issue's children — in one bounded,
   read-only call, and files proposals to add, re-scope or close as a revision on the spec's session
   (`factory.planRevisions`); a person declines it or approves it through the same tracker port, and
   nothing is auto-approved. Still not built: child cards and `task_links` (wave 2).
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
