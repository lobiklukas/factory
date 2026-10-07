# Session list

**What it is.** `listSessions` answers "which sessions exist" from a derived index, newest activity
first, keyset-paged — never by folding a log. LOB-6, `docs/features.md` §3 A2, `docs/design.md` R6.

**How a user reaches it.** `listSessions({ limit?, cursor? })` → `{ sessions, nextCursor? }`. Each
entry carries id, title, repo, base ref, status, `createdAt`, `lastActivityAt`, and `costTotal`. The
cursor comes from the previous page's `nextCursor`; anything else is `invalid_input`.

**How the skill drives it.** `drive.ts` lists right after creating a session and asserts:

- the session it just created is in the list — **without any read of that session**, which is what
  "no poll" means: the index is written when the session is created;
- a list entry carries the repo, a status, a real timestamp, and a spend field;
- the page is ordered newest-activity-first;
- a second page taken with `nextCursor` repeats no row from the first. It is taken one row at a
  time, because the service mints a cursor only when a row beyond the page exists (the query asks
  Postgres for `limit + 1`): a page whose size equals the table's row count carries no cursor, and
  paging from it repeats the page rather than continuing past it. The check asked for two rows per
  page until LOB-140 (2026-10-07) and so failed on a database holding exactly two sessions, where
  the first page covered the table and `nextCursor` was correctly absent.

**What proves it.** The cost claim is the interesting one, and it is asserted where it can be
measured: `packages/core`'s suite counts SQL statements through `Statement.CurrentTransformer` and
gets **1 page = 1 statement** for every page it takes — including over the hundreds of rows the test
writes — while a per-session fold would grow with the table. The loop that pages is bounded by
`count(*)` over `session_activity`, not by a constant, and asserts the positive: every page it took
was one statement, the cursor ran out (rather than the loop hitting its budget), each of
the 280 filler rows the test wrote came back exactly once, and nothing the walk should have had was
left over. A list that stops early, drops a row, or folds a log per session therefore fails the
suite. Verified 2026-10-05 (LOB-93): green on the shared
`factory_ralph` table (292 rows) and on a scratch table seeded with 340 unrelated rows (404–458 rows
during the runs); reverting the bound to the old constant fails it on a table of six rows.
Re-checked the same day after the completeness assertion was added: 4/4 on `factory_ralph` at
312–321 rows, 3/3 on a scratch table of 340–346 rows, 10/10 for the whole file (`recheck-*.log` in
the same evidence directory). Since LOB-96 (2026-10-07) that suite runs against **a database it
creates and drops for the run**, so the row counts above record the runs as they were rather than a
property of the table it points at now, and `describe("this suite's database")`
witnesses the isolation and the literal they share with `DatabaseConfig`. The gate measured 22/22 on
the branch (`11-gate-final.log` in the LOB-96 evidence directory). The same suite also empties
the index (`DELETE FROM sessions`), runs `rebuildIndexes`, and checks that every list field comes
back from the logs — so the table is droppable, per D7, and only ever the run's own table. Since
LOB-134 (2026-10-07) that suite also **sweeps** abandoned `<db>_core_*` databases out of the shared
`pg_database` catalogue before it creates its own: one that is over an hour old by an encoded stamp
in its name and reads zero connections. That is the one way it reaches beyond its own database, and
it is best-effort — the file header states the two leaks it leaves and the one live run it can
misjudge.

**What a walk is, since LOB-135 (2026-10-07).** Completeness used to be asserted as
`entries.length >= count(*)`, which was the wrong instrument and turned the gate red about once in
thirty-five runs with `expected 9 to be greater than or equal to 10` — never reproduced by a rerun.
The cause is not the cursor. It is that `last_activity_at` is the ordering key _and_ a column every
live event rewrites to "now" (`recordActivity` reaches it through `touch`, `setActivityStatus` and
`setActivityCost`). A row below the cursor whose key advances above it leaves the range the walk is
traversing, and `nextCursor` still says the walk finished. Reproduced deterministically on
unmutated code: five rows, one row per page, one `UPDATE` between two pages, and the walk returned
four with all five still in the table. The mirror image is real too — a row whose key moves _back_
below the cursor comes back around, and only `rebuildIndexes` moves a key backwards. Both halves,
with the raw probe output, are in `.verify/evidence/lob-135/01-diagnosis.md`.

The suite therefore asserts `unaccounted(pages) === []`: nothing returned twice, and every row still
below the first page's cursor returned. That is a question with a determinate answer, unlike a count
read before the walk. Two cases stage the two failure modes directly — one moving a key up, one
moving it back down — and a third stages a walk that stops early, because the missing-row half
cannot be staged by any walk on unmutated code. The `count(*)` still bounds the page budget; it no
longer claims to be the walk's answer. **Undecided** is whether a walk should be a snapshot at all:
that needs either a transaction spanning every page (impossible — a walk is a client's loop across
RPCs) or a materialised snapshot id carried in the cursor, and both are a contract decision rather
than a fix. The service's `list` doc comment states the contract as it stands; a follow-up issue
owns the decision.

**What it does not prove.** Nothing measures the list under load, and `rebuildIndexes` has no runtime
caller yet (it is the recovery path, driven by its test). Sessions created before the
`session_activity` migration get their row backfilled from `sessions`, not from their logs, until a
rebuild runs. **A page boundary whose row shares its millisecond with a row that sorts after it no
longer drops that row:** as of LOB-95 (2026-10-06) the cursor is minted from a second, exact column
(`to_char(a.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), so the keyset
comparison runs at the precision the value is stored with. Eight of the nine cases in
`packages/core/src/SessionService.test.ts` that seed same-millisecond groups page with the
service's own cursor and bring the whole group back — including one paged a row at a time, so every
boundary inside a group is covered. The ninth is the exception and asserts the opposite: it pins
what a cursor an _older_ build minted still costs, so that a future hardening of `parseCursor`
reddens it rather than quietly changing what the list returns. Before that fix
the cursor carried the millisecond-rendered `lastActivityAt` while the column was `TIMESTAMPTZ`, so
the tie on the boundary was skipped by the next page; a probe reproduced the skip on 2026-10-05 (two
sessions at the same `…00.123456Z`: the lower id never came back), and the recipe and output are in
`.verify/evidence/lob-93/preexisting-cursor-precision-row-loss.log`.

What is still millisecond-precise is the _displayed_ `lastActivityAt` (unchanged, and unchanged on
purpose: it is the wire shape the schema promises), so the same truncation has a second
manifestation the suite can still hit: the ordering assertion compares the _rendered_
`lastActivityAt`, so two rows that share a millisecond while differing in microseconds order the list
differently than the assertion expects — it goes red when the two orders disagree, which a row the
suite did not write landing in a filler's millisecond could arrange (before LOB-96, a shared row
could). That one reproduces deterministically (two seeded rows at
`…00.100456Z` and `…00.100Z`) and the pre-LOB-93 test file fails it identically
(`recheck-2c-ms-ordering-pair-control.log`); it was also seen live on `factory_ralph`, where a filler
row and a pre-existing row rendered to the same millisecond (`recheck-1-mutation-6-tail-truncation.log`,
first run). The filler rows are distinct at second granularity, which rules out ties among themselves
but not ties with rows the table already held. LOB-100 owns that half, and since LOB-96 the table
is the run's own, so that half needs re-measuring before it is closed.
