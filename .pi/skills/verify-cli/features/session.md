# `factory fork`, `reset`, `compact` and `spend`

**What it is.** The session controls the dashboard has, from a terminal (C15). Each is one RPC
(`forkSession`, `resetSession`, `compactSession`, `listSpend`) and a line a script can read; none
follows the session, and `factory watch` shows the effect.

| Command                                     | Prints                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `factory fork <id> [--at <entry>]`          | `fork <child> of <id>` (and `at entry <entry>`): the child's id is the first `ses_…` |
| `factory reset <id> [--note <handoff>]`     | `reset <id> marker <entry>`, then `[reset] <handoff>` when there is one              |
| `factory compact <id> [--instructions <…>]` | `[compaction] <summary>`, or `nothing to compact`                                    |
| `factory spend [--repo o/n] [--actor x]`    | a `repo  actor  sessions  cost` table, then `total  <n> sessions  $<cost>`           |

**Outcomes a script branches on.** An unknown id is `error: not_found` and a fork point the parent
does not have is `error: invalid_input`, both with a non-zero exit, like every command. `compact`
waits up to two minutes for the summarizer; past that it is `error: compaction_pending` naming the
task, because the task exists and `factory watch` will show its summary.

**Design notes.**

- `--note` is the RPC's `handoff`. The marker is read back as the `reset` entry the session did not
  have before the call, so the line names the entry the transcript shows. A reset admitted into a
  running session has no marker yet (Pi Durable places it at the run's next boundary), and says so.
- `compactSession` answers a task id only, and a transcript with no cut settles the task without a
  summary. The command therefore waits on the same two signals the dashboard does: a new
  `compaction` entry, or the task leaving the live task list. "Nothing" must hold on two reads in a
  row, because a busy session's summary can trail the task.
- `listSpend` takes no filter, so `--repo` and `--actor` choose rows of its answer client-side and the
  total line is those rows added. With no filter it is the server's own total. An absent repo or actor
  prints as `-`, as in `factory ls`.

**How the skill drives it.** `./session.sh` owns its own API (`SESSION_PORT`, default `:9380`) with
`FAUX_COST=0.01` and a registered checkout. In tmux it runs a repo-bound session, forks it (whole,
`--at` its first entry, `--at` a nonexistent entry), resets it with and without a note, runs a scratch
session with a 90k-character first message and compacts it, compacts the short fork, and reads
`spend` against `factory ls`.

**What proves it.** Things only a real call produces: the fork's transcript carries `[user] fork
probe` and its answer while the `--at` fork holds the user entry alone; the reset marker is the id of
a `reset` entry read back over the RPC, and `watch` lists it after the answer it follows; the long
session gains a `compaction` entry while the short one gains none and prints `nothing to compact`;
and the spend total equals the session count and cost `factory ls` lists, narrowed correctly by each
filter.

**What it does not prove.** A reset or compaction admitted into a _running_ session (the marker and
summary land at the next boundary): `resetLines` and `compactionVerdict` are unit-tested in
`apps/cli/src/commands/sessionControl.test.ts`, and the RPC side is `verify-api`'s reset and compact
features.
