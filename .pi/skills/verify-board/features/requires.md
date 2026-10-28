# `requires[]` on exit: the `building` gate, the `verified` gate and the reviewer's verdict

**Status: passing.**

## What it is

A column's exit requirements, checked when a card leaves it (docs/board.md B5, B8; LOB-80, part 3 of
LOB-16). The default pipeline's `building` declares `non_empty_diff` and `pr_link` from version 1, and
both are checked since LOB-240: `building → review` goes through only when the card's latest run's
branch has a committed change against its base — measured by the PR step's own `diffSize`
(`git diff --numstat base...head`, LOB-196) in the run's registered checkout — and that run's log
records a PR (`factory.pr`, LOB-177). Its `review` declares `verified` from definition version 3
(`0018_seed_verified_requirement.ts`): `review → done` goes through only when the card's latest
`verify` call over a change passed for every surface that change touched. A refusal is
`requirement_unmet`, and its words name the requirement and say what is missing — never a bare
"denied". A move into `canceled` is never gated, and a card pinned to version 1 or 2 keeps the exit it
started under (B2) — `review` without `verified`, `building` with the two keys every version declares.

`review` also declares `review_verdict` from version 1, checked since LOB-241: `review → done` goes
through only when the review run — a run whose log records a `factory.review` target, which the
review trigger opens on the card for each head of its PR (LOB-36) — of the card's PR at the head that
PR was last reported at recorded `pass`. Every review delivery records its head in `review_heads`
before its run opens, a replay included, so a force-push back to an earlier head is judged on that
head's review, not on the newest run. No review run, only another PR's, a reported head with no run
yet, a run that has recorded no verdict yet (naming the head under review), a `fail` (naming the
failing dimensions), and a pass the post found `stale` are each refused naming `review_verdict`; an
older head's pass never stands in for the reported head's. Review runs come only from signed
`POST /webhooks/github` deliveries, so a deployment GitHub cannot reach has none and no card of it
reaches `done`.

The rules are `packages/core/src/requirements.ts`; `TaskService.move` reads the `verify` records and
the `factory.pr` document out of the logs of the card's runs (`task_runs`), the `factory.review`
document out of its review runs', and measures the latest run's branch, before it locks the card.

## How a user reaches it

```sh
factory board move --task tsk_… --to review --expect-revision 4
# error: requirement_unmet: the move building → review needs "non_empty_diff" (a non-empty diff),
#   which is not met: the card has no runs, so no branch carries its change             (exit 1)

factory board start --task tsk_… --prompt "build this card"   # the builder commits on its branch
factory board move --task tsk_… --to review --expect-revision 4 --actor ses_…
# error: requirement_unmet: the move building → review needs "pr_link" (a PR link), which is not
#   met: the card's latest run ses_… recorded no PR (no factory.pr document in its log): open its
#   PR (factory pr ses_…) before moving the card on                                     (exit 1)

factory pr ses_…                                                   # pr https://github.com/…/pull/1
factory board move --task tsk_… --to review --expect-revision 4 --actor ses_…
# moved tsk_… to review (revision 5)

factory board move --task tsk_… --to done --expect-revision 5
# error: requirement_unmet: the move review → done needs "verified" (a passing verification of every
#   surface the card's change touched), which is not met: none of the card's 1 run(s) recorded a
#   verify call over a change (0 call(s) recorded)                                      (exit 1)

factory board start --task tsk_… --prompt "make the change and verify it"   # the run calls verify
factory board move --task tsk_… --to done --expect-revision 5
# error: requirement_unmet: the move review → done needs "review_verdict" (a review verdict), which
#   is not met: no review ran: the card has no review run (…)                          (exit 1)

# GitHub's pull_request (opened, then synchronize per push) → a reviewer run per head
factory board move --task tsk_… --to done --expect-revision 5
# error: requirement_unmet: … "review_verdict" …: run ses_…'s review of …#1 at 3f2a…
#   failed correctness: fix the findings and push, and the new head's review decides the move
factory board move --task tsk_… --to done --expect-revision 5     # after the fixed head's pass
# moved tsk_… to done (revision 6)
```

## How the skill drives it

`./requires.sh` (standalone; its own API on `REQUIRES_PORT`, default 9402, with `MODEL_BACKEND=faux`,
`FAUX_VERIFY=true` and `FAUX_COMMAND="bash change.sh"`, and the builder role on its own faux model,
`ROLE_MODELS=builder=faux/builder`, whose `FAUX_MODEL_SCRIPTS` row commits one file and calls no
`verify`; the loopback GitHub fake on `REQUIRES_GITHUB_PORT`, default 9404; a fresh
`GITHUB_WEBHOOK_SECRET`, and `FAUX_REVIEW`, the reviewer's two `review` calls — a `correctness` fail
on `apps/web/src/regress.ts`, then a clean pass). It builds a fixture repo
with a passing `verify-web` skill, seeds a card on the newest `default` definition
(`requires.ts MODE=seed`), walks it into `building` with `factory board move`, and then:

