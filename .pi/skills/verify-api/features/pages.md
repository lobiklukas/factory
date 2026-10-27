# The pages surface: curate, list, rebuild

**Status: passing.** `curateSession` writes a finished session's cited page, `listPages` reads it
back over the real Effect RPC client, a second pass writes nothing for exactly one call's worth of
spend, and the page rows come back from the log after they are deleted (LOB-220, over LOB-204 and
LOB-206).

## What it is

- `listPages({ sessionId })` answers the pages one session holds, by name, from `session_pages` —
  one query, never a fold of the log. An unknown session is `SessionError{not_found}`.
- `curateSession({ sessionId, maxPages? })` is one model call over the session's transcript and the
  pages it already holds; it commits each new proposal as a page (a `factory.page.written` entry and
  the row `listPages` reads), and none when the session already holds what was proposed. The call is
  charged to the curated session whether or not it wrote anything. See [curate.md](curate.md).
- The rows are a cache of the log (D7): `rebuildIndexes` (`packages/core/src/rebuild.ts`) folds the
  `factory.page.written` entries back into `session_pages`.

## How a user reaches it

`SessionRpc.curateSession` and `SessionRpc.listPages`, on the same `/rpc` endpoint as the rest of
the session surface. `rebuildIndexes` has no RPC member and no CLI; it is an operator's recovery
path, run in-process against the database, which is how the driver runs it.

## What proves it

`./pages.sh` — its own API on `PAGES_PORT` (9422 when unset), its faux model priced at a flat
`FAUX_COST=0.01` a call, and `DATABASE_URL` required, because the driver deletes rows and runs a
rebuild. It runs `pages.ts`, a client of `SessionRpc` exactly as the CLI and the dashboard are, that
also holds a SQL connection to the same database:

1. A session sends a message and settles; it lists no pages, and `listPages` on an unknown id is
   `not_found` over the wire.
2. `curateSession` with `maxPages: 1` answers one page (`bash-ran`, derived by the faux from the
   transcript's `bash` result, so it exists only if this session really ran the tool), `proposed`
   at least one, `sources` naming the curated session. The session's spend grows by **exactly one
   call** (`0.01`), and the list's activity row reports the same total as the snapshot.
3. `listPages` answers that page field for field, and the session's log holds one commit carrying
   `factory.page.written`.
4. The same pass again answers `pages: []` with `proposed` still non-zero; `listPages` and the log's
   page-entry count are unchanged, and the spend grows by exactly one call again — not zero (a pass
   that skipped its call or forgot its charge) and not two.
5. The session's `session_pages` rows are deleted: `listPages` answers nothing, which shows it reads
   the rows. `rebuildIndexes` then refolds the log and `listPages` answers the same page, and the
   log still holds one page entry (a rebuild writes no log).
6. A third pass, whose dedupe now reads the rebuilt rows, still writes nothing, for one call.

The script then checks that one API process served the whole drive, and counts the session's
`session_pages` rows itself with a third reader (`Bun.SQL`): one.

Why a second drive rather than more checks in `drive.ts`: that driver's instance runs the free faux,
so "one call's worth" has no unit there (its repeat check proves `pages: []`, not the spend), and it
holds no database connection, so it cannot reach the rows a rebuild refills.

The mutation runs in `.verify/evidence/lob-220/mutation/` are what make the checks more than
vacuous: with the dedupe in `curate` disabled the repeat answers `pages: [bash-ran]` and the log's
page entries go `1 → 2`; with the charge skipped for a session that already holds pages the repeat
reads `0.03 → 0.03`; with the page fold removed from `rebuildIndexes` the rebuilt list is `[]`. Each
fails `./pages.sh`.

Evidence: `.verify/evidence/latest/api/pages.json` (every check, each curation's answer, the pages
at every step, the spend and the page-entry counts), `pages-process.json` and `pages-api.log`.

## What it does not cover

- **A curation that writes more than one page.** The faux proposes one page per tool the
  transcript shows, and the probe session runs one; the cap and the clamp are unit-tested in
  `packages/harness/src/curate.test.ts` and `packages/core/src/SessionService.test.ts`.
- **The call count itself.** The drive measures one call's _price_; the count is asserted against the
  faux provider's `callCount` in `packages/core/src/SessionService.test.ts`, which a client across
  the wire cannot see. With a flat price per call the two cannot disagree.
- **A busy session refused.** `curateSession` on a running session answers `busy`; the suite proves
  it, and this drive curates only settled sessions.
- **A page reaching the next prompt** (LOB-205). Proven in `packages/core/src/SessionService.test.ts`
  from the committed `pi.system` entry.
