# A mission: start one, read the phase it reached

**Status: passing.** `startMission` admits one mission — one feature taken through plan, implement
and verify as a single durable Pi Durable task — and answers its id. The phase the mission reached is
read off the session's snapshot, not off a second call (LOB-230, part 2 of LOB-192).

## What it is

- `startMission` (`SessionRpc`) creates one mission in the session's conversation and answers
  `{sessionId, taskId}`. A blank feature is refused with a typed `invalid_input` rather than starting
  a mission about nothing.
- The mission's **phase** is `getSession`'s snapshot field `mission`: `{taskId, phase, entered}`.
  The field is absent for a session that never started a mission, and absent again for a mission
  whose document still holds its seed — "no mission" and "no phase yet" are different facts and the
  wire keeps them apart.
- `entered` is every phase the mission passed through, in order (`plan`, `implement`, `verify`), so
  the snapshot says how the mission got to where it is, not only where it stopped.
- The record is a conversation document, so it survives the mission settling and survives the
  owner being released: the fold reports the same phase the live read did.
- The phase is the one the mission's checkpoint is in, committed with that checkpoint, so a reader
  after a kill is told the phase a resume continues from (LOB-233). Version 1 of the mission wrote
  the phase one behind its checkpoint; both read paths read such a document by the live task's
  checkpoint when there is one, and forward through a version table otherwise (`readMissionDoc` in
  `packages/domain/src/Mission.ts`). The table cannot tell a v1 seed from a v1 plan commit, so a
  folded v1 seed, or a v1 mission that settled before plan ran, reads `implement`. That is proven in
  `packages/harness/src/mission.test.ts` — a mission sampled while it runs, and a v1 log reopened —
  not by this drive, which cannot stop a mission between two of its commits.

## Fan-out and join (LOB-193)

`startMission` takes optional `workers` — `{id, prompt, check?}` each — and an optional `join`
(`failFast`, the default, or `allSettled`). A mission started with workers fans out in implement:

- One **worker task** (`factory.mission.worker`, `packages/harness/src/mission-worker.ts`) per
  worker, owned by the mission task, each opening a **conversation it owns** and asking it the
  worker's prompt; a worker with a `check` then runs it in the session's workspace and passes on
  exit 0. The workers, the mission's wait on them and the mission's document are one commit.
- The mission parks `waiting` on every worker under the join policy and runs no code until all of
  them are terminal; the snapshot's `tasks` shows it (`status: "waiting"`, `waitingOn` the worker
  ids), and each worker with `owner` the mission's id and one `conversations` entry.
- **`failFast`**: the first worker that settles other than `completed` makes Pi Durable abort the
  others; each aborted worker records why on its own outcome ("aborted in check: the worker "a"
  settled failed and the mission joins its workers failFast"). **`allSettled`**: the others finish.
  Either way a failed worker settles the mission `failed` in implement, its `detail` naming every
  worker's outcome, and the mission never reaches verify. All workers completed: on to verify, and
  the result names each worker's task and conversation.
- Worker ids must be non-empty and distinct, and prompts non-empty; the service refuses anything
  else as `invalid_input` before a task exists.
- **A check is policed.** It is a shell command the client supplies, run unattended through the
  execution environment rather than as a tool call, so the policy hooks never see it. The service
  decides every check with the session's own policy for its worktree, exactly as it would decide
  the same `bash` call (D11, D15), before a task exists: a write outside the worktree, egress past
  the allowlist, a push to another branch is refused as `invalid_input` naming the rule, and so is a
  check that would need a person's approval — nobody is there to give it.
- **Worker spend is the session's.** Each worker is charged in its own conversation's `pi.usage`
  (which is what lets LOB-194 attribute it per worker). The session's spend is every
  conversation's: the budget cap (LOB-163) is checked against `Harness.usage()` before every
  request, a worker's included, and a stop aborts the root, whose scope holds the mission and,
  bottom-up, its workers. The snapshot's `usage`, `budget.spent`, the list's `costTotal` (live
  `usage` events are re-read session-wide on every ledger or task-graph change), a fold, a rebuild
  and a fork's carried spend all sum every conversation (`packages/harness/src/budget.test.ts`).

The drive proves it on the wire: two workers held on a file the driver writes are both live, owned
by the mission, with two distinct conversations, and the mission waits on both, `failFast`; released,
the mission enters verify. In a second mission, `b`'s check marks that it started and then beats a
file in the worktree while holding on a file the driver never writes, and `a` exits 1 only once
`b`'s mark exists: the mission settles in `implement` (`entered` `plan,implement`) with no task
left, and `b`'s beat has stopped — its check process was killed, which nothing but the abort could
do. A check that writes outside the worktree is refused `invalid_input` and writes nothing. The
outcomes themselves (the abort reason on the aborted worker, `allSettled` letting `b` finish, the
join reading only once both are terminal) are not on the snapshot and are proven in
`packages/harness/src/mission.fanout.test.ts` from the task graph.

## Why the phase is on the session and not on a group of its own

A mission is not a thing a client holds, it is state of a session. A client that starts one and then
loses the id still has to be able to ask what its session is doing, and the snapshot is where every
other durable fact about a session is read (`live`, `usage`, `tasks`, `approvals`). A `MissionRpc`
group would have made the phase reachable only through an id the client might have dropped. The
decision is recorded in `packages/domain/src/Mission.ts`.

## How a user reaches it

The session RPC group over `/rpc`, so the CLI and the dashboard reach it the same way they reach
every other session call. The phase is read on every `getSession`, and read once at subscribe time
by `watchSession` — the stream does not push a phase change as an event of its own, so a client that
needs the current phase reads the snapshot again rather than waiting on the stream. `listSessions`
does not carry it: the list is the activity index, not a fold.

## What proves it

`drive.ts`, over the real Effect RPC client, on a session of its own:

- A freshly created session's snapshot carries no `mission` at all (not an empty phase).
- `startMission` answers the session and a non-empty `taskId`.
- Polling `getSession` reports `mission.phase === "verify"` with `entered` exactly
  `plan,implement,verify` and `mission.taskId` equal to the id the call answered.
- Once the mission settles it is gone from `tasks` (a settled task is absent from the live-task
  projection) and its phase is still readable — the record is the log's, not the task's.
- After the owner is released, the fold reports the same mission the live read reported.

The run's own evidence is in `.verify/evidence/` under the run's directory; the mission's facts are
in `observed.json` under `mission` (`started`, `live`, `folded`, `tasksWhileRunning`), and the
fan-out's under `missionFanOut` (`joined`, `failFast`).

## What it does not prove

- **Resume across a kill.** A mission that dies mid-phase and is resumed in the phase it died in is
  part 3 (LOB-231). This drive proves the id and the phase, not the recovery.
- **What the phases do.** Plan is a checkpoint; implement fans out to workers when the mission names
  some (above) and is a checkpoint otherwise; verify runs the repo's own `verify` command. Each
  worker shares the session's one workspace — a worktree per worker is not part of this.
- **A successful verify.** The drive's session is a scratch session with no `.factory/config`, so its
  mission reaches verify and settles `failed` there — "the repo declares no verify command". That is
  the honest end for a directory that cannot verify itself; the passing-verify path is proven in
  `packages/harness/src/mission.test.ts`.
- **Two missions in one session.** Each mission keeps its own document, but the binding names only
  the current one, and starting a second mission in one session is not driven here.
