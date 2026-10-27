# Propose child issues from a spec

**Status: passing.** `proposeDecomposition` reads a session's spec — the one its specifier run
declared with the `spec` tool — and commits proposed child issues as the session's
`factory.proposedIssues` document, readable back through `getSession`. It creates nothing anywhere
else: no tracker issue, no session, no card, no event (LOB-201, part 1 of LOB-43).

## What it is

- `proposeDecomposition({ sessionId })` makes one model call: the `decompose` skill (seeded by
  `0021_seed_decompose_skill.ts`) as its instructions, the session's spec as its input. The answer
  is decoded by `decodeProposedIssues` (`packages/domain/src/Decomposition.ts`) and, when accepted,
  committed as one document. The call's spend is charged to the session's own ledger.
- Each proposal is a title, a goal, a change, acceptance lines, and `blockedBy` — other proposals by
  index, only where the order is real.
- The validator refuses a set with no proposals or more than 20, a blank title, a title another
  proposal has (trimmed, case- and space-insensitive), a proposal with no acceptance line or an
  empty one, a `blockedBy` index no proposal has or the proposal's own, and edges that form a cycle.
  A refusal is `ProposalsRefused` on the wire, naming every fault by proposal index; nothing is
  stored.
- Refused before the call, so the refusal costs nothing: a running session (`busy`), a session with
  no spec, a spec that still declares gaps, a spec with no acceptance criteria (`invalid_input`).
- `getSession`'s snapshot carries the newest set as `proposedIssues`, live and folded; absent when
  the session never decomposed. A second decomposition replaces the first.

## How a user reaches it

`SessionRpc.proposeDecomposition`, on the same `/rpc` endpoint as the rest of the session surface.
No CLI or dashboard surface yet: approving proposals into tracker issues is LOB-202.

## What proves it

`./decompose.sh` — its own API on `DECOMPOSE_PORT` (9423 when unset), a faux specifier
(`FAUX_SPEC`) whose spec has two criteria and no gaps, and its own database minted on the server
`DATABASE_URL` names and dropped on exit (the drive counts every table's rows, so nothing else may
write them). It runs `decompose.ts`, a client of `RpcApi` exactly as the CLI and the dashboard are,
holding a SQL connection to the drive's database:

1. A scratch session is refused `invalid_input` ("no spec to decompose") and reports no proposals.
2. A card moved into `specifying`, a run started on it: its `spec` call is accepted, and
   `getTaskSpec` answers the faux script's spec with no gaps.
3. `proposeDecomposition` answers one proposal per criterion (the faux derives them from the spec
   in the prompt), each with acceptance lines.
4. `getSession` reports the same set as `proposedIssues`.
5. Every table's row count is unchanged — sessions, activity, tasks, task events, task runs, boards,
   approvals, pages, deliveries, repos, skills, and every other session's commits — no new session
   appears on the list, the card keeps its revision and column, and the session's own log gained
   exactly one commit of `factory.proposedIssues` (beside the call's spend).

The script then checks that one API process served the drive, and counts the document's commits
itself with a third reader (`Bun.SQL`): one.

The refusals are proven below the wire and across it: `packages/domain/src/Decomposition.test.ts`
(every rule, accepted met and refused broken), `packages/harness/src/decompose.test.ts` (a scripted
answer refused, the writer committing nothing), `packages/core/src/SessionService.test.ts`
("proposing child issues from a spec": an empty acceptance list and a duplicate title refused rather
than stored, an HTTP ledger and the write-back left empty, every other table unchanged) and
`apps/api/src/Rpc/Session.test.ts` (`ProposalsRefused` and the no-spec `SessionError` decoded by
the RPC client). Removing the validation from `decodeProposedIssues` fails all four.
