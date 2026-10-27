# Build, PR with evidence, review, merge — on the drive's card

**Status: passing** (LOB-86, part 3 of LOB-49).

## What it is

The rest of milestone B's path on the card `./drive.sh` specified and answered
([specify.md](specify.md)): a person approves the plan, a run in `building` makes a change and
verifies it, the run's PR is opened on the forge with the verification in its body, the card moves to
`review`, a person records the verdict, the run is refused the merge, and the person's merge takes the
card to `done` (docs/board.md B4, B5, B8).

Three things are new beside the drive:

- **`factory pr <session-id> [--title …]`** (`apps/cli/src/commands/pr.ts`) — the CLI's caller of the
  PR step's RPC member (`openPullRequest`, LOB-213). It prints `pr <url>`, `number`, and `outcome`
  (`opened`, or `already-open` for a repeat). An answer that opened nothing is a refusal with a
  non-zero exit: `no_change`, `over_cap`; the forge's and the credential's failures are printed as
  `pr_error` / `credential_error` with the server's message.
- **A faux script per model** (`FAUX_MODEL_SCRIPTS`, `fauxModelScripts` in
  `packages/harness/src/models.ts`). Under faux a model is its script, so the builder role runs its
  own model (`ROLE_MODELS=builder=faux/builder`, LOB-207) whose script writes
  `apps/web/src/card.ts`, commits it and calls `verify`, while every other run keeps `FAUX_COMMAND`
  (the read-only specifier's sleep). A row for a model the faux backend does not publish fails the
  boot, as does a row with a field other than `command` / `verify`.
- **A forge and a checkout for `./up.sh`'s instance.** The loopback GitHub fake
  (`.pi/skills/verify-api/github-fake.ts`) on `GITHUB_PORT` (9403 by default), ledger in
  `.verify/run/github-ledger.json`, with `GITHUB_API_URL` and a fake `GITHUB_TOKEN` handed to the
  API. The board's repository is registered over a fixture checkout (`.verify/run/board-repo`,
  carrying a passing `.pi/skills/verify-web/drive.sh`), and the drive's card names no repository —
  it inherits the board's (LOB-255) — so every run on it is a git worktree of the fixture. The board is pinned to the default pipeline's
  **newest** version, so `review → done` is also gated on `verified` (LOB-80).

## How a user reaches it

```sh
factory board move --task tsk_… --to building --expect-revision 7 --actor person:…   # plan approval
factory board start --task tsk_… --prompt "build this card"                          # ses_… makes the change
factory board move --task tsk_… --to review --expect-revision 8 --actor ses_…        # refused: needs "pr_link"
factory pr ses_…                                                                     # pr https://github.com/…/pull/N
factory ls                                                                           # the run's row carries the link
factory board move --task tsk_… --to review --expect-revision 8 --actor ses_…        # the run moves its card on
factory board comment --task tsk_… --expect-revision 9 --body 'verdict: approve …' --actor person:reviewer
factory board move --task tsk_… --to done --expect-revision 10 --actor ses_…         # refused: the merge gate
factory board move --task tsk_… --to done --expect-revision 10 --actor person:reviewer
```

## How the skill drives it

After the dashboard phase, in the same tmux pane, each command followed by the exit-code sentinel:

1. **Plan approval.** A person's `planning → building`, at the revision the last accepted move left —
   clicked in the dashboard since LOB-87, and read back with `board show`
   ([equivalence.md](equivalence.md)); from the terminal only when the browser did not make it.
2. **The build run.** `board start` in `building`; `build.ts MODE=built` checks it is bound to the
   board's repository on `factory/<run>`, in a worktree whose `HEAD` is that branch, though the card
   named no repo (LOB-255), then waits for it to answer and reads its log: exactly one `verify` record, over `apps/web/src/card.ts`, a `VerifyRan` of the
   `.pi/skills/verify-web` skill on the `web` surface, exit 0.
3. **A non-empty diff.** `git diff --numstat main...factory/<run>` in the fixture checkout lists the
   changed path — git's own answer, not the factory's.
