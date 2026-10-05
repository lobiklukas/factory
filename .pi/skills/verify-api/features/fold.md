# Fold a released session

**Status: passing.** After the owner is released, the same session reads as `historical` with the
same entries, and its stream sends one snapshot and ends.

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
