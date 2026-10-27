# Replay a session on another model

**Status: passing.** `replaySession` over the RPC client answers a new session that runs the
source's first prompt on the model it was asked for; the source's transcript is unchanged, and the
replay's own log records the pair and both models. Once the replay's task settles, `getSession`
reports the comparison of the two runs on both sessions (LOB-199), and each log carries it.

## What it is

"Run this task again on another model" (LOB-198). A replay is not a fork: a fork copies a
transcript's prefix and the two logs diverge, while a replay takes only the _task_ — the source's
first user entry — and runs it in a fresh session at the source's repo and base ref. The link
between the two is a `factory.replay` document (`source`, `model`, `from`) committed to the
**replay's** log, never the source's, so replaying a recorded run cannot rewrite it.

The comparison (LOB-199, part 2 of LOB-39) is the one thing a replay adds to its source. When the
replay's prompt settles, the control plane reads both logs and commits a `ReplayComparison` into each
session's `factory.replay` document, keyed by the counterpart: `role`, `at`, `self` and
`counterpart` (session, model, outcome, turns, cost) and `delta` = self minus counterpart, so the
two deltas are exact opposites. The source's document carries only `comparisons` — its link fields
stay empty, so the source never reads as a replay — and its transcript, spend and lineage are
untouched. The snapshot reports them as `replayComparisons`, absent for a session nobody replayed.

What is owed is read off the logs, not held in the process (`reconcileReplay` in
`packages/core/src/SessionService.ts`): a replay whose own document names no comparison of its
source is still owed one. Every owner the API opens and every fold it serves checks, so a replay
whose run crossed a restart or a close is compared when its owner is reopened (which is what resumes
its run), and one whose run settled before the process stopped is compared on its next fold. The
source's side is written first and the replay's last; a pair only the source holds is finished with
the mirror of that side, so both still come from one reading.

A side's `outcome` is the outcome of its first user entry, the task a replay runs. A fork's copied
task has no submission of its own, so its outcome comes from the transcript. Its copied prefix is
reported as `inherited: { from, turns }` and is not counted in `turns` or `cost`, because the parent
paid for it.

Writing the source's side opens an owner of the source, as any write to a released session does.
That re-creates its worktree until the idle sweep releases it again, and it counts as activity, so
the source moves up the session list when its replay is compared.

## How a user reaches it

The `replaySession` RPC (`SessionRpc`, `packages/domain/src/Rpc.ts`) with `{ sessionId, model? }`,
`model` a `provider/modelId` the process serves. No CLI verb or dashboard affordance calls it yet.

## How the skill drives it

`drive.ts`, after the fork block, on the instance `./up.sh` starts. `up.sh` publishes a second faux
model: `ROLE_MODELS=replay-target=faux/faux-2`. The role table is the only lever a deployment has to
put a `faux/<id>` in the faux catalog beside `faux/faux-1` (`apps/api/src/index.ts`), and no session
on this instance runs the `replay-target` role, so the row changes the catalog and nothing else.

1. `createSession` bound to the registered fixture repo at `main`, then `sendMessage("verify-api
probe replay")` and wait for the faux answer to that prompt
2. `replaySession({ sessionId, model: "faux/faux-2" })` (`REPLAY_MODEL` overrides the model, for
   `up.sh` and the drive alike), then
   wait for the replay's own answer
3. `getSession` on both
4. the replay's log read through `PostgresStorage.reader` + `readSessionLog` against the database
   the API writes (`DATABASE_URL`, required; the drive provides `PostgresLive` to this read only, so
   no migrator runs and no other check needs Postgres). No RPC answers the
   `factory.replay` document, so the drive reads it the way `rebuildIndexes` does — a reader never
   owns the log, so it cannot collide with the API that does
5. `getSession` on both until each reports its comparison, then the source's log read the same way
   as the replay's
6. `getSession` on the drive's scratch session, which nobody replays
7. `replaySession` onto `faux/faux-unserved`, and of the drive's scratch session (bound to no repo)

## What proves it

- the answer is a new `ses_…` id at the source's repo, base ref and title, with no `forkedFrom`
- the replay's first user entry is the source's, text for text
- the source's usage is keyed `faux/faux-1` only and the replay's `faux/faux-2` only: each ran on
  its own model, which the faux answer alone could not show (both models answer alike)
- the source's entries after the replay equal its entries before it
- the replay's log holds `{ source: <source id>, model: "faux/faux-2", from: "faux/faux-1" }`
- `getSession` reports one comparison on each side: the source's names the replay on
  `faux/faux-2`, the replay's names the source on `faux/faux-1`, both outcomes `answered`, each
  side's `self` is the other's `counterpart`, and the deltas add to zero
- both logs carry exactly what `getSession` reported, and the source's log has no replay link
- the scratch session, never replayed, reports no `replayComparisons` at all
- both refusals are `SessionError{code: "invalid_input"}` over the wire, and the session list holds
  the same ids after them as before

The checks are not vacuous: with the `ReplayDoc` write removed from
`packages/harness/src/replay.ts` (`const doc = Promise.resolve()`), the drive fails exactly
`the replay's own log records the source and both models` (`replay=null`, 57/58) — the same
mutation fails the unit case `replays the prompt on another model and leaves the source log
untouched` in `packages/core/src/SessionService.test.ts`. Evidence:
`.verify/evidence/lob-215/mutation-no-replay-doc.log`.

## What it does not prove

- **The source's log, commit for commit.** The drive compares the source's transcript before and
  after; the unit case compares its commit count and head in `commits`, which is the stronger claim.
- **A capped source's budget carried to its replay.** `features/budget.md` names it; the unit suite
  covers it.
- **The replay after a rebuild.** The unit case folds the replay's log after its owner is released;
  the drive reads the log while the API still owns it. The comparison after a rebuild is the unit
  case `stores the comparison on both sessions, reports it on either side, and a rebuild reproduces
it` (`packages/core/src/SessionService.test.ts`): it deletes both sessions' rows, runs
  `rebuildIndexes`, and reads the same comparisons back from the folds.
- **A non-zero delta over the wire.** Both faux runs answer the one prompt alike and the faux is
  free, so the drive's deltas are zero and it checks their sum and their mirroring. The unit cases
  make them differ: the source takes a follow-up the replay never runs, and
  `packages/harness/src/replay.test.ts` prices each answer (`fauxCost`) so the costs differ too.
- **A comparison after a restart.** The drive runs one process. The recovery from the logs is the
  unit case `writes the comparison a stopped process left owing, on the next fold, from the logs
alone` (`packages/core/src/SessionService.test.ts`). It replays out of band with every owner
  released, once with neither side written and once with the source's side alone, and then folds
  each replay. The re-armed wait on a reopened owner is the same path every replay's first open takes.
- **A replayed fork.** The unit case `measures a forked source by the task it copied` in
  `packages/harness/src/replay.test.ts` covers it. The drive replays an unforked session.
