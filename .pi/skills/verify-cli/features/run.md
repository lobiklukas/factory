# `factory run`

**What it is.** The write path in one command (D9): mint a session, hand it a task, follow the
transcript until the run settles, and print the answer. `--repo <owner/name>` binds the session to a
repository (registering it on first use), `--base-ref` picks the ref it starts from.

**How a user reaches it.** `factory run "fix the flaky test" --repo lobiklukas/factory`. The command
prints the session id first, then the workspace the server resolved (path, and repo/base ref when
bound), then the transcript as it commits, then `answer: …`.

**How the skill drives it.** `drive.sh` types the command into a tmux pane, waits for the sentinel
the shell prints with its exit code, and captures the pane. It asserts: exit 0; a `ses_…` id; a
`workspace /…` line; a `[tool:bash] faux-ok` line; and `answer: faux-ok (re: verify-cli probe)`.

**What proves it.** The answer text is derived from the faux `bash` tool's own output and echoes the
prompt, so the line can only exist if the session was created, the message was admitted, the tool
ran, the transcript committed, and the stream delivered it to this terminal.

**What it does not prove.** Nothing about the model (faux), nothing about a repo checkout (the
session gets a scratch directory under `SESSION_ROOT` until M6), and nothing about a live/historical
label — `run` does not print the mode; `watch` does.
