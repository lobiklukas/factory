# Build, PR with evidence, review, merge — on the drive's card

**Status: passing** (LOB-86, part 3 of LOB-49).

## What it is

The rest of milestone B's path on the card `./drive.sh` specified and answered
([specify.md](specify.md)): a person approves the plan, a run in `building` makes a change and
verifies it, the run's PR is opened on the forge with the verification in its body, the card moves to
`review`, the PR's reviewer run records its verdict (LOB-241: a faux reviewer the review trigger opens
on the PR's head, not a person's note), the run is refused the merge, and the person's merge takes the
card to `done` (docs/board.md B4, B5, B8).

Since C18 nobody opens the run's PR: `building` requires one (`pr_link`), so the build run takes the
PR step itself when it settles with its change (`packages/core/src/prOnSettle.ts`), and the drive only
reads the link back — `build.ts MODE=settled`, then the card pane showing it with no control to press
(`pr-browser.mjs`, `PR_MODE=recorded`). C7's press is still the dashboard's way for a session that has
no PR (verify-web's `pr.sh`), and `factory pr` the terminal's; `requires.sh` runs it on the settled
run's PR and reads `already-open`.

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
- **A reviewer for `./up.sh`'s instance** (LOB-241). `ROLE_MODELS`' `reviewer=faux/reviewer` row,
  whose `FAUX_MODEL_SCRIPTS` row reads the diff, and `FAUX_REVIEW`, a clean pass; `GITHUB_WEBHOOK_SECRET`
  is a fresh value per instance (`.verify/run/webhook-secret`), which `review.ts` signs the PR's
  `pull_request` delivery with, since the fake forge sends no webhooks.

## How a user reaches it

```sh
factory board move --task tsk_… --to building --expect-revision 7 --actor person:…   # plan approval
factory board start --task tsk_… --prompt "build this card"                          # ses_… makes the change
# the run settles with its change: its PR is opened by the PR step, with no call     # PR #N, on the row and in the run pane
factory pr ses_…                                                                     # answers it: pr https://github.com/…/pull/N, already-open
factory ls                                                                           # the run's row carries the link
factory board move --task tsk_… --to review --expect-revision 8 --actor ses_…        # the run moves its card on
factory board move --task tsk_… --to done --expect-revision 9 --actor person:reviewer  # refused: needs "review_verdict"
# GitHub's pull_request (opened) → the review trigger opens a reviewer run on the card at the PR's head
factory board runs --task tsk_…                                                      # the reviewer, newest, in review
factory board move --task tsk_… --to done --expect-revision 9 --actor ses_…          # refused: the merge gate
factory board move --task tsk_… --to done --expect-revision 9 --actor person:reviewer
```

## How the skill drives it

After the dashboard phase, in the same tmux pane, each command followed by the exit-code sentinel:

1. **Plan approval.** A person's `planning → building`, at the revision the last accepted move left —
   clicked in the dashboard since LOB-87, and read back with `board show`
   ([equivalence.md](equivalence.md)); from the terminal only when the browser did not make it.
2. **The build run.** `board start` in `building`; `build.ts MODE=built` checks it is bound to the
   board's repository on `factory/<run>`, in a worktree whose `HEAD` is that branch, though the card
   named no repo (LOB-255), then waits for it to answer and reads its log: exactly one `verify` record, over `apps/web/src/card.ts`, a `VerifyRan` of the
   `.pi/skills/verify-web` skill on the `web` surface, exit 0. The card pane's run start
   (`startRunAtom`) is not driven here: it sends the same `createSession` with the card named, and
   the binding is the server's (`SessionService`'s `cardRepoFor`, covered in
   `packages/core/src/TaskService.test.ts`), so which client started the run does not change it.
3. **A non-empty diff.** `git diff --numstat main...factory/<run>` in the fixture checkout lists the
   changed path — git's own answer, not the factory's.
4. **The PR, opened when the run settled** (C18). Nothing asks for it: `build.ts MODE=settled` polls
   `getSession` until the build run's link is recorded (or the run's line saying why there is none)
   and prints the `pr` line `factory pr` would, which the phases after it read. The page that holds
   the card open (`pr-browser.mjs`, `PR_MODE=recorded`) then requires that link on the run's row _and_
   in the run pane's header, and no Open pull request control on either. With no GitHub path the step
   fails on the missing credential: the probe prints `error: the run settled and the PR step opened no
PR: CredentialError: …`, requires that sentence in the run's transcript (`factory.pr.not-opened`)
   and as the run's note on the card, and the drive fails naming it. The card's revision is read back
   afterwards (`show-settled.txt`): a note is a revision, so the moves below are made at the one the
   card is at. Before C18 this phase also proved `building → review` refused naming `pr_link` while
   the change was there and the PR not yet; with the PR opened on settle that window is not one a
   drive can hold open, so `pr_link` is proven here under `BOARD_GITHUB=off` (below) and in
   `TaskService.test.ts`.
