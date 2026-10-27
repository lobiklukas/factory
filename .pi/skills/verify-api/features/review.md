# The review agent: one read-only review per head, posted as the reviewer

**Status: passing.** A `pull_request` event on a PR the factory opened from a card starts a reviewer
run on that card; the run reads the change, records a verdict per dimension and posts one review
comment on the PR, under an identity that is not the PR author's (LOB-36).

## What it is

- **The trigger** (`packages/core/src/ReviewTrigger.ts`). `POST /webhooks/github` hands a signed
  `pull_request` to the Linear mirror and then to `handlePullRequestReviewWebhook`. `opened`,
  `reopened`, `ready_for_review` and `synchronize` on a PR whose page a session recorded, when that
  session is a run of a card, start one run in the card's reviewer column (the column whose role is
  `reviewer`). The delivery id is the head (`review-<owner>-<repo>-<number>-<sha>`), so a redelivery is
  a replay and a push is a new run on `factory/review-<number>-<sha12>`, cut at the new head — a head
  the registered checkout lacks is fetched first (`gitReviewFetch`, the worker's read credential), and
  one it still lacks is `skipped` naming the commit. The change is measured against the event's base
  commit when the checkout has it. A review run is not a run the card's exit checks read. A draft,
  another action, a PR the factory did not open and one from a run of no card start nothing, each
  answered with its reason under `review`.
- **The run** (`packages/harness/src/review.ts`). A session opened with a review target is a review
  run: the read-only `reviewing` stage whatever its column (no `write`, `edit` or `verify`, `bash`
  read commands only), on its column's role's `ROLE_MODELS` row, and the one run offered the
  `review` tool. The tool takes a verdict and findings for each of correctness, security, tests and
  performance (`[]` explicit), refuses a verdict the P0/P1/P2 rubric contradicts and a finding on a
  file the PR does not change, commits `factory.review`, and posts the rendered comment — or nothing,
  when there is no finding. One settled review per run.
- **The post** (`packages/core/src/GitHubReview.ts`). Under the reviewer's own credential
  (`GITHUB_REVIEWER_TOKEN`, or a second App on `GITHUB_REVIEWER_APP_*`; the worker's token or App is
  refused at boot, and none at all posts nothing). It reads the PR's head first — a head that moved is
  `stale` and nothing is posted — then every page of the PR's reviews for its marker, counting only a
  review the reviewer itself wrote (its token's `GET /user` login, or for an App a bot), then posts
  one `COMMENT` review pinned to the reviewed commit. Never an approval.

## How the skill drives it

`./review.sh` builds a throwaway checkout (`main`, a `feature` head that seeds `xs.slice(1)` into
`src/sum.ts`, and a second commit for the push), boots the API with `GITHUB_REVIEWER_TOKEN` distinct
from `GITHUB_TOKEN`, `ROLE_MODELS=reviewer=faux/faux-review`, a faux reviewer that runs `git diff` and
files the seeded bug (`FAUX_REVIEW`), and `GITHUB_API_URL` at `review.ts`'s own `Bun.serve` forge.
`review.ts` registers the checkout, creates a board, a card and a build run whose session records the
PR's page, then signs and posts the events.

## End state that proves it

12 checks (`review.json`, `review.log`, `api.log`): the reviewer run is processed beside the mirror;
it is a run of the card in `review`, cut at the head; it ran on `faux/faux-review`; it called only
`bash` and `review`; GitHub got exactly one `COMMENT` review with `commit_id` = the head, naming
`src/sum.ts:1` and the mechanism; every forge request carried the reviewer's token; the post read the
PR and its reviews first; a redelivery replayed with no second post; a `synchronize` opened a new run
and a second comment pinned to the new head; a PR the factory did not open was skipped; an unsigned
delivery was `401`; and the boot log names the reviewer's own identity.

Last run: 2026-10-27, from the `agent/LOB-36` worktree (API on `:9560`, forge on `:9561`, faux, the
worktree's own database on 5442): **12/12**, evidence `.verify/evidence/lob-36/`.

## What it does not prove

That a real model finds a real bug, or stays quiet on a clean PR: the faux reviewer files what its
script says (the rubric and the diff check are what is proven). Measuring the reviewer on the
factory's own PRs with a live model is LOB-242. Nor that GitHub accepts the review as spelled
(`docs/testing-third-parties.md`'s GitHub review row). Nor the fetch of a head pushed elsewhere: the
drive builds every head in the registered checkout, and `ReviewTrigger.test.ts` proves the fetch
path with a path remote standing in for `fetchBranch` (whose credentialed fetch `git.test.ts`
proves). For an App identity, a marked review by _any_ bot counts as its own: an installation token
cannot read its own login.
