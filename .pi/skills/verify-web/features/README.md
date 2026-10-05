# Feature map — web dashboard

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive
it with the harness, and what observable end state proves it works.

Status reflects the last verified run (2026-10-06, `chrome`, headless, ports 9100/3100).

| Feature                 | Status  | File                                       |
| ----------------------- | ------- | ------------------------------------------ |
| Dashboard shell renders | passing | [dashboard-shell.md](dashboard-shell.md)   |
| Routing                 | passing | [routing.md](routing.md)                   |
| Browser reaches the API | passing | [api-connectivity.md](api-connectivity.md) |
| Session stream          | passing | [session-stream.md](session-stream.md)     |
| Transcript              | passing | [transcript.md](transcript.md)             |

## Known gaps

- **The session list is browser-local.** `sessionStorage` through `KeyValueStore`, because the
  control plane has no list endpoint (docs/handoff.md task 8). A reload keeps the list; a different
  browser does not have it. The sidebar's empty state says so rather than claiming the account has no
  sessions. `listSessions` has since shipped, so this is one read away from being real.
- **`/sandboxes` and `/approvals` are honest gaps, not features.** No RPC group backs either, so both
  name the milestone (M4, M3) that will. `drive.mjs` asserts the copy, so a table appearing without a
  source behind it fails the run.
- **The rail has no attention count.** The rail is the natural place to say "two cards need a person",
  and the board (LOB-22) is what produces that number. Nothing backs it today, so a badge would be
  fiction.
- The session API is covered here only through the dashboard. Its contract is proven by
  `.pi/skills/verify-api`, which drives the real Effect RPC client directly; neither replaces the
  other, and a change to `packages/domain` or `packages/core` deserves both.
- The dashboard has no case for a **historical** read. `SESSION_IDLE_TIMEOUT_MS` is deliberately long
  in `up.sh` so the pane stays live; the fold path is proven by verify-api instead. The label renders
  either way, so the day a fold is driven the check is the header string.
- **The transcript's follow-the-stream behaviour is not driven.** The faux run finishes too fast to
  observe it; it is checked by hand (see `transcript.md`).
- The browser path needs Postgres (`docker compose up -d --wait postgres`); sessions are logs, and
  the log is Postgres.
- Isolation is not verifiable locally at all. See `docs/design.md` R2 — kind cannot run gVisor,
  so never cite a local run as evidence that sandboxing works.
