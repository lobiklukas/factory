# A long session's history

**Status: passing** (2026-10-28, `agent/LOB-243` worktree, `./history.sh` on `:9531`, faux,
Postgres on 5442): **17/17**, evidence `.verify/evidence/lob-243/api/`.

## What it is

A historical read costs what it shows, not the log's length (LOB-243, design R6). Once nobody owns a
session, `getSession` (and a historical `watchSession`'s one snapshot) carries the newest
`HISTORY_WINDOW` (200) transcript entries, and `earlier` names the oldest of them when the log holds
more. `readSessionHistory({ sessionId, before, limit })` pages back from there, one page per call (at
most 500 entries), each answering its own `earlier` until the first entry is reached. A live
snapshot still carries the whole transcript and no `earlier`.

## How a user reaches it

The dashboard's **Show earlier entries** above a long historical transcript
([verify-web history](../../verify-web/features/history.md)); `factory watch` prints
`[earlier] entries before <id> are not shown; factory history <session> --before <id> prints them`
above the window, and `factory history <session> --before <id> [--limit n] [--all]` prints one page
before that entry, or with `--all` every entry back to the first.

## What proves it

`./history.sh` owns its own API with a 4 s idle timeout, grows one session past the window with faux
turns, waits read-free for the owner to go, then:

- `getSession` reads `historical`, carries exactly 200 entries, `earlier` is the first of them, and
  they are the tail of the transcript the live read carried; the stream's one snapshot agrees
- paging back with `limit: 50` keeps every page within its limit and ends with no `earlier`; the
  pages and the window join into the live transcript, ids strictly increasing, every turn's message
  exactly once and in order
- a `before` that is not an entry id is `invalid_input`; an unknown session is `not_found`
- `factory watch` on the session prints `mode: historical` and the `[earlier]` line naming the window's
  first entry and the `factory history` command that prints the rest
- `factory history <session> --before <earlier> --all` exits 0 with no `[earlier]` line, and its
  lines followed by `watch`'s carry every turn's message once, in order

The cost half — entries touched does not grow with the log — is asserted in
`packages/harness/src/history.test.ts` and measured by
`packages/harness/scripts/bench-historical-read.ts`.
