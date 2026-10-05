# Feature map — session API

One file per user-facing feature of the session surface. Each answers: what it is, how a user
reaches it, how the skill drives it, and what observable end state proves it works.

Status reflects the last verified run: 2026-10-05, API on `:9200`, `MODEL_BACKEND=faux`,
`bun drive.ts` — 25/25 required checks passed.

| Feature                 | Status  | File                               |
| ----------------------- | ------- | ---------------------------------- |
| Create a session        | passing | [create.md](create.md)             |
| Repo binding            | passing | [repo-binding.md](repo-binding.md) |
| Session list            | passing | [session-list.md](session-list.md) |
| Watch a live session    | passing | [live-stream.md](live-stream.md)   |
| Fold a released session | passing | [fold.md](fold.md)                 |
| Request limits          | passing | [limits.md](limits.md)             |
| Errors over the wire    | passing | [errors.md](errors.md)             |

## Deliberately absent

- **A readiness probe.** `/livez` and `/readyz` are LOB-21 and were paused mid-flight; the API
  answers `GET /` today (`up.sh` waits on it).
- **Steering (`whenBusy`) as its own check.** Queueing is Pi Durable's job and is covered by
  `packages/core`'s suite at the service level. The RPC payload carries `whenBusy`; what the drive
  proves here is that a message is admitted and answered.
- **Multi-replica fan-out (D12).** Live streaming is in-process: the replica that owns a session
  streams it. `SessionBus` (`packages/bus`) does not exist yet, so a session owned by another
  process reads as historical here. A second replica is not verifiable until it does.
- **Isolation, sandboxes, worktrees.** Nothing in this surface touches a cluster; sessions run in a
  scratch directory under `SESSION_ROOT` (M6 owns per-session git worktrees).
