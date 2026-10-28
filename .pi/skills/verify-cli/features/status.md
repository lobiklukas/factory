# `factory status`, and the model in `run` and `ls`

**What it is.** The CLI's face for `getServerInfo` and each session's model (LOB-272, built on
LOB-269). A scripted answer reads exactly like a real one, so the terminal says which it is getting.

- `factory status` prints one `name value` line per fact the server answered: `backend`, `selected-by`
  (`MODEL_BACKEND`, `credential` or `no_credential`), `reason` (the boot's own line), each `warning`,
  `default-model`, each `role-model <role> <provider/model>`, `models`, `approval-required`,
  `default-budget`, `model-credential` (a mode such as `ANTHROPIC_API_KEY (api_key)`, or `none` under
  faux, never a value), `forge-credential`, `reviewer-credential`, a `webhook <route> armed|unarmed
(<VARIABLE>)` per route, `linear-write-back` and `sandbox`. Where nothing is set the value is `none`,
  never empty. It reads the process's boot facts, so it answers while Postgres is down.
- `factory run` prints `model <provider/model>` right after the session id (and budget), and, when the
  server's backend is faux, `warning: faux backend, sessions do not reach a real model (<the boot's
reason>)`. A server that cannot answer `getServerInfo` costs the run its warning, never the run.
- `factory ls` gains a `model` column, after `pr` (so the PR link stays the sixth field and the title
  stays last): `id  status  repo  last-activity  cost  pr  model  title`. A session whose row names no
  model prints `-`, never an empty cell.

**How a user reaches it.** `factory status [--api <url>]`; `factory run`; `factory ls`.

**How the skill drives it.** `drive.sh`, against the faux instance `./up.sh` started: `run.txt` has the
line `model faux/faux-1` and a `warning: faux backend` line; `ls.txt` has the header with the `model`
column and the run's session's seventh field is `faux/faux-1`; `status.txt` has `backend faux`,
`selected-by MODEL_BACKEND`, the boot's `reason`, `default-model faux/faux-1`, the faux warning and a
`sandbox` line, and the command exits 0. The anthropic half (no warning in `status`, `selected-by
credential`, a `-`-free model column carrying `anthropic/claude-sonnet-5-5`) is driven by verify-web's
`backend.sh` against its own inferred-anthropic instance, and its dummy credential's value is asserted
absent from the output.

**What proves it.** Each line is read off the server's answer, not composed from the CLI's own
configuration: `model faux/faux-1` is the session summary the server returned, and the status lines are
`ServerInfo` field for field (`apps/cli/src/commands/status.test.ts` pins the mapping).

**What it does not prove.** That a `factory run` against a real model prints no warning in a terminal
(that needs a real key and a real request; the absence is unit-tested in `fauxWarning` and driven
through `factory status` on the anthropic instance).
