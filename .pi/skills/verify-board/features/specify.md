# Specify, ask, answer — on the drive's card

**Status: passing** (LOB-85, part 2 of LOB-49).

## What it is

Milestone B's path on one card: the card a trigger created is moved into `specifying`, the run there
asks, the run **parks**, a person answers on the task, and the next run is told the answer. It is
B7's question path ([ask.md](ask.md)) on the card `./drive.sh` carries through the whole board,
rather than on a card of its own, so the card that reaches `planning` (and LOB-86's build and review
after it) is one that was specified and answered.

The column is the specifying stage: `specifying` declares the `specifier` role, so its runs are
read-only (LOB-74, `READ_ONLY_ROLES` in `packages/harness/src/policy.ts`). The asking run's turn is a
`bash` read — the sleep that makes it busy — and the drive asserts that read ran rather than was
refused: a stage that blocked the specifier's reads would also be the reason a run could never get as
far as asking.

## How a user reaches it

```sh
factory board move --task tsk_… --to specifying --expect-revision 1
factory board start --task tsk_… --prompt "specify this card"   # the run asks, and ends
factory board show --task tsk_…                                 # blocked needs_input from specifying, the question
factory board comment --task tsk_… --expect-revision 4 --body "Postgres 16. …" --actor person:…
factory board show --task tsk_…                                 # blocked -, the answer under the question
factory board start --task tsk_… --prompt "go on"               # the next run is told the thread
factory board move --task tsk_… --to planning --expect-revision 6
```

## How the skill drives it

`./up.sh` starts its API with the script this phase needs: `FAUX_COMMAND="sleep 4; echo faux-ok"`
(the sleeping command `verify-api`'s `sigterm.sh` and `ask.sh` hold a turn open with) and
`FAUX_ASK=<question>`, which it records in `.verify/run/faux-ask`. The faux model asks only when the
run was offered `ask` and its prompt has no `task_thread` yet, so every later run on the answered card
takes an ordinary turn.

`./drive.sh`, between `board start` and the person's move to `planning`, every command typed into the
private tmux pane:

1. `board start --prompt 'specify this card'` — exit 0, a `ses_…`, `task … in specifying`, and the
   `sent` line.
2. `ask.ts MODE=busy` (EVIDENCE_PREFIX=specify) sees the run **busy** while the sleep holds its turn:
   the control without which "not busy after the ask" could not fail.
3. `ask.ts MODE=parked`: the card is blocked; within 5 s of the block the run is **not busy**, no tool
   runs and nothing is queued; its `bash` read ran (not refused by the stage); the transcript ends on
   the ask's result; the thread holds one `question` by that run, verbatim.
4. `board show` — `blocked   needs_input from specifying since …`, and the question under
   `[question] <ses_…> (revision 2)`.
5. `board comment --body $'Postgres 16.\n  Keep port 5442 \xe2\x80\x94 it is shared.'` at the revision
   `show` printed — `answered: … is no longer blocked (needs_input from specifying)`.
6. `board show` — `blocked   -`, `thread    2`, the answer by `person:verify-board` with its second
   line and its em dash intact.
7. `board start --prompt 'go on'` — a second `ses_…`, different from the first.
8. `ask.ts MODE=told` reads that run's log through a reader-mode `PostgresStorage`: its committed
   `task_thread` section contains the answer verbatim (newline and em dash included), after the
   question, and the run — holding the answer — did not ask again.

The move to `planning` then expects the revision step 6 printed, so a block or an answer that wrote
an unexpected revision fails the move rather than passing unnoticed.

## Evidence

`.verify/evidence/latest/board/`: `start.txt`, `show-asked.txt`, `comment.txt`, `show-answered.txt`,
`start-next.txt` (raw panes); `specify-busy.json`, `specify-parked.json`, `specify-told.json` (each
probe's checks and facts, the recorded thread section among them); the drive's checks in
`observed.json`, with both session ids.

Mutations observed on 2026-10-27, each a non-zero `./drive.sh`:

- the `ask` tool's result without `terminate` (the run replies after asking): "the run ended on its
  ask" and "after the ask the run is parked" fail;
- the thread section rendered without answers: all three `told` checks fail;
- `sleep` dropped from the stage's read allowlist: the busy control, "the run's read ran in the
  specifying stage" and the parked check fail.

## What it does not prove

- **A restart between the ask and the answer.** `drive.sh` runs against `./up.sh`'s shared instance and
  does not kill it; `./ask.sh` owns its API and proves the question and the block survive SIGTERM
  ([ask.md](ask.md)).
- **The spec document (LOB-72).** A run cannot write `factory.spec`: `writeSpec` is harness-only, with
  no model tool and no RPC, so nothing ties the ask to a spec's `openQuestions` yet. The validator and
  its durability are `.pi/skills/verify-api`'s `spec.sh`.
- **The stage's refusals.** The drive shows the stage letting a read through; that it refuses writes
  is `.pi/skills/verify-policy`'s `stage` case.
- **The thread in the dashboard.** The card pane does not render the thread; the web phase reads the
  card after it has left `specifying`.
- What a real model asks, or when: `MODEL_BACKEND=faux` scripts it.
