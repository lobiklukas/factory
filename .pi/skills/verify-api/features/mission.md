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
  (which is what lets the snapshot attribute it per worker, below). The session's spend is every
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

## Across a kill (LOB-231)

A mission is durable work no client is talking to, so a process that stops in the middle of one
must not leave it for a caller who never comes:

- **The shutdown leaves it pending.** SIGTERM runs `SessionService.close`, which closes each owner's
  harness. Pi Durable keeps an interrupted task `pending` in its log, so the mission's checkpoint is
  still `implement`, its wait still names the same workers, and each worker's checkpoint is the
  phase it was in (`converse` mid-turn, or `check`).
- **The boot resumes it, unasked.** Each session's row carries `mission_in_flight` (migration
  `0029`), mirrored from the live task graph by the owner's activity projection and set by
  `startMission` before the task exists. At boot the API (`MissionResumeDaemon`) calls
  `SessionService.resumeMissions`, which reopens every session the row names under this process's
  session root whose workspace was not released, asks its task graph whether a mission is still
  live, and only then calls `Harness.resume()` on it. The mission continues in the phase it died in: the
  workers rerun their own phase in the conversations they already own — an interrupted tool call is
  answered as interrupted, a prompt is not asked twice (its request id finds the submission) — and
  the join, verify and the result follow as they would have. A row that outlived its mission costs
  one reopen that finds nothing, schedules nothing in that log, and clears it; a released session's
  mark is cleared by the release itself.
- **The idle sweep keeps it.** An owner whose harness has a live mission is not released however
  quiet its conversation is (`missionInFlight`); released, the mission would wait for the next boot.
- **One process per database and session root.** The row is marked with the absolute `SESSION_ROOT`
  of the process running the mission (`mission_session_root`), and a boot resumes only the rows
  marked with its own, so the verify skills' throwaway APIs — the shared development database, roots
  of their own — leave ./up.sh's missions alone. Two processes on one database _and_ one root would
  both own a session's log (there is no presence lease yet, docs/design.md D12), so a second one sets
  `MISSION_RESUME=false`. The restart drive mints a database of its own besides, so the boot's
  "resumed 1" is exactly its mission.

`mission-restart.sh` proves it over the wire: an API with `FAUX_COMMAND="sleep 8 && echo faux-ok"`
holds both workers' conversations on a `bash` call while the mission waits in `implement`; SIGTERM;
with no process running, the row still says a mission is in flight, marked with the script's
session root; a fresh API (faux `echo`) that
the driver only reads from is `live` for the session, the mission's task is `waiting` in
`implement`, its document says `implement` with `entered` `plan,implement`, and it waits on the same
worker tasks in the same conversations. Each worker's check holds on a file the driver writes, so
that is read before the mission can leave `implement`; released, the mission settles in `verify`
with `entered` exactly `plan,implement,verify`, the repo's verify command has left its mark, each
check ran once, and the row is cleared. The same story is in
`packages/harness/src/mission.fanout.test.ts` (a close and a reopen of one log) and
`packages/core/src/SessionService.test.ts` ("a mission across a restart": the boot's resume, a stale
row, the sweep).

## What each worker spent (LOB-194)

The snapshot's `mission.workers` is each worker's own spend, in the order the mission's input named
them: `{id, taskId, conversationId?, usage}`, where `usage` is the six `pi.usage` counters (tokens
and `costTotal`) summed over both buckets, models and tools, of the conversation the worker owns.

- **Read from the log.** The mission's document (`factory.mission`) holds a roster: the fan-out
  writes each worker's id and task in the commit that creates it, and the worker's first commit
  writes the conversation it created. The snapshot prices each entry from that conversation's
  `pi.usage`, so the live read, the fold of a released session and a second process after a restart
  all read the same ledgers. A document written before the roster existed reads as no workers.
- **Zero, not absent.** A worker that spent nothing — aborted mid-request, or read between the
  fan-out and its first commit, when it has no `conversationId` yet — is listed with zero counters.
- **It reconciles.** The workers' `costTotal`s plus what the session's root conversation spent is
  the session's `usage` total (the list's `costTotal`), because `Harness.usage()` and the fold sum
  every conversation. A mission that fanned out to none has no `workers` field.
- **Read when the snapshot is.** The stream's `usage` events carry the session total; a client that
  wants the breakdown re-reads the snapshot, as it does for a phase change.

`mission-cost.sh` proves it on the wire against a priced faux (a cent a request, two requests a
worker): two workers at two cents each, summing to the session's `usage` and the list's `costTotal`
(an index row the snapshot does not feed); the fold of the released session reports the identical
breakdown; and a second API process, started after the first was stopped, reports it again. A
worker-less mission reports none. That workers' costs _differ_, that a worker that ran nothing is
listed at zero, and that a read between fan-out and open lists the worker without a conversation
are proven in `packages/harness/src/mission.cost.test.ts`, against `pi.usage` read off the harness
and the faux provider's own request count rather than against the snapshot.

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

- **Resume across a kill.** `drive.ts` proves the id and the phase; the recovery is
  `mission-restart.sh`'s (above).
- **What the phases do.** Plan is a checkpoint; implement fans out to workers when the mission names
  some (above) and is a checkpoint otherwise; verify runs the repo's own `verify` command. Each
  worker shares the session's one workspace — a worktree per worker is not part of this.
- **A successful verify.** The drive's session is a scratch session with no `.factory/config`, so its
  mission reaches verify and settles `failed` there — "the repo declares no verify command". That is
  the honest end for a directory that cannot verify itself; the passing-verify path is proven in
  `packages/harness/src/mission.test.ts`.
- **Two missions in one session.** Each mission keeps its own document, but the binding names only
  the current one, and starting a second mission in one session is not driven here.
