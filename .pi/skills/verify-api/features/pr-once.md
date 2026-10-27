# One PR across a kill (LOB-179)

**What it is.** The session's PR step (`SessionService.openPullRequest` →
`packages/core/src/prStep.ts` → `packages/core/src/pr.ts`) survives a process that dies _between_
its GitHub call and the acknowledgement that records it. The window: GitHub created the PR, the
`factory.pr` document was never committed, so nothing local remembers the link. The retry has no
record to read, asks GitHub again, is refused as a duplicate, and adopts the PR GitHub already has —
one PR, one `prOpened` entry.

**How a user reaches it.** They don't, directly: the step is the control plane opening the PR for a
session. A crash between the call and the commit is the operator's failure mode, not an action.

**How the skill drives it.** `./pr-once.sh` — four phases, each its own process, against a loopback
fake GitHub (`./github-fake.ts`) whose ledger is a file on disk:

1. `MODE=arm` creates a session and calls the step. The fake records the create and never answers it;
   the script `SIGKILL`s the process there (a graceful shutdown could still commit).
2. `MODE=reopen` replays the step for the same session, in a fresh process on the same database and
   session root. It must land on the PR GitHub already has, write the record, and leave exactly one
   PR entry in the log; the repeat inside that process must ask GitHub nothing.
3. `MODE=second` creates a genuinely second session; it must open a second PR, because the guard is
   each session's own log and not a global lock.
4. Every check is a required check: the script exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-179/`: the four phase files, the process checks, and
the fake's ledger — `posts=2` and `pulls=1` after the replay (the killed attempt plus the replay, one
PR), `pulls=2` after the second session.

Since LOB-212 the drive also asserts the step's `outcome` tag, which is the one field that separates
the two paths when the link is identical: the replay's call is `opened` (it went to GitHub and
adopted), its in-process repeat is `already-open` (the log answered it), and the second session's own
first call is `opened` again, because the guard is that session's own `factory.pr` and not a lock.
The tags are recorded with the rest of the observations in each phase file.

**Non-vacuity.** A hand mutation run: with `prStep.ts`'s `recorded ?? …` guard removed, the replay's
repeat posts a second time and the script exits non-zero. Recorded in
`.verify/evidence/lob-179/mutation.md`; the script itself cannot perform that edit.

**What it does not prove.** That GitHub really refuses a duplicate head with 422, that
`GET /pulls?head=owner:branch&base=` is the spelling it accepts, or that the kill lands inside the
call on a slow machine (the fake holds the request open, so it always does here). The request shapes
are asserted in `packages/core/src/pr.test.ts`; the loopback endpoint is only as right as that.

**The diff cap is not this drive's to prove (LOB-227).** Since LOB-227 the step measures the branch
against its base in the session's own worktree and answers `{outcome: "over-cap", limit, cap,
measured}` — no GitHub call, no `factory.pr`, no `pr_url` — when the diff is over the configured
limit. This drive's sessions are bound to a bare slug, so their working directory is a plain
directory rather than a checkout and there is no diff to measure: every answer here is `opened` or
`already-open`, which is why the cap cannot be driven from this script without giving it a real
git worktree. It is covered by `packages/core/src/SessionService.test.ts` ("the diff cap", a real
`git worktree add` and real commits: inside the cap opens one PR; 51 files and 2001 lines are
refused separately on the file and line limits with an empty fake-GitHub ledger; a widened
`prCap` accepts the same diff; a checkout whose base cannot be read is a typed `diffSize` failure
instead of an unmeasured PR) and by `packages/core/src/pr.test.ts` (`parseDiffSize`, and
`diffCapRefusal` against a throwaway checkout, including the case where a plain directory sits
_inside_ a checkout and must measure nothing).

**An unchanged branch opens nothing (LOB-196).** The same measurement answers the smaller question
first: a branch with no file changed against its base answers `{outcome: "no-change"}`, appends one
`factory.pr.no-change` entry to the transcript (`no documentation change: the branch has nothing to
publish against <base>`) and reaches GitHub not at all — no request, no `factory.pr`, no `pr_url`.
That is the ordinary result of a docs run over docs that need no edit, which before this was a typed
422 from GitHub, i.e. a failed run. Nothing is recorded about the answer, so a later run that does
change a file opens its PR rather than reading a sticky "nothing to do". It is covered by
`packages/core/src/SessionService.test.ts` ("an empty diff": two runs on one unchanged checkout both
answer `no-change` with an empty fake-GitHub ledger and one transcript line each, and a file committed
afterwards opens the PR), and dropping the guard turns both cases red.

**Its slug is its own, per run.** `pr-once.sh` binds its sessions to `lobiklukas/factory-pr-once-<run>`
unless `PR_ONCE_REPO` names one. It used to default to `lobiklukas/factory`, which is the slug
`docs-run.sh` registers with a real local checkout: on a database that drive had already run against,
pr-once's sessions were handed that checkout, the branch had nothing to diff, the step answered
`no-change`, and every check failed for a reason unrelated to the one under test. An explicit
`PR_ONCE_REPO` must stay clear of any slug another drive on the same `DATABASE_URL` registered.
