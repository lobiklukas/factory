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
gets **1 page = 1 statement** with 3 rows and with 30, while a per-session fold would grow with the
table. The same suite empties the index (`DELETE FROM sessions`), runs `rebuildIndexes`, and checks
that every list field comes back from the logs — so the table is droppable, per D7.

**What it does not prove.** Nothing measures the list under load, and `rebuildIndexes` has no runtime
caller yet (it is the recovery path, driven by its test). Sessions created before the
`session_activity` migration get their row backfilled from `sessions`, not from their logs, until a
rebuild runs.
