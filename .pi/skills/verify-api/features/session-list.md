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
- a second page taken with `nextCursor` repeats no row from the first.

**What proves it.** The cost claim is the interesting one, and it is asserted where it can be
measured: `packages/core`'s suite counts SQL statements through `Statement.CurrentTransformer` and
gets **1 page = 1 statement** for every page it takes — including over the hundreds of rows the test
writes and the extra rows the shared database already holds — while a per-session fold would grow
with the table. The loop that pages is bounded by `count(*)` over `session_activity`, not by a
constant, and asserts the positive: every page it took was one statement, the cursor ran out (rather
than the loop hitting its budget), every row the count says the list can see came back — that count
is the exact listable set, because `session_activity.session_id` is the primary key — and each of
the 280 filler rows the test wrote came back exactly once. A list that stops early, drops a row, or
folds a log per session therefore fails the suite. Verified 2026-10-05 (LOB-93): green on the shared
`factory_ralph` table (292 rows) and on a scratch table seeded with 340 unrelated rows (404–458 rows
during the runs); reverting the bound to the old constant fails it on a table of six rows.
Re-checked the same day after the completeness assertion was added: 4/4 on `factory_ralph` at
312–321 rows, 3/3 on a scratch table of 340–346 rows, 10/10 for the whole file (`recheck-*.log` in
the same evidence directory). The same suite also empties the index (`DELETE FROM sessions`), runs
`rebuildIndexes`, and checks that every list field comes back from the logs — so the table is
droppable, per D7.

**What it does not prove.** Nothing measures the list under load, and `rebuildIndexes` has no runtime
caller yet (it is the recovery path, driven by its test). Sessions created before the
`session_activity` migration get their row backfilled from `sessions`, not from their logs, until a
rebuild runs. **A page boundary whose row shares its millisecond with a row that sorts after it is
red rather than green:** the cursor carries `lastActivityAt` at millisecond resolution (`to_char(…
'MS')`) while the column is `TIMESTAMPTZ`, so the tie that falls on the boundary is skipped by the
next page's keyset comparison — and the completeness assertion above catches the missing row (before
LOB-93 the suite could not see it at all). A tie _inside_ one page comes back whole and green, which
is why the probe forced the boundary (`limit: 1`); the boundary is reachable in this suite because
the shared table decides where the page edges land. A probe reproduced the skip on 2026-10-05 (two
sessions at the same `…00.123456Z`: the lower id never comes back), and the same truncation makes the
rendered-`lastActivityAt` ordering assertion above red when a shared row lands in a filler's
millisecond; the recipe and output are in
`.verify/evidence/lob-93/preexisting-cursor-precision-row-loss.log`.
The filler rows are distinct at second granularity, which rules out ties among themselves but not
ties with rows the shared table already holds, and the same truncation has a second manifestation
the suite does not survive either: the ordering assertion compares the _rendered_ `lastActivityAt`,
so two rows that share a millisecond while differing in microseconds order the list differently than
the assertion expects. That one reproduces deterministically (two seeded rows at `…00.100456Z` and
`…00.100Z`) and the pre-LOB-93 test file fails it identically (`recheck-2c-ms-ordering-pair-control.log`);
it was also seen live on `factory_ralph`, where a filler row and a pre-existing row rendered to the
same millisecond (`recheck-1-mutation-6-tail-truncation.log`, first run). Both belong to the same
API-side gap — the list's `lastActivityAt` and its cursor are only millisecond-precise — and a
test-side change can only tolerate that, not remove it. Fixing the cursor belongs to
`SessionService.ts`, not to this test. Reported as a separate defect.
