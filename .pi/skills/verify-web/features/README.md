# Feature map — web dashboard

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive
it with the harness, and what observable end state proves it works.

Status reflects the last verified run (2026-10-27, `chrome`, headless, API `:9500` / web `:3500` —
the worktree's port block, not the usual 9100/3100; `drive.mjs` 49/49 required checks passed, from
the `agent/LOB-65` worktree with the human's `factory-postgres-1` holding 5442).

| Feature                  | Status  | File                                       |
| ------------------------ | ------- | ------------------------------------------ |
| Dashboard shell renders  | passing | [dashboard-shell.md](dashboard-shell.md)   |
| Routing                  | passing | [routing.md](routing.md)                   |
| Browser reaches the API  | passing | [api-connectivity.md](api-connectivity.md) |
| Session stream           | passing | [session-stream.md](session-stream.md)     |
| Fork lineage             | passing | [fork-lineage.md](fork-lineage.md)         |
| Transcript               | passing | [transcript.md](transcript.md)             |
| Live tasks               | passing | [live-tasks.md](live-tasks.md)             |
| Compaction from the pane | passing | [compaction.md](compaction.md)             |
| The session's PR link    | passing | [pr-link.md](pr-link.md)                   |

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
- **A compaction's spend is a delta between two readings of the session's usage**, not a number the
  server attributed to the action. It is bound to the first summary after the press and frozen once
  measured, so a compaction this pane did not press — the harness's own threshold policy, or a second
  summary the same press did not write — shows no spend. See [compaction.md](compaction.md).
- **"Nothing to compact" is read from the live-task list, not answered by the RPC.**
  `compactSession` cannot say that nothing happened, so the pane watches the task it admitted leave
  the session's task projection and only then reads the transcript; a verdict stays until the next
  press or the operator's next turn. A press can only be made on an idle session, so the pending
  state it proves is a live compaction task, not a live run. See [compaction.md](compaction.md).
- **The transcript's follow-the-stream behaviour is not driven.** The faux run finishes too fast to
  observe it; it is checked by hand (see `transcript.md`).
- The browser path needs Postgres on host port 5442; sessions are logs, and the log is Postgres.
  `./up.sh` asks the port first and only starts one when nothing answers, so it runs from a ralph
  worktree while another project's container holds 5442 (LOB-57).
- Isolation is not verifiable locally at all. See `docs/design.md` R2 — kind cannot run gVisor,
  so never cite a local run as evidence that sandboxing works.
