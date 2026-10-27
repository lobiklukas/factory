# Shutdown and recovery

**What it is.** The deployment floor for a run in flight (LOB-21): on `SIGTERM` the process releases
every session owner it holds — `closeHarness` settles the run, the storage is disposed, and the
list's status goes back to idle — so the log is a clean transcript a later process folds and
continues. Nothing is provisioned for it: `BunRuntime.runMain` interrupts the main fiber on
`SIGINT`/`SIGTERM`, which closes the layer scope, and the finalizer registered beside the session
service runs `SessionService.close`. The two log lines it emits are the evidence.

**How a user reaches it.** `kill -TERM <api pid>`, or a cluster scaling a pod down mid-run.

**How the skill drives it.** `./sigterm.sh` owns its own API on `:9400` with
`FAUX_COMMAND="sleep 8 && echo faux-ok"`, so a run is genuinely busy. Its driver arms: create a
session, send a task, wait for `live.busy`, write the id where the orchestrator can find it, and hold
the stream. The orchestrator sends `SIGTERM`, asserts the process exits and both shutdown lines are
in the log, then starts a _fresh_ API and runs the verify phase: the session must fold
(`mode: historical`, `status: idle`), the task must still be in the transcript, a new message must be
accepted, and the resumed run must answer with the earlier turn still present.

**What proves it.** The second process is not the first: it has no in-memory owner, so every entry it
prints came out of the log the interrupted run left behind. The transcript grows from 6 to 8 entries
across the restart rather than restarting at 1.

**The work survives too (LOB-268).** The release is the harness's and the log handle's, nothing
more: the session's worktree and its branch `factory/<id>` stay where the run left them. The drive
registers a repo whose checkout it creates under `.verify/run/sigterm/checkout`, so the session gets a
real linked worktree; the arm phase commits a file on the branch and leaves an uncommitted edit
beside it before the signal. With no process running, the script reads the branch (still on the
commit), the edit (still there) and `git worktree list` (still listing it). The verify phase reads
the same worktree back through the fresh process — same path, `HEAD` on the commit, `released`
unset — and the branch is still on the commit after the resumed run. Then it discards the session
(`discardSession`), the one way an operator ends the work: the worktree and branch are gone, a second
discard answers `first: false` with the first's time, and the session reads back with
`released: discarded`, cuts no worktree, and refuses a new message as `invalid_input`. That a
_next run's tool calls_ see the commit — after the idle sweep and after a restart — is
`packages/core`'s claim (`SessionService.test.ts`, "a session's workspace outlives its owner"),
because the faux resumed turn here replies without calling a tool. The card's `done`/`canceled` and
the PR's merge are proven there and in `apps/api/src/Rpc/Session.test.ts`.

**What it does not prove.** That the interrupted _tool call_ itself resumed — the resumed turn is a
new turn. Pi Durable's abort/replay behavior under a harder kill (`SIGKILL`, a machine loss) is
untested; `SIGKILL` runs no finalizer at all, and what that leaves is exactly what LOB-25
(`Harness.resume()`) is for.