5. **The PR's contents.** `build.ts MODE=pr` reads the fake's ledger: exactly one create request for
   the run's branch (`factory/<run> → main`), the PR the fake answered has the printed link, the body
   it was sent lists the path under `## Changed files`, names `faux/builder` as the model, and its
   `## Verification` section says ``### `verify-web`: exit 0`` and `- Exit code: 0`; `getSession`
   reads the same link back. `factory ls` shows it in the run's row.
6. **Review** (LOB-241). The run's own `building → review` (no gate on it; with the PR recorded the
   requirements are met). A person's `review → done` is then refused with `requirement_unmet: the move
review → done needs "review_verdict" (a review verdict), which is not met: no review ran: …` —
   `verified` is met by the build run's record, so the review is the only thing missing. `review.ts`
   delivers a signed `pull_request` `opened` for the PR (its page, the build branch's head, `main`'s
   commit as the base) on `POST /webhooks/github`; the answer names the reviewer session, which is cut
   at that head and settles with a non-error `review` result, and its log's `factory.review` records
   `pass` on the head (`outcome: clean`). `board runs` lists it as the card's newest run, in `review`.
7. **The merge gate.** The run's `review → done` is refused with
   `human_gate_required: the move review → done crosses the merge gate, which only a person can make`
   and a non-zero exit; the person's move at the same revision goes through, and `board show` says
   `column    done`.

The PR is never assumed. With no PR path the settled run's step fails, the drive prints
`drive: the PR path is missing — <the run's own line>` and records it as the failing check's
detail; the phases after it still run, with the link empty, so every check that needs a link fails on
its own rather than being skipped. No check accepts a link the ledger does not hold. And the board
does not assume it either: the run's `building → review` is refused naming `pr_link`, so the card
stays in `building` (a check that passes only when there is no link says so).

## What proves it works

C18 (2026-10-28, `agent/C18`, API `:9500`, web `:3500`, the fake on `:9503`): `./drive.sh` exit 0, **150**
PASS, with the PR opened when the build run settled — no `factory pr`, nothing pressed (`pr.txt`,
`build-settled.json`, `pr-browser.json` in recorded mode). Under `BOARD_GITHUB=off` exit 1: `pr.txt` says
`error: the run settled and the PR step opened no PR: CredentialError: no GITHUB_TOKEN configured; …`,
the same sentence is in the run's transcript and on the card ("with no PR path, the settled run says
why in its transcript and on its card" passed), and the card stayed in `building` naming `pr_link`.
`./requires.sh` exit 0, 57 PASS: the builder's PR opened on settle, `factory pr` answered `already-open`.

C7 (2026-10-28, `agent/C7`, API `:9572`, web `:3572`, the fake on `:9573`): `./drive.sh` passed with the PR
opened in the browser from the card pane's run row (`pr-browser.json`: the row offered the control, the
link on the row and in the run pane's header agreed without a reload) and no `factory pr`. Under
`BOARD_GITHUB=off` the control was disabled with `no GITHUB_TOKEN configured; cannot resolve a token for
verify-board/…`, the drive printed `drive: the PR path is missing — error: …` and failed the PR and
every check that needs a link, and the card stayed in `building` (`pr_link`).

`.verify/evidence/lob-240/pass/board/` (LOB-240, 2026-10-27, `agent/LOB-240`): `observed.json`
(**49/49**), `build-built.json` (3/3), `build-pr.json` (8/8), `pr-body.md` (the body as the fake
received it), `build-diff.txt`, and the panes `move-building.txt` (`show-building.txt` since LOB-87, where the browser approves the plan), `start-build.txt`,
`move-review-no-pr.txt` (the `pr_link` refusal before the PR), `pr.txt`, `ls-pr.txt`,
`move-review.txt`, `verdict.txt`, `show-verdict.txt`, `move-merge-run.txt`, `move-merge.txt`,
`show-done.txt`. Since LOB-241 the verdict is the reviewer run's (`.verify/evidence/lob-241/board/`,
**120/120**, 2026-10-28, `agent/LOB-241`): `move-merge-unreviewed.txt` (the `review_verdict`
refusal), `review-drive.json` (the delivery, the reviewer session and its recorded review) and
`runs-reviewed.txt` replace `verdict.txt` and `show-verdict.txt`. Before it, `.verify/evidence/lob-86/pass/board/` (43/43, without the gate).

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
- A reviewer that finds anything: the drive's faux reviewer (`./up.sh`'s `faux/reviewer`) always
  passes cleanly, so its verdict is recorded `clean` and nothing is posted. A failing verdict, and a
  push that opens the next head's review, are `requires.sh`'s (phases 5–7) and `TaskService.test.ts`'s.
