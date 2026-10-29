# `factory run`

**What it is.** The write path in one command (D9): mint a session, hand it a task, follow the
transcript until the run settles, and print the answer. `--repo <owner/name>` binds the session to a
repository (registering it on first use), `--base-ref` picks the ref it starts from.

**How a user reaches it.** `factory run "fix the flaky test" --repo lobiklukas/factory`. The command
prints what the run is predicted to cost first (`predicted $… to $…, median $…, from N sessions (…)`,
or `predicted: no estimate (…)`; LOB-38, absent when the server cannot answer the prediction), then
the session id, then `budget $…` when a cap was set (`--budget`, or `--cap-at-prediction`'s
`(the predicted high)`), then `model <provider/model>` (and `warning: faux backend …` under the faux
backend, LOB-272, [status.md](status.md)), then the workspace the server resolved (path, and repo/base ref when
bound), then the transcript as it commits, then `answer: …`.

**How the skill drives it.** `drive.sh` types the command into a tmux pane, waits for the sentinel
the shell prints with its exit code, and captures the pane. It asserts: exit 0; a `ses_…` id; a
`model faux/faux-1` line and a `warning: faux backend` line; a `workspace /…` line; a `[tool:bash] faux-ok` line; and `answer: faux-ok (re: verify-cli probe)`.

**What proves it.** The answer text is derived from the faux `bash` tool's own output and echoes the
prompt, so the line can only exist if the session was created, the message was admitted, the tool
ran, the transcript committed, and the stream delivered it to this terminal.

**What it does not prove.** Nothing about the model (faux), nothing about a repo checkout (the
session gets a scratch directory under `SESSION_ROOT` until M6), and nothing about a live/historical
label — `run` does not print the mode; `watch` does.

**`--open-pr` (F17).** `factory run "<task>" --repo r --open-pr` asks the control plane to open the
session's PR when its run settles with a change, as a trigger's session does (`createSession`'s
`openPrOnSettle`, recorded in the log as `factory.settlePr`, read by the settle rule in
`packages/core/src/prOnSettle.ts`). Without the flag a person's session keeps `factory pr`. After the
answer the command waits for the settle-time step and prints `pr <link>`, or `pr none: <why>` (a branch
with no change, a diff over the cap). `--open-pr` without `--repo` is `error: invalid_input`.
`./open-pr.sh` drives it against a GitHub fake: the ledger is the oracle for one create on
`factory/<session>`, none without the flag, none for a run that changes nothing.
