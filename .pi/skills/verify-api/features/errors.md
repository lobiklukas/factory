# Errors over the wire

**Status: passing.** A request for an unknown session fails with a decoded `SessionError` whose
`code` is `not_found`.

## What it is

`SessionError` is a schema-backed tagged error (`packages/domain/Session`), so it survives encoding
at the server, transport, and decoding at the client: callers branch on `code`, not on message text.
The codes are `not_found`, `busy`, `storage`, and `harness`.

- `not_found` — no such session, or a `sessions` row that does not exist
- `busy` — the session is running and the caller asked for `whenBusy: "reject"`
- `storage` — the log could not be read or appended
- `harness` — Pi Durable rejected the operation, or the session's working directory could not be made

## How a user reaches it

A stale session id: a CLI invocation against a session that was never created, or a dashboard link
to a session someone else deleted (there is no delete yet — the log is append-only).

## What proves it

- `getSession` with `ses_00000000000000000000000000` fails (it does not return an empty session)
- the failure decodes as `SessionError`, not as a transport error or a raw string
- `code` is `not_found`

## Gotchas

- `watchSession` is a streaming RPC, so it declares its error type inside the stream: a mid-stream
  failure arrives as a stream error, not as a failed call. The `code` is the same.
- Do not match on `message`: it carries the underlying failure's text for a human, and it changes.
