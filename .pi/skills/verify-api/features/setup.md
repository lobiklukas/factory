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
An interrupted step is killed, not left running: the exec gets the fiber's abort signal. A setup is
interrupted when its owner is released for any reason — a workspace release (merge, discard), a
presence lease another process took, shutdown — so no install outlives the worktree or sandbox it
runs in, and a stopped setup records nothing: the next owner's first send runs it again. A send
waiting on it is answered `harness`, "stopped before it finished".

A trigger's delivery does not wait at all (`SessionService.sendDeferringSetup`, what the trigger,
docs and review seams send through): a webhook sender gives up long before an install finishes
(GitHub's timeout is 10 s, and it does not redeliver), and the request's end would take the prompt
with it. The delivery is answered `processed` while the setup runs, and a fiber in the service's
scope sends the prompt, under the delivery's request id, once the setup succeeds; a setup that fails
sends nothing, and its record and the card's block say why.

A failed setup refuses the message `setup_failed` before anything is written for it — no submission,
no title, no model call. The message names the step, the command, its exit code, the worktree and
the output's last 20 lines. A session that is a card's run parks the card `setup_failed` with the
same words as the block's note (a card already blocked keeps its block), and its run ends so it
holds no cap slot. Because the run ended, a later message to it is refused `setup_failed` with the
recorded failure and runs nothing: the fix is a new run once the repo is fixed and the card
unblocked. The card pane shows the note under the card's header; `factory board show` prints it
under `blocked`. A trigger delivery to a card's run whose setup already failed is recorded `processed`, its
reason naming the failure, so a sender's retry is a replay rather than another install.

A setup is for the worktree it ran in (F23). Cutting a worktree stamps a fresh cut id in its
administrative directory in the registered checkout (`<common>/worktrees/<name>/factory-cut`,
`workspace.ts`'s `stampCut`), which `git worktree remove` takes with the worktree; the record carries
the id (`SetupRecord.cut`). A worktree whose directory went missing is cut again by the next send and
has a new id, so the log's succeeded record no longer covers it (`setupCovers`) and the setup runs
again; a worktree that is merely reopened has the same id and runs nothing. A worktree with no
id (cut before cuts were named, or a plain directory) is covered by whatever succeeded record the log
has; a record with no id (written before cuts were named) beside a worktree that has one is stale, because
the worktree was cut since, so a session that predates this runs its setup once more when it is cut again.

A replay is set up like a first run (F23). Its open no longer submits the source's prompt
(`openReplay`); once the owner is open `promptAfterSetup` starts the setup (`startSetup`) and, with
none owed, submits the prompt at once, as before. With one owed the replay is answered immediately,
with the prompt held, and a fiber in the service's scope submits it (`submitReplayPrompt`) once the
setup succeeds, as a trigger's message is. The replay's comparison waits for the held prompt
(`heldPrompts`): a replay with no prompt in its log yet would be compared as one that never ran. A
setup that fails or is stopped submits nothing and says so in the log; the replay's comparison then
reads it `unanswered`, and its failure is the replay's own `factory.setup` record.

`SETUP_TIMEOUT_SECONDS` (F24) is the deployment's bound on each step: a positive finite number of
seconds, read by `apps/api/src/SetupTimeout.ts` and passed to the service (`setupTimeoutSeconds`);
unset it is the harness's 1800. A value that is not one refuses the boot, and `factory doctor`'s
`setup-timeout` line (from `checkDeployment`) says which bound is in force.

The registry answers each checkout's agent-readiness score (LOB-29's `scoreRepoReadiness`) as
`RepoSummary.readiness` — scored when the row is answered, so on registration and on every read —
for a `localPath` inside a git work tree; `factory repo ls` and the Repositories page show it.

**How the skill drives it.** `./setup.sh` boots its own API with `./up.sh` (`API_PORT`, a run
directory of its own under `.verify/run/setup/`), the faux model scripted to probe for
`node_modules` on its first `bash` turn and then call `verify` (`FAUX_COMMAND`, `FAUX_VERIFY`), and
runs `setup.ts` over RPC and the generic webhook route (`TRIGGER_RULES`, `TRIGGER_SECRET`) against
local fixture repos with no remote, and a clone of this checkout:

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
4. `triggered` declares an install that sleeps 4 s, on the repo `TRIGGER_RULES` maps the `factory`
   label to. A signed generic delivery is answered `200 processed` in well under a second, the
   install not finished; once it is, the session holds the delivery's prompt, once, and the agent's
   first command printed `deps-present`.
5. `self` is a clone of this checkout (so the session's worktree and branch are cut in the clone,
   not in the `.git` every factory checkout on the machine shares), registered with its own root
   `.factory/config`, which declares `install: bun install`. The session's first message: the log's
   record holds `bun install` at exit 0 in the session's worktree, and the agent's first command
   found the monorepo's `node_modules` (about 7 s with bun's cache warm).
