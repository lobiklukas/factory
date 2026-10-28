# `factory interrupt`

**What it is.** The command that stops a session's run (C8, D9's steer and interrupt). It calls
`interruptSession`: the server commits an `interrupted` entry and aborts the root conversation, so
the run settles without an answer and its queued messages are withdrawn. The call returns once the
session is idle, and the command prints the status it settled in.

**How a user reaches it.** `factory interrupt ses_…` prints `interrupted ses_…: idle` and exits 0. A
`factory run` or `factory watch` following the run prints
`[interrupted] interrupted: the run was stopped before it finished` and then `answer: (no answer)`.
On a session with no run it prints `not running: ses_… is idle` and exits 0, because the session is
already where the command would put it. An unknown id prints `error: not_found: …` on stderr and
exits 1.

**How the skill drives it.** `./interrupt.sh` owns its own API (`INTERRUPT_PORT`, default `:9380`)
with the sleeping faux script, `FAUX_SLEEP_MS=15000` (`INTERRUPT_SLEEP_MS`): the model naps before it
calls `bash` and again before it answers, so the interrupt, a fresh `bun` process, lands inside the
first nap even on a loaded machine (at 8 s, on a machine deep in swap, it once landed after `bash`
had printed). In one tmux window `factory run` follows the run; in a second, `factory interrupt` stops
it. Then `factory watch` reads the log, `factory interrupt` runs again on the idle session and on an
unknown id, and `factory send` sends a follow-up that `factory watch` follows to its answer.

**What proves it.** `interrupted <id>: idle` with exit 0; the followed `factory run` exits 0 with
`answer: (no answer)`, has printed the `[interrupted]` line, and two naps later has still never
printed `faux-ok`; the transcript holds the prompt, then the `[interrupted]` line, and no
`[tool:bash]` result. The idle session prints `not running` with exit 0, the unknown id
`error: not_found` with a non-zero exit. The follow-up is `placement run`, its `[tool:bash] faux-ok`
runs, and it answers `[assistant] faux-ok (re: now finish)`. Evidence: `interrupt-*.txt` (the raw
panes) and `interrupt.json`.

**What it does not prove.** The same stop from the dashboard, which is `verify-web`'s
[interrupt.md](../../verify-web/features/interrupt.md). The printed lines are unit cases in
`apps/cli/src/commands/interrupt.test.ts`, and the service's stop in
`packages/core/src/SessionService.interrupt.test.ts`.
