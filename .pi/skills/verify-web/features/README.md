# Feature map — web dashboard

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive
it with the harness, and what observable end state proves it works.

Status reflects the last verified run (2026-10-06, `chrome`, headless, ports 9100/3100).

| Feature                 | Status  | File                                       |
| ----------------------- | ------- | ------------------------------------------ |
| Dashboard shell renders | passing | [dashboard-shell.md](dashboard-shell.md)   |
| Browser reaches the API | passing | [api-connectivity.md](api-connectivity.md) |
| Session stream card     | passing | [session-stream.md](session-stream.md)     |

## Known gaps

- The session API is covered here only through the dashboard. Its contract is proven by
  `.pi/skills/verify-api`, which drives the real Effect RPC client directly; neither replaces the
  other, and a change to `packages/domain` or `packages/core` deserves both.
- `apps/cli` has no subcommands, so there is nothing to drive yet.
- The dashboard has no case for a **historical** read. `SESSION_IDLE_TIMEOUT_MS` is deliberately long
  in `up.sh` so the card stays live; the fold path is proven by verify-api instead. M5 owns the
  session list, which is where a historical read becomes a normal thing to see.
- The browser path needs Postgres (`docker compose up -d --wait postgres`); sessions are logs, and
  the log is Postgres.
- Isolation is not verifiable locally at all. See `docs/design.md` R2 — kind cannot run gVisor,
  so never cite a local run as evidence that sandboxing works.