4. **The building gate, before the PR** (LOB-240). The run's `building → review` is refused with
   `requirement_unmet: the move building → review needs "pr_link" (a PR link), which is not met: the
card's latest run ses_… recorded no PR` and a non-zero exit. It names `pr_link`, not
   `non_empty_diff`: the branch's change is the one step 3 read, and the service measured it the same
   way (`git diff --numstat main...factory/<run>`, the PR step's `diffSize`). The refusal writes
   nothing, so the move after the PR is made at the same revision.
5. **The PR.** `factory pr <run>`; the link is the `pr` line the command printed. `build.ts MODE=pr`
   then reads the fake's ledger: exactly one create request for the run's branch
   (`factory/<run> → main`), the PR the fake answered has the printed link, the body it was sent
   lists the path under `## Changed files`, names `faux/builder` as the model, and its
   `## Verification` section says ``### `verify-web`: exit 0`` and `- Exit code: 0`; `getSession`
   reads the same link back. `factory ls` shows it in the run's row.
6. **Review.** The run's own `building → review` (no gate on it; with the PR recorded the
   requirements are met), then a person's verdict as a note on
   the card, read back by `board show` under `[note] person:reviewer`. The verdict is read off the
   evidence: `approve <link>` only when there is a PR and both `build.ts` probes passed, otherwise
   `request changes` naming what is missing — and a check that the verdict approves fails on it.
7. **The merge gate.** The run's `review → done` is refused with
   `human_gate_required: the move review → done crosses the merge gate, which only a person can make`
   and a non-zero exit; the person's move at the same revision goes through, and `board show` says
   `column    done`.

The PR is never assumed. With no PR path the command fails, the drive prints
`drive: the PR path is missing — <the command's error line>` and records it as the failing check's
detail; the phases after it still run, with the link empty, so every check that needs a link fails on
its own rather than being skipped. No check accepts a link the ledger does not hold. And the board
does not assume it either: the run's `building → review` is refused naming `pr_link`, so the card
stays in `building` (a check that passes only when there is no link says so).

## What proves it works

`.verify/evidence/lob-240/pass/board/` (LOB-240, 2026-10-27, `agent/LOB-240`): `observed.json`
(**49/49**), `build-built.json` (3/3), `build-pr.json` (8/8), `pr-body.md` (the body as the fake
received it), `build-diff.txt`, and the panes `move-building.txt` (`show-building.txt` since LOB-87, where the browser approves the plan), `start-build.txt`,
`move-review-no-pr.txt` (the `pr_link` refusal before the PR), `pr.txt`, `ls-pr.txt`,
`move-review.txt`, `verdict.txt`, `show-verdict.txt`, `move-merge-run.txt`, `move-merge.txt`,
`show-done.txt`. Before it, `.verify/evidence/lob-86/pass/board/` (43/43, without the gate).

**Non-vacuity: the PR path missing.** `./up.sh` with `BOARD_GITHUB=off` starts no fake and hands
the API no credential (and a closed loopback port as its forge). The same drive exits 1
(`.verify/evidence/lob-240/github-off/board/`, 41/50): `factory pr` prints
`error: credential_error: no GITHUB_TOKEN configured; cannot resolve a token for verify-board/…` and
exits 1, the drive prints that reason, `observed.json`'s `prUrl` is `""`, and every ledger, body,
`getSession` and `factory ls` check fails naming why. The board refuses the run's
`building → review` naming `pr_link` (`move-review.txt`: `error: requirement_unmet: the move building
→ review needs "pr_link" (a PR link), which is not met: the card's latest run ses_… recorded no PR …`),
which passes "with no PR, the board holds the card in building, naming pr_link" and fails the move
check; so the verdict, the merge refusal and the merge fail on a card that never reached `review`, and
`show-done.txt` says `column    building` — where LOB-86's run of the same drive, before the gate,
showed `column    done`.

Unit coverage: `apps/cli/src/commands/pr.test.ts` — `prAnswer` (which answers count as a PR, and the
`no_change` / `over_cap` refusals' words) and `reportFailures`, the handler the command runs under
(`CredentialError` / `PrError` printed as `credential_error` / `pr_error`, exit 1); that the command
itself exits non-zero on a refusal is the `BOARD_GITHUB=off` drive's. `packages/harness/src/models.test.ts`
("a faux model's own script", `parseFauxModelScripts`, including a misspelt model id or field).

## What it does not prove

- That GitHub accepts the request as the fake does (`packages/core/src/pr.test.ts` asserts the shape).
- A reviewer _run_: the verdict is a person's note. No recorded artifact backs `review_verdict` yet.
