# A PR's review and checks reach its card

**Status: passing.**

## What it is

The "review the PR" step of the journey closes its loop (C21; docs/board.md B7). A person who requests
changes on the card's PR in GitHub, or a check that fails on it, used to leave the card exactly as it
was: `POST /webhooks/github` read `pull_request` and `push` and answered every other event `202`. Now
`pull_request_review`, `pull_request_review_comment`, `check_run`, `check_suite` and `workflow_run`
each land one note on the thread of the card whose current PR they name (`@repo/core`'s
`pullRequestFeedback.ts`):

- a review that **requests changes** is a note naming the reviewer, the PR and the commit, its body
  verbatim, and blocks the card `changes_requested` — the attention view lists it as **Address a
  review** (`factory board attention`: a `review` row), the card's face says `blocked · changes
requested`, and the pane's block note names the reviewer and the PR;
- a review that approves or comments with words, and a comment on a line of the change, are notes;
- a **failing check** (`failure`, `timed_out`, `action_required`, `startup_failure`) on the PR's head is
  a note naming the check, the commit and its page, with its output's title and summary — once across
  the check run, its suite and the workflow run, and without blocking the card.

Every note is keyed by the item it carries, so GitHub's redelivery writes nothing twice. The next run
started on the card is told the whole thread as its `task_thread` prompt section — the review as
written, less what no person on the PR can see (HTML comments, zero-width and bidi characters,
`sanitizeTriggerText`) — and, once its owner opens, a run that writes code (a building run, not a
read-only or a review column's) lifts the `changes_requested` block. Only an owner's, member's or
collaborator's review reaches the card (`author_association`); a stranger's is `202`. The block never
holds a PR push on settle (C18): the push is what answers the review.

## How to get to it (user POV)

Request changes on the card's PR in GitHub (or let CI fail on it). Open the card: it is blocked, the
review is on its thread, and **Needs a person** lists it. Start the next run on the card (the pane's
Runs section, or `factory board start --task tsk_…`): the block lifts, the run reads the review, and
its settle pushes to the card's one PR.

## Driving it with feedback.sh

`./feedback.sh` starts its own API (`FEEDBACK_PORT`, default 9405) and GitHub fake
(`FEEDBACK_GITHUB_PORT`, default 9406), walks a card into `building`, and lets a builder run open its
PR when it settles. Then `feedback.ts MODE=deliver` signs what GitHub would send: an unsigned review
(`401`), a `changes_requested` review twice (one note, one block; the redelivery writes nothing), a
failing `check_run` on the PR's head (one note, no block) and its failing `check_suite` (nothing more).
It requires:

1. `factory board show` to print `blocked   changes_requested from building`, the block naming
   `@verify-reviewer requested changes on pull request #N (<PR>#pullrequestreview-…)`, and `thread    2`:
   the review verbatim under `[note] github:verify-reviewer`, then `[note] github:checks`
   `Check "gate" failed (failure) …`;
2. `factory board attention --board` to list the card as a `review` row with the reviewer's words;
3. `factory board start` to open the next run, after which `board show` prints `blocked   -`;
4. that run's recorded prompt (`feedback.ts MODE=told`, the committed `task_thread` section) to quote
   the review's two lines verbatim after the line naming the reviewer, and the failing check;
5. that run's settle to record the card's one PR (the fake asked for one PR in all), so the lifted
   block held nothing back.

Evidence: `feedback-observed.json`, `feedback-show-blocked.txt`, `feedback-attention.txt`,
`feedback-show-resumed.txt`, `feedback/feedback-deliver.json`, `feedback/feedback-told.json`.

## Gotchas

- **GitHub sends no webhooks to a loopback API**, so the drive signs the bodies itself, shaped from
  GitHub's webhook docs, with the instance's `GITHUB_WEBHOOK_SECRET` — as `merge.ts` and `review.ts`
  do. The fake forge only opens and reads the PR.
- **A check's PR is found by its number.** `check_run.pull_requests[]` carries no PR page, so the page
  is the payload's `repository.html_url` plus `/pull/<n>`, which is what `sessions.pr_url` records. A
  check of a commit the PR has moved past (`pull_requests[].head.sha` is not the checked commit) is
  skipped.
- **The factory's own reviewer is not echoed.** Its comment carries `<!-- factory-review … -->`
  (LOB-36); its verdict is already the card's (`review_verdict`).
