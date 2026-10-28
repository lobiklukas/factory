# A closed PR is not adopted by the card's next run (F12)

**What it is.** A card's runs share one branch and one PR (C19): a later run adopts the PR an earlier
run of the card recorded (`cardPullRequestFor` in `packages/core/src/SessionService.ts`). When that PR
was closed on GitHub without merging, pushing onto it lands the work where nobody will review it, so
the close is recorded on the PR's sessions — `closedAt` on `factory.merge`, indexed in
`sessions.pr_closed_at` (migration 0050) and refolded by `rebuildIndexes` — and a closed PR is not
adopted: the next run opens a fresh PR from the card's branch. The close is recorded from GitHub's
signed `pull_request` closed delivery (`recordMergedDelivery`, which `POST /webhooks/github` runs) and,
on a box no webhook reaches, from the PR-state read when the card is opened
(`refreshCardPullRequest`, C20).

**How a user reaches it.** They close the card's PR in GitHub. The card is blocked `pr_closed` (C20);
they unblock it and start another building run, which opens a new PR.

**How the skill drives it.** `./pr-closed.sh` starts its own loopback GitHub fake (`./github-fake.ts`,
ledger on disk) and runs `pr-closed.ts`, which builds the session and task services in-process on the
run's database:

1. The card's first building run commits a change; its PR step opens PR #1 on the fake.
2. The fake's `PATCH .../pulls/1` closes it, as a person's click would, and the signed closed delivery
   GitHub would send is handed to `recordMergedDelivery` and `settleCardsOfDelivery`: the run's
   session gets `pr_closed_at`, and the card is blocked `pr_closed`.
3. Unblocked, the card's next run continues the same branch and its PR step opens PR #2.
4. A third run, with PR #2 open, adopts it (`already-open`).

The script then reads the ledger: two creates, two PRs on one head, the first closed and the second
open. The fake refuses a second create only against an _open_ PR on the head, as GitHub does.

**What proves it works.** `.verify/evidence/latest/api/pr-closed.json` (the driver's checks),
`pr-closed-ledger.json` and `pr-closed-process.json`. A mutation run with the `pr_closed_at IS NULL`
filter removed from `cardPullRequestFor` fails the drive: the second run adopts PR #1
(`already-open`) and the ledger holds one create.

Port: `PR_CLOSED_PORT`, then `API_PORT`, then 9411.
