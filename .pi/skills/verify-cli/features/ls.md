# `factory ls`

**What it is.** The server's list of sessions, newest activity first (LOB-6). One row per session
with what the derived `session_activity` index carries — id, status, repo, last activity, spend,
the PR link (LOB-65), the model the session is pinned to (LOB-272, `model`, after `pr`, `-` when the
row names none), title — and a `cursor:` line when the server has another page. The `pr` column
is the session's recorded `prUrl`, or `-` when no PR was opened: never an empty cell, so the title
stays the last field and the link is always the sixth.

**How a user reaches it.** `factory ls`, optionally `--limit N --cursor <cursor>`.

**How the skill drives it.** `drive.sh` runs `factory ls --api …` after `factory run`, and asserts
exit 0, a row whose first field is the session id the run minted, the run's title in that row, a
header naming the `pr` and `model` columns, `faux/faux-1` as that row's seventh field, and `-` as that row's sixth field (the run opened no PR).

Then, after both watches, it seeds a session whose log records a PR (`.pi/skills/lib/seed-pr.ts`:
the real `SessionService` and PR step on the API's database and session root, against the loopback
GitHub fake, in a process that exits before `ls` runs) and runs `factory ls` again (`ls-pr.txt`). The
seeded row's sixth field must equal the `prUrl` the seed read back from the session, and the run's
row must still read `-`. The seed binds a fresh repo slug per run, so no two runs share a link.

**What proves it.** The id in the `ls` output was minted by the `run` command in a previous pane, and
`ls` prints nothing but what `listSessions` returned: the CLI has no local registry, so a row can
only come from the server's index.

The session is seeded rather than created through `factory run` because the API this drive starts
has no fake GitHub wired in, so its `openPullRequest` member (LOB-213) would reach no forge. The seed is a caller of the real step, not a write to the
row: the link `ls` prints is the one the step recorded in the log and the index.

**What it does not prove.** Paging against a large table (asserted in `packages/core` by counting
statements, and named as unmeasured under load in `docs/handoff.md`), and the list's cost under a
slow database.
