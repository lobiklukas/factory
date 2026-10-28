# Fold a released session — and follow one owned elsewhere

**Status: passing.** After the owner is released, the same session reads as `historical` with the
same entries, and its stream sends one snapshot and ends. While _another process_ owns it, the same
session reads as `live` and its stream follows the log until that ownership ends (LOB-18,
`follow.sh`).

## What it is

The other half of D8: when nobody in this process owns the session — the sandbox is paused or gone —
the control plane serves it by folding the log through a reader-mode `Storage`. No `Harness` is
opened, because Pi Durable allows exactly one owner per log.

Two things make this observable rather than theoretical:

- Every read reports its `mode`, so a fold can never be mistaken for a live read.
- A historical stream **ends** after its snapshot. A completed fold and a dropped connection are
  different outcomes and a client can tell them apart.

The owner is released two ways: explicitly (`SessionService.close`, which a paused sandbox is the
real-world version of) and by the idle sweep, when nothing has touched the session for
`SESSION_IDLE_TIMEOUT_MS`. The drive run proves the second, since it is reachable through the API.

## How a user reaches it

Open a session the API is no longer running: a dashboard reload after the idle timeout, or a CLI
read of an old session.

## What proves it

- after idling (read-free, because a read counts as use) the same `getSession` returns
  `mode: "historical"`, `status: "idle"`, and an empty `live`
- its entries equal the live entries it replaced, entry for entry — the two read paths agree
- `watchSession` on it yields exactly one event, a `snapshot` with `mode: "historical"`, and the
  stream ends
- sending again wakes it: the owner reopens, `mode` returns to `live`, and the transcript continues
  rather than starting over

## The third branch: a session another process owns (LOB-18)

D8 has three read paths, decided in this order, and the fold contract is the third's floor:

1. **This process owns it** (its registry holds the harness): stream from the harness, `live`.
2. **Another process owns it** (a live presence lease in `leases`, `kind = 'session'`, held by
   another holder): follow the log, `live`.
3. **Nobody owns it**: fold once, `historical`, one snapshot, then the stream ends.

Every owner holds a presence lease on its session, taken under the owners' gate before the log is
opened, renewed every third of its TTL (`SessionServiceOptions.presence.ttlMs`, 30 s by default),
and dropped when the owner is released — after the harness is closed, so whoever takes it next never
finds this process still committing. A process that dies stops renewing, and after the TTL its lease
is anybody's. A live lease whose holder shares this process's home — the same host and session root,
where the session's worktree is — is taken back at once: that is the process this one replaced (a
SIGKILL, a crash), and its run, mission or parked approval should not wait out a TTL for it.

The home is `hostname():sessionRoot`, so that takeover needs a hostname that survives the restart.
Where it does not — a recreated container, a Kubernetes Deployment pod — the boot's `resumeRuns` and
`resumeMissions` are refused `owned_elsewhere` for every session the dead process held, log that
they could not resume, and do not retry once its leases lapse: those runs wait until a client
touches the session (or the next boot). A stable home (a StatefulSet's pod name, a fixed hostname)
keeps boot recovery; a delayed retry of the refused resumes is a follow-up on LOB-18.

Every acquisition is a claim of its own, under the next fence — the same process claiming a session
again after closing it included — so a release or renewal still in flight for an owner this process
already let go names the old fence and cannot drop or extend the new owner's claim. A claim is
renewed from the moment it is taken, while the owner is still opening, not only once it is
registered. An owner released because its claim was lost writes neither the list's `idle` nor a
release: the session is the new holder's, and so is its status.

A followed stream is the fold's snapshot with what the log says is happening now — `mode: "live"`,
`status` and `live` from `pi.live`, `queued` from `pi.inbox`, the session's spend, and the live tasks
from the log's task records — then one batch of events per read, in a live stream's order: entries
(with `prOpened` beside its entry), `queued`, `live` and `status`, `usage`, `tasks`. It reads when the
commit bus hints (migration 0035's `AFTER INSERT` trigger on `commits` notifies `factory_commits`
with a cursor, `{log_id, seq}`, never the commit) and on a poll
(`SessionServiceOptions.presence.followPollMs`, 2 s by default) that also asks whether the session is
still owned elsewhere. Once it is not, the stream reads one last time and **ends**, as a fold's does:
the owner closed it, died and its lease lapsed, or handed it to this process. A client then
reattaches and is told which.

The snapshot carries the newest transcript window and `earlier`, as a fold's does; entries after it
are sent once each, by id. A hint is only a hint — one dropped costs a delay until the next poll,
never an event — because each read diffs the log against what the stream last sent.

Work on a session owned elsewhere is refused with `SessionError` code `owned_elsewhere`, naming the
holder: the session reads and streams from anywhere, but takes work where it is owned, or once its
lease lapses (then the next acquisition takes it under the next fence).

### What proves it

`follow.sh` (two API processes over one database, `FOLLOW_OWNER_PORT` / `FOLLOW_FOLLOWER_PORT`):

- the follower's `watchSession` starts with a `live` snapshot though it owns nothing, and its
  `getSession` reads `live`
- `sendMessage` on the follower is refused as `owned_elsewhere`
- a run on the owner reaches the follower entry for entry, each once, with `busy` then `idle`
- SIGTERM on the owner ends the follower's stream; its read is then a `historical` fold of the same
  transcript, and a message to it runs there — the session changed hands and the transcript carries on

`packages/core/src/SessionService.follow.test.ts` covers the same in-process, plus the bus carrying a
commit with the poll a minute away, an owner released when its lease was taken from it, and a dead
holder's lease lapsing (its followers' streams end; the next claim takes fence 2).
`packages/harness/src/follow.test.ts` pins the order of one read: an answer committed with the run's
idle is sent before the idle, however the commit falls between the follower's reads.
