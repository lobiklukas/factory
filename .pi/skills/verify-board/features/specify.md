# Specify, ask, answer — on the drive's card

**Status: passing** (LOB-85, part 2 of LOB-49; the spec, LOB-238).

## What it is

Milestone B's path on one card: the card a trigger created is moved into `specifying`, the run there
asks, the run **parks**, a person answers on the task, and the next run is told the answer. It is
B7's question path ([ask.md](ask.md)) on the card `./drive.sh` carries through the whole board,
rather than on a card of its own, so the card that reaches `planning` (and LOB-86's build and review
after it) is one that was specified and answered.

The column is the specifying stage: `specifying` declares the `specifier` role, so its runs are
read-only (LOB-74; since D10 the `specifier` row of the role policy table in
`packages/harness/src/rolePolicy.ts`). The drive asserts two
separate facts about that. The run's column, as its `task_runs` row names it, declares a role that
`readOnlyStageOf` resolves to the `specifying` stage — so a pipeline whose column stopped declaring
`specifier` fails the drive. And the asking run's turn, a `bash` read (the sleep that makes it busy),
was not refused: a stage that blocked the specifier's reads would also be the reason a run could never
get as far as asking. Neither shows the stage _refusing_ anything; see below.

Before it asks, the run **declares the card's spec** (LOB-238): the typed `factory.spec` document
LOB-72 defined — goal, acceptance, `gaps`, open questions — written with the `spec` tool, which only a
run whose column declares the `specifier` role is offered (its `writesSpec` row in
`packages/harness/src/rolePolicy.ts`). The tool changes the run's log and the card, never the workspace,
so the read-only stage lets it through. A spec without `gaps` is refused with LOB-72's sentence
naming the field, and the run retries; the accepted spec is committed to the run's log and recorded
on the card as a `specified` event, which `getTaskSpec`, `factory board show` and the card pane's
Spec section read. A spec with gaps still parks the run through the ask.

## How a user reaches it

```sh
factory board move --task tsk_… --to specifying --expect-revision 1
factory board start --task tsk_… --prompt "specify this card"   # the run asks, and ends
factory board show --task tsk_…                                 # the spec (gaps: 1), blocked needs_input, the question
factory board comment --task tsk_… --expect-revision 4 --body "Postgres 16. …" --actor person:…
factory board show --task tsk_…                                 # blocked -, the answer under the question
factory board start --task tsk_… --prompt "go on"               # the next run is told the thread, re-specs
factory board show --task tsk_…                                 # the next run's spec: gaps: none
factory board move --task tsk_… --to planning --expect-revision 6
```

## How the skill drives it

`./up.sh` starts its API with the script this phase needs: `FAUX_COMMAND="sleep 8; echo faux-ok"`
(the sleeping command `verify-api`'s `sigterm.sh` and `ask.sh` hold a turn open with, at twice
`ask.sh`'s 4 s because the busy probe here starts after `board start` returns, a tmux round-trip and
a cold `bun`; fixed, so an exported `FAUX_COMMAND` cannot change it) and
`FAUX_ASK=<question>`, which it records in `.verify/run/faux-ask`. The faux model asks only when the
run was offered `ask` and its prompt has no `task_thread` yet, so every later run on the answered card
takes an ordinary turn.

`./up.sh` also sets `FAUX_SPEC` (LOB-238, fixed): a first `spec` attempt without `gaps`, then the
complete spec, recorded in `.verify/run/faux-spec`. The faux specs only when it was offered the tool,
tries the attempts in order until one is accepted, and — on a run whose prompt carries the answered
thread — declares the last one with `gaps` and `openQuestions` empty, once.

`./drive.sh`, between `board start` and the person's move to `planning`, every command typed into the
private tmux pane:

1. `board start --prompt 'specify this card'` — exit 0, a `ses_…`, `task … in specifying`, and the
   `sent` line.
2. `ask.ts MODE=busy` (EVIDENCE_PREFIX=specify) sees the run **busy** while the sleep holds its turn:
   the control without which "not busy after the ask" could not fail.
3. `ask.ts MODE=parked`: the card is blocked; within 5 s of the block the run is **not busy**, no tool
   runs and nothing is queued; the run's column resolves to the read-only `specifying` stage (role
   `specifier`); its `bash` read was not refused; the transcript ends on the ask's result; the thread
   holds one `question` by that run, verbatim.
