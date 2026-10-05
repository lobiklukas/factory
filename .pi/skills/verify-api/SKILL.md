---
name: verify-api
description: Drive and prove the factory session API (apps/api + packages/core) with the real Effect RPC client. Use when asked to verify, test, or show evidence that sessions, session streaming, or the RPC surface work, or after changing packages/domain, packages/core, apps/api, or packages/harness.
---

# Verify the session API

Proves the session surface by driving it with **the same Effect RPC client a CLI or the dashboard
uses**. `curl` proves a route is mounted and nothing else: it cannot tell you that a stream lost its
last event, that a tagged error crossed the wire, or that both ends agree on a schema. Unit tests
in `packages/core` cover policy; this skill covers the contract over HTTP.

The driver is a client, not a browser. The browser path is `.pi/skills/verify-web`.

## What it proves

| Feature                      | Check in the driver                               | Why it matters                                  |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Create a session (D7)        | `createSession`, and a retried `requestId`        | one log per session; retries must not leak logs |
| Send a message               | `sendMessage` → `placement: run`, title set       | a message admits durably and names the session  |
| Watch a live session (D8)    | snapshot first, then entries, then run state      | the UI's live path, including `busy → idle`     |
| Read the transcript          | `getSession` → the `bash` tool result             | the run really happened, usage is attributed    |
| Fold a released session (D8) | the same session reads `historical`, same entries | a paused session is served by folding the log   |
| A fold's stream ends         | exactly one `snapshot` event                      | complete is distinguishable from dropped        |
| Typed errors over the wire   | unknown id → `SessionError{code: "not_found"}`    | callers can branch on `code`, not on text       |
| Interrupt wakes, then stops  | `interruptSession` → idle                         | steering wakes a session before acting on it    |

Every check is required: the driver exits non-zero when one fails.

## Launch

Run on an isolated port so it never competes with a dev server, and with the faux model backend so
the run is offline, deterministic, and free.

```sh
./up.sh          # api on :9200, pid in .verify/run/, model backend faux
./down.sh        # stops only what up.sh started
```

`up.sh` needs Postgres (`docker compose up -d --wait postgres`); the session log _is_ Postgres, so
without it there is nothing worth driving. It waits for `GET /` and fails loudly with the log path
(`.verify/run/api.log`).

Two settings in `up.sh` exist for the sake of proof, not for production:

- `MODEL_BACKEND=faux` — pi-ai's scripted provider. The session runs a real `bash` tool call and the
  answer is derived from that tool's output, so the tool path is real; the _model_ is not. A drive
  run must never depend on a key, a network, or a model's mood.
- `SESSION_IDLE_TIMEOUT_MS=2000` — so a drive run can reach the historical-fold read path. At the
  deployment default (15 minutes) you would wait 15 minutes to prove D8's other half.

## Doctor

```sh
./doctor.sh      # read-only; exits non-zero when the instance is not worth driving
```

Checks the recorded pid is alive, that the port is owned by _that_ pid, and that the API answers.
Run it whenever anything looks off — do not trust a drive run against an instance that fails it.

## Drive

```sh
bun drive.ts     # requires the instance from ./up.sh
```

Environment: `API_URL` (default `http://localhost:9200`), `EVIDENCE_DIR`.

The driver runs in two phases and needs no restart in between: it drives a session while the API
owns it, then waits (read-free — a read counts as use and keeps the owner open) for the idle sweep
to release the owner, and reads the same session again as a fold. That is D8's live/historical pair
proven on one session id.

## Evidence

Written to `.verify/evidence/latest/` (override with `EVIDENCE_DIR`), gitignored. Note that
`.pi/skills/verify-web` writes to the same directory: the last drive run wins, so run them in the
order you want the evidence to end in.

- `observed.json` — every check with its detail, the stream's event log, the transcript, the session
  id, and the API URL
- `session.txt` — the transcript as text, for reading

Proof standards for this app:

- **Drive the real client.** The driver imports `SessionRpc` from `packages/domain`, builds the same
  `RpcClient` the dashboard builds, and speaks the same NDJSON protocol. If a schema, a stream
  declaration, or an error type is wrong, this fails and curl would not.
- **Attach before you act.** The live-stream check subscribes _before_ `sendMessage`, so the first
  event is the state before the message and every later event is a genuine delta. Subscribing after
  the work is done proves nothing about streaming.
- **Name what proves it.** The faux answer is derived from the `bash` tool's output and echoes the
  prompt (`faux-ok (re: verify-api probe)`), so the transcript text can only exist if the tool really
  ran in this session.
- **Compare the two read paths.** The fold check compares the folded entries to the live ones it
  replaced. Two code paths, one session, and a mismatch is exactly the bug D8 is about.
- **A green unit test is not evidence for this surface.** `packages/core`'s suite calls the service
  in-process. It cannot see a lost stream event or a schema mismatch across the wire.

## Cleanup

```sh
./down.sh        # kills only the recorded pid, removes .verify/run/
```

Never kill by process name. Cleanup does not touch `.verify/evidence/` and does not delete session
logs from Postgres — the session rows and commits are append-only history, and re-running the drive
just mints new ids.

## Gotchas

- **The RPC stream's error channel is its own thing.** `watchSession` is declared `stream: true`, so
  its failures arrive as stream errors, not connection errors. A client that ignores the stream's
  error channel sees a truncated transcript and no reason.
- **`sendMessage` returns before the answer exists.** It admits the message durably (that is the
  point) and the answer arrives on the stream. Waiting for the answer means watching the stream or
  polling `getSession` until `live.busy` is false.
- **Idle owners are released, not paged out.** A session owned by this process streams from memory;
  once released, the next read folds the log. If a check expects `mode: "live"` and gets
  `"historical"`, something touched the idle timeout — check `SESSION_IDLE_TIMEOUT_MS`.
- **Two owners of one log is a footgun, not a race.** Pi Durable allows one owner per log, and a
  second owner's append collides and poisons that instance. The controller is `SessionService`'s
  acquisition gate; do not open a `PostgresStorage` in owner mode yourself while the API is running.
- `apps/cli` has no subcommands yet, so nothing there is driven here.

## Feature map

Start at `features/README.md`.
