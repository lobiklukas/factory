# The ask on the task

**Status: passing.**

## What it is

docs/board.md B7: a run that needs a person **ends** — parked, not hanging — with its question on the
card, and the next run reads the card's whole thread as context (LOB-73, part 2 of LOB-46).

- A run bound to a card is offered the `ask` tool (`packages/harness/src/ask.ts`). Calling it records a
  `question` comment and a `needs_input` block — the typed reason plus the column the card blocked
  from — in one transaction (`TaskService.ask`), and the tool result carries
  `control: { terminate: true }`, so the run ends without another model request. Pi Durable ends a
  run only when every call of the round asks to, so an `ask` that shares its round with any other
  call is refused as a tool error before anything is recorded, and the model is told to call it
  alone (`ask.test.ts` scripts `[bash, ask]` in one response).
- A person's comment on a card blocked `needs_input` is the **answer**: `factory board comment`
  appends it and lifts the block in the same transaction.
- Every run on the card is told the thread: a `task_thread` prompt section quoting each comment
  verbatim, oldest first. The section reads the thread before every request, so the parked run's
  own live owner is told an answer too, if a person messages that session rather than starting a
  new run. The run's committed `pi.system` entry is the record of it.
- The thread is bounded twice: a comment's body is at most `MAX_COMMENT_CHARS` (16,000) characters
  at the RPC, and the section at most `THREAD_CHAR_CAP` (40,000), dropping whole comments oldest
  first behind an "N older comments omitted" marker — the two newest always stay, so the latest
  question and its answer are never cut.

The thread is stored in `task_events` as `commented` events (B3: cards are rows), not in a table of
its own and not in a session log — see the header of `packages/core/src/TaskService.ts`.

## How a user reaches it

```sh
factory board start --task tsk_… --prompt "specify this card"   # the run asks, and ends
factory board show --task tsk_…                                 # blocked needs_input from specifying, the question
factory board comment --task tsk_… --expect-revision 4 --body "Postgres 16."   # the answer; unblocks
factory board start --task tsk_… --prompt "go on"               # the next run is told the thread
```

## How the skill drives it

`./ask.sh` owns its API (ASK_PORT, default 9401) and runs it twice:

1. **Process 1.** `FAUX_COMMAND="sleep 4; echo faux-ok"` holds the run's `bash` turn open, so the probe
   first sees the run **busy** — the control that makes the next check able to fail. `FAUX_ASK` makes
   the faux script call `ask` after that turn. `ask.ts MODE=parked` then asserts, within 5 s of the
   block: the live owner is not busy, no tool runs and nothing is queued, the run's `bash` read ran
   rather than being refused by the read-only stage, the transcript ends on the ask's result, and the
   question is on the task by the run. `factory board show` prints
   `needs_input from specifying` and the question verbatim.
2. **SIGTERM**, then **process 2** (a different pid). `board show` still prints the block and the
   question; `board comment` answers at the revision `show` printed and reports the block lifted;
   `board start` opens the next run. `ask.ts MODE=told` reads that run's log through a
   `PostgresStorage` reader: its `task_thread` section contains the two-line, em-dashed answer
   verbatim, after the question; and the run — scripted to ask whenever it has no thread — did not.

## Evidence

`.verify/evidence/latest/board/`: `ask-observed.json` (every drive check), `ask-busy.json`,
`ask-parked.json`, `ask-told.json` (each probe's checks and facts, the recorded thread section
among them), the CLI outputs `ask-*.txt`, and both processes' log `ask-api.log`.

## What it does not prove

- What a real model asks or when: `MODEL_BACKEND=faux` scripts the ask. The tool's description is the
  model-facing contract; `packages/harness/src/ask.test.ts` proves the seam.
- The tracker half — Linear's `elicitation` and replies arriving as session events — is LOB-14's.
- The same path on the card `./drive.sh` walks through the board, in its tmux pane, is
  [specify.md](specify.md) (LOB-85); this script is the restart half.
- The specifier's spec doc declaring the gaps that cause an ask (LOB-72): a run cannot write it yet
  (no tool), so nothing ties an ask to `openQuestions`. The read-only stage's refusals (LOB-74) are
  `.pi/skills/verify-policy`'s `stage` case.
