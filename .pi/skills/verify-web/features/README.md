# Feature map — web dashboard

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive
it with the harness, and what observable end state proves it works.

Status reflects the last verified run (2026-10-05, `chrome`, headless, ports 9100/3100).

| Feature                 | Status            | File                                       |
| ----------------------- | ----------------- | ------------------------------------------ |
| Dashboard shell renders | passing           | [dashboard-shell.md](dashboard-shell.md)   |
| Browser reaches the API | passing           | [api-connectivity.md](api-connectivity.md) |
| Streaming RPC card      | **known failure** | [rpc-stream.md](rpc-stream.md)             |

## Known gaps

- `apps/api` is covered only through the dashboard. Its HTTP API group has one endpoint
  (`GET /`) and `/rpc` responds 500 to a malformed body, which is a mounting check rather than
  a proof. When session endpoints land, add feature files for them and drive the RPC stream
  through the real Effect client rather than the demo card.
- `apps/cli` has no subcommands, so there is nothing to drive yet.
- Nothing verifies the Postgres package or the harness. `packages/storage-postgres` has
  migrations and a health check but nothing drives them; `packages/harness` has a disposable
  M0 spike (`bun run m0`) that needs `ANTHROPIC_API_KEY` and a live model.
- Isolation is not verifiable locally at all. See `docs/design.md` R2 — kind cannot run gVisor,
  so never cite a local run as evidence that sandboxing works.
