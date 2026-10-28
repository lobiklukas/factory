# Plan freshness after a merge

**Status: passing.** With `PLAN_FRESHNESS=merged`, a signed merged-PR delivery to
`POST /webhooks/github` runs one read-only pass that compares the spec of record with the tracker's
current plan. It files the pass's proposals (issues to **add**, **re-scope** or **close**) as one
revision on the spec's session. Nothing reaches the tracker until a person approves it (LOB-45).

## What it is

- **The cadence.** It is off by default. `PLAN_FRESHNESS` is `off` or `merged`. A value that does not
  parse is logged, and the cadence stays off. With `off`, nothing reads the payload for the pass, no
  call is made and no row is written. With `merged`, a merge of a PR the factory opened
  (`sessions.pr_url`) runs one pass per spec of record. The spec of record is the card's newest
  `specified` event's session, or the PR's own session when it runs on no card. An unmerged close or
  an unsigned delivery runs nothing. The route's answer carries the outcome under `planFreshness`.
- **One merge, one revision.** Each pass claims `webhook_deliveries` for
  `plan-freshness:<spec session>:<pr url>`. This is the same claim the trigger seam takes, with the
  same reclaim window. A redelivery is `replayed` and makes no call. The claim is `processed` when a
  revision is filed and `skipped` when the pass was refused, so a refusal is never paid for twice. It
  is released on a storage failure, an interrupt, a busy spec session or a tracker read that failed,
  so a redelivery tries again. The revision is also filed under the merge's
  key (`merged:<pr url>`), and a held key is answered without a call.
- **The pass** (`SessionService.refreshPlan`) is one model call, made with the seeded
  `plan-freshness` skill (`0033_seed_plan_freshness_skill.ts`). It reads the spec plus the delegating
  issue's children (title, state, and the checklist in the description), read through the tracker
  port (`ProposalTracker`'s `issues`). It opens no session, has no tools and writes no tracker. It is
  capped at 4 096 output tokens. Before the call it refuses, at no cost (`PlanFreshnessRefused`): a
  busy session, no spec, a spec with gaps or too large, no tracker, no delegating issue, more than 100
  issues, and a **worst case over `PLAN_FRESHNESS_MAX_COST`** (US dollars, 0.25 by default). The worst
  case prices every prompt byte as an input token, plus the whole output cap, plus any flat per-call
  charge, so the call that follows cannot cost more than the bound. The spend is charged to the spec
  session's ledger.
- **The proposals** (`@repo/domain/PlanFreshness`). Each is `add` (title, goal, change, acceptance),
  `rescope` (an issue identifier plus a revised title, goal, change and acceptance) or `close` (an
  issue identifier and a reason). `validatePlanProposals` refuses each of the following and names
  every fault: an issue outside the plan the pass was shown, two proposals about one issue, a rescope
  or close of a closed issue, a close with no reason, an add whose title is another add's or an
  issue's, no or an empty acceptance line, and more than 20. Nothing is stored when it refuses. An
  empty answer is valid ("the plan is still fresh").
- **The revision** is listed on the spec's session as `getSession`'s `planRevisions`, live and folded.
  It holds `spec` (`sessionId`, `goal`, a digest of the spec it was derived from), the `issues` it
  was shown, the `trigger` (the PR and its number), the proposals and the `decision`.
- **A person decides.** `declinePlanRevision` marks the revision declined, makes no call and sends
  nothing. `approvePlanRevision({sessionId, key, approved})` goes through the same tracker port as
  `approveProposals` (LOB-202):
  - `add` creates a child of the delegating issue, adopted by marker on a retry;
  - `rescope` is an `issueUpdate` of the title and description, plus one marked comment;
  - `close` is one marked comment, plus a move to the team's `canceled`-type state. A closed issue is
    never moved.

  Each applied proposal is recorded before the next request, so approving again sends nothing. A
  declined revision is refused (`ApproveProposalsError`, `declined`). There is no auto-approve and no
  dispatch.

## How a user reaches it

Set `PLAN_FRESHNESS=merged` (and `LINEAR_API_KEY`, which the plan is read from) on the API, and point
GitHub's webhook at `POST /webhooks/github`. `getSession` lists the revisions, and
`SessionRpc.declinePlanRevision` and `SessionRpc.approvePlanRevision` decide them. There is no CLI or
dashboard surface yet.

## What proves it

`./plan-freshness.sh` runs its own API on `PLAN_PORT` (9433 when unset), its own loopback Linear on
`PLAN_LINEAR_PORT` (9434), seeded with a two-issue plan (`LINEAR_FAKE_CHILDREN`), and its own
database, minted and dropped. The API runs with a faux specifier, `FAUX_COST=0.01`,
`PLAN_FRESHNESS=merged` and `PLAN_FRESHNESS_MAX_COST=0.05`. `plan-freshness.ts` signs merged
deliveries as GitHub does and reads through `RpcApi`:

1. One merged delivery files exactly one revision, on the spec's session and not the merged
   session's. It names the spec, shows the plan, and holds an `add` for the uncovered criterion and a
   `close` for the issue no criterion names. Exactly one call (0.01) lands in the spec session's
   ledger.
2. Every table's fingerprint is unchanged except for the spec session's log and activity row, the
   dedupe row (`processed`), and the merged session's own release (LOB-268). No session was opened,
   Linear saw one `issuePlan` read and no write, and the log gained one `factory.planRevisions`
   commit.
3. A redelivery is `replayed`, with no commit, no spend and no Linear request.
4. Declining spends nothing and sends nothing, and approving the declined revision is refused
   `declined`.
5. A second merge's revision, once approved, lands the add (`issueCreate`) and the close
   (`commentCreate` and `issueUpdate`) once each. Approving it again sends nothing.

Below the wire:

- `packages/domain/src/PlanFreshness.test.ts`: every rule, accepted and refused, and all faults at
  once.
- `packages/harness/src/planFreshness.test.ts`: the prompt, one call, the worst case never below the
  spend, and one revision per key in both snapshot paths.
- `packages/core/src/PlanFreshness.test.ts`: a signed merged delivery end to end against Postgres
  and the in-process Linear fake. It covers cadence on and off, a redelivery, the bound, a refused
  answer, decline, and approval, with the fake's write ledger empty until an approval.
- `packages/core/src/LinearSync.test.ts`: the plan read, the re-scope and the close, each once.
- `apps/api/src/Api/GitHubWebhook.test.ts`: the route with the cadence unset, unreadable and on.
- `apps/api/src/Rpc/Session.test.ts`: the errors across the wire.
- `packages/storage-postgres/src/PostgresStorage.test.ts`: the seeded skill.

## What it does not do

- It has no tracker-state-change cadence: only a merge reads the plan.
- It reads the delegating issue's children one page of 250 at a time, and archived children are not
  listed.
- The fakes cannot prove that Linear answers `children { title state description }` as read here, or
  that it accepts `issueUpdate` with `title` and `description` (`docs/testing-third-parties.md`).
- A webhook delivery waits for the pass. A model slower than GitHub's 10-second timeout leaves
  GitHub reporting a timeout while the pass completes. If the connection's close interrupts it, the
  claim is released and a redelivery runs it.