0. **Building.** With no run, `board move --to review` is refused naming `"non_empty_diff"` and the
   reason verbatim. `board start` opens the builder run, which commits `apps/web/src/built.ts` on its
   branch (`requires.ts MODE=answered`: it answered, and its log holds no `verify` record; `git diff
--numstat main...factory/<run>` lists the file). The run's move is refused again, now naming
   `"pr_link"` and the run, and `board show` still prints `building` at the same revision.
   `factory pr <run>` opens the PR on the fake (the printed link is in its ledger), and the run's
   same move goes through.
1. **No evidence.** `board move --to done` is refused: `requirement_unmet`, `"verified"` and the reason
   verbatim (the builder run is the card's one run, and it verified nothing), exit non-zero, and `board show` still prints `review` at the same revision.
2. **Web, passing.** `board start` opens a run whose `change.sh` writes `apps/web/…`; the faux model
   calls `verify`, which runs the fixture's `verify-web`. `requires.ts MODE=settled` reads the record
   back out of the run's log: one report, `web:VerifyRan:0`.
3. **Api, unverified.** A second run changes `apps/api/…`, which has no skill (`api:VerifyNoEvidence`).
   The move is refused again, naming `verified`, the run and `api` — the passing `web` evidence from
   the first run is a different surface and does not count — and the remedy (declare
   `commands.verify`, or add a `verify-<surface>` driver).
4. **Api, passing.** A third run changes `apps/api/…` and adds a passing `verify-api` skill
   (`api:VerifyRan:0`): `verified` is met, and the same move is refused naming `"review_verdict"` —
   no review ran (LOB-241).
5. **Head A passes.** `review.ts MODE=review` signs a `pull_request` `opened` for the builder's PR (its
   page from `factory pr`, the head of `factory/<builder>`, `main`'s commit as the base) and delivers
   it on `POST /webhooks/github`. The answer names a reviewer session; it is cut at the head, settles
   with a non-error `review` result, and its log's `factory.review` records `pass` on that head. The
   first `FAUX_REVIEW` call names a file head A does not change, so the tool refuses it and the
   reviewer's retry is the clean pass — the same rule that makes head B fail.
6. **Head B fails.** A commit on the PR's branch in the builder's worktree (a push) adds
   `apps/web/src/regress.ts`, and its `synchronize` opens the next head's reviewer, which records
   `fail` (`correctness`). The move is refused naming `review_verdict`, head B and `correctness`, and
   names nothing of head A: A's pass does not survive the push.
7. **Head C passes.** A second push removes the file; its reviewer records `pass`.
8. **Back to B, then to C.** A signed `synchronize` back at head B (a force-push undoing the revert)
   is answered `replayed`: B's run already exists, so no run is opened and C's pass stays the newest
   review run. The move is still refused on B's `correctness` fail, because the delivery recorded B
   as the PR's head (`review_heads`). A `synchronize` back at C is replayed too, and the same move
   goes through, exit 0.

Each review run's change is committed on the fixture's `main` before `board start`, so the worktree
the run is cut from carries it and the faux command never changes.

## Evidence

`.verify/evidence/latest/board/` (last run: `.verify/evidence/lob-241/board/`, 56/56, LOB-241,
2026-10-28; before it `.verify/evidence/lob-240/requires/board/`, 24/24): `requires-observed.json`
(every check, and the three heads), `requires-unreviewed.txt`, `requires-refused-review.txt`,
`requires-refused-back.txt`, `review-requires-{a,b,c,b-again,c-again}.json` (each delivery, its
reviewer session and the review its log records; a replay's answer only),
`requires-building-none.txt`,
`requires-building-no-pr.txt`, `requires-show-building.txt`, `requires-build-diff.txt`,
`requires-pr.txt`, `requires-move-review.txt`, `requires-refused-none.txt`,
`requires-refused-surface.txt`, `requires-done.txt`, `requires-move-*.txt`, `requires-start-*.txt`,
`requires-build.json` (the builder run, no `verify` record), `requires-{web,api-unverified,api-verified}.json`
(each run's decoded `verify` record) and `requires-api.log`.

## What it does not prove

The other keys of the default pipeline (`spec_doc`, `plan_doc`, `run_completed`)
are not checked: nothing records their evidence yet, and `requirements.ts` says so. A review run that
has recorded no verdict yet is refused naming its head in `TaskService.test.ts`, not here: the faux
reviewer settles before a second command could race it. Nor is a push the review trigger has not
been told of (no `synchronize` yet): the newest review run is then the previous head's, and its pass
is judged as the newest — `requirements.ts` names that window. A branch nothing
can measure (a repository with no registered checkout) and a newer run without a PR after an older
one with one are refusals pinned in `TaskService.test.ts`, not driven here. The human gates (`human_move`, `human_merge`) are B5's actor check, proven
in `packages/core`'s `TaskService` cases. A change made _after_ the latest `verify` call is not seen;
that is LOB-79's coverage check, on the PR. Ordering calls across interleaved runs by when they were
recorded, and refusing on a newest call that left no record, are pinned in `requirements.test.ts`,
not driven here.
