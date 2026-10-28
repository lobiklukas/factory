# A worktree's declared setup (S-env-setup)

**What it is.** Before a session's first turn the control plane runs the repo's declared `install`,
then its `build` (`.factory/config`, the workspace's `commands`), in the session's fresh worktree,
through the session's own `ExecutionEnv` — the one its tools get, so a sandbox runtime takes the
setup over with them (`packages/harness/src/setup.ts`, `SessionService`'s `ensureSetup`). Each step
runs with `DATABASE_URL` set to `VERIFY_NO_DATABASE`, stops the setup at the first failure, and is
recorded with its exit code (or the execution error's code) and a bounded tail of its output in the
log's `factory.setup` document (`readLoggedSetup`). A setup that succeeded never runs again; a
failed one runs again on the next message to a session that is no card's run, which is still the
first.

The setup runs in the service's scope, not in the request: a send waits for it (at most
`SETUP_WAIT_MS`, 90 s, under the API's 120 s `IDLE_TIMEOUT`, then answers `setup_running`), and a
send that goes away — a client that hung up, an idle timeout — leaves it to finish and record. A send
that arrives while it runs waits for the same one, so one worktree never runs two installs at once.
An interrupted step (shutdown) is killed, not left running: the exec gets the fiber's abort signal.

A failed setup refuses the message `setup_failed` before anything is written for it — no submission,
no title, no model call. The message names the step, the command, its exit code, the worktree and
the output's last 20 lines. A session that is a card's run parks the card `setup_failed` with the
same words as the block's note (a card already blocked keeps its block), and its run ends so it
holds no cap slot. Because the run ended, a later message to it is refused `setup_failed` with the
recorded failure and runs nothing: the fix is a new run once the repo is fixed and the card
unblocked. The card pane shows the note under the card's header; `factory board show` prints it
under `blocked`. A trigger delivery whose session's setup failed is recorded `processed`, its reason
naming the failure, so a sender's retry is a replay rather than another install.

The registry answers each checkout's agent-readiness score (LOB-29's `scoreRepoReadiness`) as
`RepoSummary.readiness` — scored when the row is answered, so on registration and on every read —
for a `localPath` inside a git work tree; `factory repo ls` and the Repositories page show it.

**How the skill drives it.** `./setup.sh` boots its own API with `./up.sh` (`API_PORT`, a run
directory of its own under `.verify/run/setup/`), the faux model scripted to probe for
`node_modules` on its first `bash` turn and then call `verify` (`FAUX_COMMAND`, `FAUX_VERIFY`), and
runs `setup.ts` over RPC against three local fixture repos with no remote:

1. `ok` declares `install: bun install` (one `file:` dependency, so no network), a `build` that
   needs the dependency, and a `verify` that needs both. A session's first message: the log's
   record holds install and build at exit 0 in the session's worktree; the agent's first command
   printed `deps-present`; its `verify` call ran the declared command to exit 0.
2. `broken` declares an install that prints and exits 7. A card's run's first message is refused
   `setup_failed`, naming the step, `exited 7` and the stderr line; the card is blocked
   `setup_failed` with that tail as its note; the session holds no entry and no title; the log keeps
   the one step (the build never ran) with its exit code and output; the card's run has finished.
   A second message to that run is refused `setup_failed` ("start a new run"), the install did not
   run again, and the card's block is the one it was.
3. `abandoned` declares an install that sleeps 3 s. The first send's client goes away mid-install
   (the API logs `ClientAbort`, `http.status 499`) and a second send follows at once: the install
   ran once (`start`, `done`), the log records it succeeded, and the run's only message is the
   second's.
4. `ok`'s registration answered readiness 1/4 (an AGENTS.md, nothing else), and `listRepos` the same.
5. After the driver, `factory board show --task <the parked card>` prints `blocked   setup_failed
from intake since …` and the note's lines indented under it, the stderr line among them.

Evidence: `.verify/evidence/latest/api/setup.json` (both sessions' records and transcripts, the
card's block), `setup-board-show.txt`, `setup.log`, `setup-api.log`.

**What proves it besides.** `packages/harness/src/setup.test.ts` (the steps' order, the stop at a
failure, a timeout, the tail bound, the database, the failure text, the record through a log) and
`packages/core/src/SessionService.setup.test.ts` (the same claims through the service, plus a
setup that ran once across two messages, a card run's retry refused without rerunning, a plain
session's retry that runs again and then works, an interrupted send whose install the next send
waits for, a `setup_running` answer past the wait bound, a repo declaring neither command, and a
score that follows the checkout). `TriggerService.test.ts` records a delivery whose setup failed as
processed, and its retry as a replay.

On this repo itself (one-off, 2026-10-28): a session on a clone of the monorepo with a
`.factory/config` declaring `install: bun install --frozen-lockfile` and `verify: cd packages/domain
&& bun run type-check` installed in about 5 s, its agent's first command found
`node_modules/typescript`, and `verify` exited 0 (`.verify/evidence/latest/api/monorepo-setup.json`).
The factory repo does not declare a root `.factory/config` yet: a worktree of this repo reads the
root's config before a fixture's `localPath`, so a root config would take over every verify-api
fixture inside it. That is a follow-up. `verify-cli`'s `repo.sh` and
`verify-web`'s `repos.sh` prove the score in `repo ls`, `repo add` and on the page.

**What it does not prove.** A readiness score for a repo registered by URL only (its mirror is
bare, and nothing scores a bare repo yet), a `setup_failed` card in the Attention view (it is shown
blocked on its lane), a real sandbox runtime (the in-process one runs the steps on the host;
`@repo/sandbox`'s conformance suite is what binds the seam), snapshots or warm pools of a set-up
worktree (LOB-13), and a replay's run, which starts inside its open and is not set up.