4. `spec.ts MODE=declared` (LOB-238): the run was offered `spec` (its log's offered tools); its first
   `spec` result is the refusal "spec refused: `gaps` is missing — declare the gaps, `[]` when there
   are none" and its second was accepted; the run's log (a reader-mode `readSessionLog`) and the
   card's `getTaskSpec` both hold the accepted spec, by this run, from `specifying`.
5. `board show` — `spec      <ses_…> from specifying (revision 2)`, `gaps: 1` and the gap under it;
   `blocked   needs_input from specifying since …`, and the question under
   `[question] <ses_…> (revision 3)` — a revision later than without the spec, which is one event.
6. `board comment --body $'Postgres 16.\n  Keep port 5442 \xe2\x80\x94 it is shared.'` at the revision
   `show` printed — `answered: … is no longer blocked (needs_input from specifying)`.
7. `board show` — `blocked   -`, `thread    2`, the answer by `person:verify-board` with its second
   line and its em dash intact.
8. `board start --prompt 'go on'` — a second `ses_…`, different from the first.
9. `ask.ts MODE=told` reads that run's log through a reader-mode `PostgresStorage`: its committed
   `task_thread` section contains the answer verbatim (newline and em dash included), after the
   question, and the run — holding the answer — did not ask again.

10. `spec.ts MODE=closed`: the next run's one `spec` call was accepted, and its log and the card hold
    the spec with `gaps: []` and `openQuestions: []`, by the next run.
11. `board show` — `spec      <next ses_…> from specifying (revision <step 7's>)`, `gaps: none`, and
    the card one revision past step 7's.
12. `spec-pane.mjs` (headless Chrome): the card pane's Spec section names the next run, and its goal,
    acceptance items and revision are `getTaskSpec`'s; its gaps list is empty and says "None: the
    spec declares no gaps." rather than vanishing.

The move to `planning` then expects the revision step 11 printed, so a block, an answer or a spec
that wrote an unexpected revision fails the move rather than passing unnoticed.

## Evidence

`.verify/evidence/latest/board/`: `start.txt`, `show-asked.txt`, `comment.txt`, `show-answered.txt`,
`start-next.txt`, `show-specified.txt` (raw panes); `specify-busy.json`, `specify-parked.json`,
`specify-told.json` (each probe's checks and facts, the recorded thread section among them);
`spec-declared.json`, `spec-closed.json` (each run's `spec` results, its logged spec, the card's);
`spec-pane.json`, `spec-pane.png` (the Spec section as rendered); the drive's checks in
`observed.json`, with both session ids.

Mutations observed on 2026-10-27, each a non-zero `./drive.sh`:

- the `ask` tool's result without `terminate` (the run replies after asking): "the run ended on its
  ask" and "after the ask the run is parked" fail;
- the thread section rendered without answers: all three `told` checks fail;
- `sleep` dropped from the stage's read allowlist: the busy control, "the run's read was not
  refused" and the parked check fail;
- the `spec` tool's `gaps` parameter made required in its TypeBox schema (LOB-238), so pi-ai's
  argument validation, not LOB-72's validator, refuses the first attempt: "a spec missing gaps was
  refused, naming the field" and the spec probe fail;
- `READ_ONLY_ROLES` keyed by a role `specifying` does not declare (the stage no longer applies, and
  the read still runs): "the run's column is the read-only specifying stage" and the parked check
  fail, while "the run's read was not refused" still passes — which is why the two are separate.

## What it does not prove

- **A restart between the ask and the answer.** `drive.sh` runs against `./up.sh`'s shared instance and
  does not kill it; `./ask.sh` owns its API and proves the question and the block survive SIGTERM
  ([ask.md](ask.md)).
- **That no other role is offered `spec`.** The drive starts runs only in `specifying`; that a
  planner, a builder or a scratch session is never offered the tool is `packages/harness`'s
  `specify.test.ts` and `packages/core`'s `SessionService.test.ts` ("offers no spec tool to a run
  outside the specifying role"). The validator and its durability are `.pi/skills/verify-api`'s
  `spec.sh`.
- **A spec posted after the card moved on.** The tool follows the run's pinned role, so a specifier
  resumed after a person moved the card to `planning` can still post; the spec then records the
  run's column, `specifying`, not the card's. That is `packages/core`'s `SessionService.test.ts`
  ("records the run's own column when a person moved the card on …"); the drive does not move a card
  under a live run.
- **`spec_doc` as an exit requirement.** `specifying` declares `spec_doc` in `requires[]`, and it is
  checked since D9 (`packages/core/src/requirements.ts`): the move to `planning` is refused with no
  `specified` event on the card. This drive's run declares one before the move, so it passes; the
  refusal and the pass are [requires.md](requires.md)'s, and the checklist in the pane is
  [verify-web's exit-checklist.md](../../verify-web/features/exit-checklist.md). A spec's content
  (open gaps) is not what the key checks.
- **The stage's refusals, or that the session applied it.** The drive shows the run's column
  resolving to the stage and a read getting through, which a session opened without the stage would
  also do. That `openSession` composes the stage and it refuses writes is `packages/core`'s
  `SessionService.test.ts` ("refuses a specifying run's write …") and `.pi/skills/verify-policy`'s
  `stage` case.
- **The thread in the dashboard.** This drive answers through `factory board comment`, and its web
  phase reads the card after it has left `specifying`. Answering in the card pane's thread (LOB-239)
  is `.pi/skills/verify-web/thread.sh`'s ([thread.md](../../verify-web/features/thread.md)).
- What a real model asks, or when: `MODEL_BACKEND=faux` scripts it.
