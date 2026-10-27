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
  the phase one behind its checkpoint; both read paths read such a document forward
  (`readMissionDoc` in `packages/domain/src/Mission.ts`). That is proven in
  `packages/harness/src/mission.test.ts` — a mission sampled while it runs, and a v1 log reopened —
  not by this drive, which cannot stop a mission between two of its commits.

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
in `observed.json` under `mission` (`started`, `live`, `folded`, `tasksWhileRunning`).

## What it does not prove

- **Resume across a kill.** A mission that dies mid-phase and is resumed in the phase it died in is
  part 3 (LOB-231). This drive proves the id and the phase, not the recovery.
- **What the phases do.** Plan and implement are checkpoints in this part; verify runs the repo's own
  `verify` command. A feature's real work in each phase is part 3's and the later parts'.
- **A successful verify.** The drive's session is a scratch session with no `.factory/config`, so its
  mission reaches verify and settles `failed` there — "the repo declares no verify command". That is
  the honest end for a directory that cannot verify itself; the passing-verify path is proven in
  `packages/harness/src/mission.test.ts`.
- **Two missions in one session.** Each mission keeps its own document, but the binding names only
  the current one, and starting a second mission in one session is not driven here.
