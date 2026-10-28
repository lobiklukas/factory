# A card run's PR follows its branch: later settles push, and a boot settles what no process saw

**Status: passing** (F14, F16; `./pr-settle.sh`).

## What it is

Two gaps in the PR a settled run opens without an operator (C18):

- **F14 — a session that settles again with more commits pushes them to its open PR.** Before, the PR
  step answered a recorded PR from the log without measuring or pushing, and the settle hook skipped
  a session whose `pr_url` was set, so a steered trigger session or a building run sent on left its
  later commits unpublished. Now a recorded PR whose branch has moved past the commit it was
  published at takes every step of an open but the GitHub call — measured, capped, scanned for
  secrets, pushed fast-forward only — and its record's `commit` moves to the new tip; the answer is
  `updated` and the transcript says `pushed <sha> to <pr>`. A branch still at the published commit
  is answered `already-open` from the log and reaches no forge. A refusal (`over-cap`,
  `non-fast-forward`, `secret-found`) is said as for an open — "the PR step pushed nothing to
  <pr>: …" — and the record stays where the forge has it. `pr_link` on the latest run's own PR is met
  only while the branch is at that published commit.
- **F16 — a boot sweep settles runs no process saw.** The settle-time step is forked only where a
  process sees a run go idle, so a process that died between the settle and the step, or inside the
  step before `factory.pr` committed, left the session with no PR. At boot, after the runs and
  missions are resumed, `settlePullRequestsAtBoot` takes the step for each session the settle rule
  declares (`prOnSettle.ts`) that records no PR, has no run in flight, and has its worktree under this
  process's session root — unless its run's tail already holds the step's no-change or not-opened
  entry at the branch's current tip, which is not announced again. A person's session, a fork, a
  replay, a released workspace and a parked run are never opened.

## How a user reaches it

Nothing to press: a card's run in `building` (or a trigger's session) opens its PR when it settles,
and every later settle of the same session pushes its new commits; `factory pr <session-id>` does the
same on demand. An API restarted after a crash opens what the crash cut short.

## How the skill drives it

`./pr-settle.sh` starts its own API, the two loopback fakes `verify-api/pr-push.sh` uses as one forge
(`git-forge-fake.ts`, real `git http-backend` behind the token; `github-fake.ts` with
`GITHUB_FAKE_GIT_ROOT`, and here `GITHUB_FAKE_HANG_FIRST=1`), a fixture repository on that forge, and
`FAUX_EVERY_TURN=true` so every message's run commits one more line.

1. `factory repo add` registers the checkout with the forge URL; `pr-settle.ts MODE=seed` puts a card
   straight into `building`; `factory board start` opens the run.
2. The run settles, its step pushes `factory/<id>` and asks GitHub for the PR, which the fake holds
   open. The API is SIGKILLed there; the session's log records no PR.
3. The API restarts: the session records the PR at the forge's commit, the log says
   `settled PR steps: resumed 1 in flight: <id>`, GitHub holds one PR for the head (the second
   create is refused as a duplicate and adopted, LOB-179), and `factory pr` answers `already-open`.
   A second restart steps nothing more.
4. A commit by hand on the run's branch: `board move --to review` is refused naming `pr_link` ("past …
   where that PR was published").
5. `factory send` the session again: its run commits and settles, and the forge's `factory/<id>`
   moves to the worktree's tip (fast-forward), the transcript says `pushed <sha> to <pr>`, GitHub was
   asked for no new PR, and the record names the new tip.
6. `factory pr` with no new commit answers `already-open` and neither fake sees a request; the move
   to `review` goes through.
7. Someone else pushes to `factory/<id>`; the session commits again and settles: the transcript says
   the step pushed nothing to the PR because the remote has commits the branch does not, the forge's
   branch keeps their commit, the session keeps its PR, and `factory pr` exits non-zero
   `non_fast_forward`.
8. No line of the API log or the CLI output carries the token.

## What proves it works

`.verify/evidence/latest/board/pr-settle.json` (every check), `pr-settle-github.json` and
`pr-settle-git.json` (the fakes' ledgers), `pr-settle-*.txt` (each CLI call and probe), and
`pr-settle-api.log`. Last run 2026-10-28 from `agent/F14-F16` on API `:9510`, GitHub fake `:9511`,
git forge `:9512`: **21/21** checks passed.

The cases in code: `packages/core/src/prStep.test.ts` (an update pushes and records the new tip, no
new commit reaches no forge, a diverged remote is `non-fast-forward` with nothing forced),
`packages/core/src/SessionService.prOnSettle.test.ts` (a card run's later settles: `updated`, `pr_link`
unmet then met, `over-cap` keeping the record; a trigger session's no-commit settle `up-to-date`),
`packages/core/src/SessionService.prOnBoot.test.ts` (the kill-fixture boot, the announcement rule, the
untouched sessions), `packages/core/src/prOnSettle.test.ts` and `packages/core/src/requirements.test.ts`
(the rules).
