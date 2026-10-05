# Typed errors at the command line

**What it is.** A refusal is a word a script can branch on, not prose to parse: every subcommand
prints `error: <code>: <message>` to stderr and exits non-zero, where `<code>` is
`SessionError.code` (`not_found`, `busy`, `invalid_input`, `storage`, `harness`) or `error` for
anything that is not a `SessionError` — a control plane that is not listening, a dropped stream.

**How a user reaches it.** `factory watch ses_00000000000000000000000000` against a server that has
no such session.

**How the skill drives it.** `drive.sh` watches a well-formed id that no session was minted with,
and asserts the pane contains `error: not_found` and that the sentinel carried a non-zero exit code.

**What proves it.** The id parses (`SessionId`'s pattern), so the command really reaches the server;
the code came back over the wire as a `SessionError`; and the exit code is what a shell script sees.

**What it does not prove.** The `busy` and `invalid_input` codes — `.pi/skills/verify-api` owns those
(an oversized message is `invalid_input`; `busy` needs a session held in a run).