6. `ok`'s registration answered readiness 1/4 (an AGENTS.md, nothing else), and `listRepos` the same.
7. `replayed` declares an install that sleeps 3 s. A replay of a session on it is answered while its
   own install runs, with no message yet; the install then ran in the replay's own worktree (two
   installs in all, the replay's not skipped as the source's), the agent's first command printed
   `deps-present`, and the replay's comparison reads a run that answered (F23).
8. `recut` is seeded in the first phase: one send, one install, a record naming the worktree's cut.
   The API is then restarted with `SETUP_TIMEOUT_SECONDS=1` (through turbo, so a variable the
   package's `turbo.json` does not declare would be stripped) and the second phase deletes the
   session's worktree directory and sends again: the worktree is cut again, the install ran a second
   time into it, and the record names the new cut (F23).
9. `timeout` (second phase): an install that sleeps 5 s on a card's run is stopped at the one-second
   bound. The first message is refused `setup_failed` with `could not run (timeout)`, the card is
   blocked `setup_failed`, the log records the step unrunnable with code `timeout`, the install
   never reached its `done`, and `checkDeployment` reports `setupTimeoutSeconds: 1` (F24).
10. After the driver, `factory board show --task <the parked card>` prints `blocked   setup_failed
from intake since …` and the note's lines indented under it, the stderr line among them.

Evidence: `.verify/evidence/latest/api/setup.json` (both sessions' records and transcripts, the
card's block), `setup-board-show.txt`, `setup.log`, `setup-api.log`.

**What proves it besides.** `packages/harness/src/setup.test.ts` (the steps' order, the stop at a
failure, a timeout, the tail bound, the database, the failure text, the record through a log) and
`packages/core/src/SessionService.setup.test.ts` (the same claims through the service, plus a
setup that ran once across two messages, a card run's retry refused without rerunning, a plain
session's retry that runs again and then works, an interrupted send whose install the next send
waits for, a `setup_running` answer past the wait bound, a trigger port's send answered before a slow setup
and its prompt sent once after it, a trigger's prompt never sent after a failed setup, a setup
stopped by a workspace release mid-install with its command killed and nothing recorded or parked,
a repo declaring neither command, and a score that follows the checkout). `workspace.test.ts`
reads a subdirectory checkout's config at its place in the worktree, not the enclosing root's and
names the cut a worktree is stamped with (F23). `apps/api/src/SetupTimeout.test.ts` and
`boot.test.ts` hold the deployment setting (the value, the malformed ones that refuse the boot, the
bound `checkDeployment` reports); the replay and re-cut claims have cases in
`SessionService.setup.test.ts`. `TriggerService.test.ts` records a delivery whose setup failed as
processed, and its retry as a replay.

This repo declares its own setup in a root `.factory/config` (`install: bun install`; the root
`.factory/` is otherwise the default session root, still ignored). A verify skill's fixture
registered at a subdirectory of the monorepo keeps its own config: a checkout's config is read from
its place in the session's worktree (`git rev-parse --show-prefix`), so the enclosing root's never
takes over a fixture. `verify-cli`'s `repo.sh` and `verify-web`'s `repos.sh` prove the score in
`repo ls`, `repo add` and on the page.

**What it does not prove.** A readiness score for a repo registered by URL only (its mirror is
bare, and nothing scores a bare repo yet), a `setup_failed` card in the Attention view (it is shown
blocked on its lane), a real sandbox runtime (the in-process one runs the steps on the host;
`@repo/sandbox`'s conformance suite is what binds the seam), snapshots or warm pools of a set-up
worktree (LOB-13), a replay whose process stops while its prompt waits for the setup (the held prompt lives in the
process, like a trigger's; the replay then has no run and its comparison reads it `unanswered`), and a verify
run that passes on this repo itself (its verify is per-surface skills, which a faux change at the
root has none of; the `ok` fixture proves `verify` passing on a set-up worktree). A trigger's prompt
waiting on a setup lives in the process: a process stopped mid-setup loses it, though its delivery
is recorded `processed` (follow-up: a durable pending first message).
