# `factory doctor`

**What it is.** A first-run preflight (E8): one command says whether this machine can turn a task into
a PR, and for each thing that cannot it names the check and the fix. Before it, every prerequisite
failed only at the step that needed it (a missing GitHub token at the push, a base ref that does not
exist at the worktree, a database that was down at the first request).

It prints one line per check, `ok|warn|fail <check>: <detail> [-- fix: <what to do>]`:

| check                                      | what it reads                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `api`                                      | `GET <api>/readyz`; the line carries the URL tried. An API that does not answer ends the run.                |
| `postgres`, `migrations`, `schema`         | the same `/readyz` body, one line each                                                                       |
| `model`, `model-auth`, `models`            | `getServerInfo`: backend and what chose it (a faux backend is a `warn`), how it authenticates, served models |
| `forge`, `forge <repo>`                    | `checkDeployment`: whether the PR step's credential resolves a token, per registered repo; never the token   |
| `repo <repo>`, `base-ref <repo>`, `config` | the checkout is git (a URL-only repo is cloned now), the base ref resolves in it, `.factory/config` exists   |
| `webhook <source>`                         | each route armed or not, with the variable that arms it                                                      |
| `trigger-rules`, `env-files`               | how many `TRIGGER_RULES` the boot mapped, and the env files it loaded (paths only)                           |
| `live-model`                               | only with `--live`: one minimal request to the default model, with its cost                                  |

`factory doctor owner/name` limits the per-repo checks to that repo. The exit is non-zero when any check
is `fail`, and when the backend is faux unless `--allow-faux` is passed; other warnings are information
and exit 0. `--live` is the only thing that spends, so it is never implied.

**How a user reaches it.** `factory doctor` after `bun run dev` (the README quickstart ends with it);
`factory doctor --allow-faux` for a drive or a demo on the scripted model; `factory doctor --live` to
prove the model credential with one request.

**How the skill drives it.** `./preflight.sh`, self-contained (`DOCTOR_PORT`, default `:9480`, plus the
two ports above it): a faux API on a scratch database (dropped on exit) with dummy `GITHUB_TOKEN` and
`ANTHROPIC_API_KEY` set, a checkout it registers twice (once with a base ref the checkout lacks), the
CLI pointed at a port nothing listens on, and a second API whose `DATABASE_URL` names a dead port, which
is verify-api's `degraded.sh` case without stopping the Postgres other worktrees use. The CLI runs as a
subprocess and its output and exit code are kept as `doctor-*.txt` / `doctor-*.exit`; the checks are in
`doctor.json`. `clone.sh` drives `factory doctor` on a URL-only repo too.

**What proves it.** The faux API's output carries `warn model: faux (selected by MODEL_BACKEND)` and
exits 1; `--allow-faux` exits 0; the degraded API's carries `fail postgres` and exits 1 while the
checks that need no database are still answered; the dead port prints `fail api: <url>`. The dummy keys
the API runs with are searched for in every output and found in none, which can fail: both are in the
API's environment. Without `--live` there is no `live-model` line, and the unit tests count the calls:
`pingModel` is never called without it (`apps/cli/src/commands/doctor.test.ts`), and
`checkDeployment` makes no model request (`apps/api/src/Rpc/Doctor.test.ts`, the faux provider's call
count).

**What it does not prove.** A real Anthropic key (`--live` is offline here: faux answers) or a real
GitHub App minting a token: a static token is checked to be set, an App's is minted with the provider
the PR step uses, covered against a fake GitHub in `packages/core`'s credential tests.
