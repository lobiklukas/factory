# Approve proposals into tracker issues

**Status: passing.** `approveProposals` takes the indices of a session's proposed child issues a
person accepted and creates only those as Linear issues: children of the issue the session was
delegated from, in its team, with the `blockedBy` edges whose two ends exist. Each created issue's id
is recorded in the session's `factory.proposedIssues` document as Linear answers (LOB-202, part 2 of
LOB-43). It writes no card and no `task_links` row.

## What it is

- `approveProposals({ sessionId, approved })`. One `issueCreate` per approved proposal that has no
  `created` yet, in index order, one request at a time; the answer's id and identifier are committed
  to the document before the next request is sent.
- The parent and the team are the delegating issue's: `issueOfSession` (the session's
  `trigger:linear:<issue>:mapped` request id) names it, and a read of it carries `team { id }` and
  the issue's children. The created issue's `parentId` is the parent's id and its `teamId` the team's.
- Then each `blockedBy` edge whose two ends both have a created id becomes one `issueRelationCreate`
  (`blocks`), over every created proposal, so approving a blocker later creates the edge that was
  waiting for it. An edge is looked up in the blocker's own relations first, so it is never sent twice.
- A created issue carries a marker line in its description (`factory:<session>:proposal:<digest of
the title>`). A retry reads the parent's children before it creates, so an `issueCreate` whose
  acknowledgement was lost — Linear made the issue, the factory never learned its id — is adopted,
  not made again.
- Refused with `ApproveProposalsError` and nothing sent: no proposals (`no_proposals`), an index no
  proposal has (`unknown_proposal`), a process with no `LINEAR_API_KEY` (`no_tracker`), a session no
  Linear issue opened (`no_delegating_issue`). A Linear failure — GraphQL `errors`, `success: false`,
  a timeout, a rate limit that outlasts the sync's retries — is `tracker_failed` naming which
  proposals were already created; the document records them, so the retry creates the rest.

## How a user reaches it

`SessionRpc.approveProposals`, on the same `/rpc` endpoint. No CLI or dashboard surface yet.

## What proves it

`./approve-proposals.sh` — its own API on `APPROVE_PORT` (9425 when unset) with `LINEAR_API_KEY` set
and `LINEAR_API_URL` on its own loopback Linear (`linear-api-fake.ts`, `APPROVE_LINEAR_PORT`, 9426),
a faux specifier and a scripted decomposition (`FAUX_DECOMPOSITION`: three proposals, B blocked by A,
C by A and B), and its own database. `approve-proposals.ts` is a client of `RpcApi` and reads the
fake's ledger file between calls:

1. Proposing sends nothing to Linear.
2. Approving A and C sends exactly two `issueCreate`, each with the parent's team and id, and exactly
   one `issueRelationCreate` (A blocks C). B is not created.
3. Each created id is in `getSession`'s `proposedIssues`; B has none.
4. Approving the same set again sends no write; B is still uncreated.
5. Approving B creates it and the two edges that were waiting.
6. A decomposed session no Linear issue opened is refused `no_delegating_issue`, and the ledger does
   not move.

The shell then counts, from the ledger alone: three `issueCreate` requests, three distinct issues.

Below the wire: `packages/core/src/SessionService.test.ts` ("approving proposals into tracker
issues"), against the in-process Linear fake in `packages/core/src/linearFake.ts` — the ledger
counts, a refused second `issueCreate` halfway (the first recorded, the retry creating only the
rest), `success: false`, a lost acknowledgement the sync's retry heals, a lost acknowledgement it
cannot (typed error, then the next approval adopts the issue), a refused and a lost relation, and
every refusal with an empty ledger; `packages/core/src/LinearSync.test.ts` (`createChild` and
`blocks` by themselves); `packages/domain/src/Decomposition.test.ts` and
`packages/harness/src/decompose.test.ts` (`created` is a stored fact a model's answer cannot claim);
`apps/api/src/Rpc/Session.test.ts` (the error's tag across the wire).

## What the fakes cannot prove

That Linear accepts `issueCreate` with this `teamId` and `parentId` and these relation inputs, that
it validates the team and parent as the fake does not, or that the children render as sub-issues. A
retry can still duplicate when a request outlives its timeout and Linear applies it afterwards, after
the retry's read. The parent's children are read one page of 250, so a parent with more than that
could hide a marker.
