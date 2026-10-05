# `factory ls`

**What it is.** The server's list of sessions, newest activity first (LOB-6). One row per session
with what the derived `session_activity` index carries — id, status, repo, last activity, spend,
title — and a `cursor:` line when the server has another page.

**How a user reaches it.** `factory ls`, optionally `--limit N --cursor <cursor>`.

**How the skill drives it.** `drive.sh` runs `factory ls --api …` after `factory run`, and asserts
exit 0, a row whose first field is the session id the run minted, and the run's title in that row.

**What proves it.** The id in the `ls` output was minted by the `run` command in a previous pane, and
`ls` prints nothing but what `listSessions` returned: the CLI has no local registry, so a row can
only come from the server's index.

**What it does not prove.** Paging against a large table (asserted in `packages/core` by counting
statements, and named as unmeasured under load in `docs/handoff.md`), and the list's cost under a
slow database.
