# `requires[]` on exit: the `verified` gate

**Status: passing.**

## What it is

A column's exit requirements, checked when a card leaves it (docs/board.md B5, B8; LOB-80, part 3 of
LOB-16). The default pipeline's `review` declares `verified` from definition version 3
(`0018_seed_verified_requirement.ts`): `review → done` goes through only when the card's latest
`verify` call over a change passed for every surface that change touched. A refusal is
`requirement_unmet`, and its words name the requirement and say what is missing — never a bare
"denied". A move into `canceled` is never gated, and a card pinned to version 1 or 2 keeps the exit it
started under (B2).

The rules are `packages/core/src/requirements.ts`; `TaskService.move` reads the `verify` records out
of the logs of the card's runs (`task_runs`) before it locks the card.

## How a user reaches it

```sh
factory board move --task tsk_… --to done --expect-revision 5
# error: requirement_unmet: the move review → done needs "verified" (a passing verification of every
#   surface the card's change touched), which is not met: the card has no runs, so nothing verified
#   its change                                                                          (exit 1)

factory board start --task tsk_… --prompt "make the change and verify it"   # the run calls verify
factory board move --task tsk_… --to done --expect-revision 5
# moved tsk_… to done (revision 6)
```

## How the skill drives it

`./requires.sh` (standalone; its own API on `REQUIRES_PORT`, default 9402, with `MODEL_BACKEND=faux`,
`FAUX_VERIFY=true` and `FAUX_COMMAND="bash change.sh"`). It builds a fixture repo with a passing
`verify-web` skill, seeds a card on the newest `default` definition (`requires.ts MODE=seed`), walks it
into `review` with `factory board move`, and then:

1. **No evidence.** `board move --to done` is refused: `requirement_unmet`, `"verified"` and the reason
   verbatim, exit non-zero, and `board show` still prints `review` at the same revision.
2. **Web, passing.** `board start` opens a run whose `change.sh` writes `apps/web/…`; the faux model
   calls `verify`, which runs the fixture's `verify-web`. `requires.ts MODE=settled` reads the record
   back out of the run's log: one report, `web:VerifyRan:0`.
3. **Api, unverified.** A second run changes `apps/api/…`, which has no skill (`api:VerifyNoEvidence`).
   The move is refused again, naming `verified`, the run and `api` — the passing `web` evidence from
   the first run is a different surface and does not count — and the remedy (declare
   `commands.verify`, or add a `verify-<surface>` driver).
4. **Api, passing.** A third run changes `apps/api/…` and adds a passing `verify-api` skill
   (`api:VerifyRan:0`); the same move goes through, exit 0.

Each run's change is committed on the fixture's `main` before `board start`, so the worktree the run
is cut from carries it and the faux command never changes.

## Evidence

`.verify/evidence/latest/board/`: `requires-observed.json` (every check), `requires-refused-none.txt`,
`requires-refused-surface.txt`, `requires-done.txt`, `requires-move-*.txt`, `requires-start-*.txt`,
`requires-{web,api-unverified,api-verified}.json` (each run's decoded `verify` record) and
`requires-api.log`.

## What it does not prove

The other keys of the default pipeline (`spec_doc`, `plan_doc`, `run_completed`, `non_empty_diff`,
`pr_link`, `review_verdict`) are not checked: nothing records their evidence yet, and
`requirements.ts` says so. The human gates (`human_move`, `human_merge`) are B5's actor check, proven
in `packages/core`'s `TaskService` cases. A change made _after_ the latest `verify` call is not seen;
that is LOB-79's coverage check, on the PR. Ordering calls across interleaved runs by when they were
recorded, and refusing on a newest call that left no record, are pinned in `requirements.test.ts`,
not driven here.
