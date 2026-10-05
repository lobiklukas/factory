# `tools/motel` — the isolated motel install

`@kitlangton/motel` is the local OpenTelemetry ingest server and TUI this repo debugs
against: https://github.com/kitlangton/motel. The apps and CLI write OTLP logs and
traces to it (`MOTEL_URL`), and this is the reader for them.

Run it from the repo root:

```sh
bun run motel          # the TUI
bun run motel:start    # headless daemon — what agents and scripts use
bun run motel:status   # JSON status
bun run motel:stop     # stops the shared machine-wide daemon
```

`motel:start` is the one to reach for when you are not driving a terminal: the TUI is
interactive and would block. The daemon is machine-global
(`${XDG_STATE_HOME:-~/.local/state}/motel/`) and shared across local projects, so one
`motel:start` serves every checkout.

## Why this is its own package

Because the two `package.json`s cannot share a dependency graph.

motel pins `effect@4.0.0-beta.90`. The repo pins `effect@4.0.0`. Making motel a
workspace member would put an effect beta in the tree of apps that run strict types
with `denyWarnings: true`, and the `overrides` entry that keeps
`@effect/platform-node-shared` on the stable line here would break motel's own copy.
So this directory installs outside the workspace, and root `prepare` installs it from
the committed lockfile.

## The `@effect/platform-node-shared` pin

Not a preference — a broken dependency graph without it.

motel's `effect@4.0.0-beta.90` has no `./net` export, but a bare `bunx
@kitlangton/motel` resolves `@effect/platform-node-shared` to `4.0.1`, which imports
`effect/net/NetAddress`. The daemon dies on startup with:

```
Cannot find module 'effect/net/NetAddress' from .../@effect/platform-node-shared/dist/NodeSocketServer.js
```

Pinning `@effect/platform-node-shared` to the same `4.0.0-beta.90` as motel's effect
makes the pair self-consistent and the daemon starts. It will need to move whenever
motel itself moves off the beta line; bump both in the same commit.

## Editing

`bun install` inside this directory to change it; keep `bun.lock` committed. Nothing
under `tools/` is a workspace, so nothing here reaches `apps/*` or `packages/*`.
