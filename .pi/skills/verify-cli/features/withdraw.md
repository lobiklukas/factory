# `factory send` and `factory withdraw`

**What it is.** Taking a queued message back before a run places it (LOB-166). `factory send` hands
a session one more message and returns the server's answer — `submission <id> placement <run|steer|followUp>`
— and `factory withdraw <session-id> <submission-id>` takes that message out of the queue. Pi Durable
settles the submission `unanswered` (reason `aborted`) and removes its `pi.inbox` item in one commit,
so the message never reaches the transcript and every attached watcher sees the queue shrink.

**How a user reaches it.** While a session is running: `factory send ses_… "also fix the docs"
--when-busy followUp` prints the submission id; `factory watch ses_…` shows each queued message as
`[queued:<mode>:<id>] <text>` and `[queued] (empty)` when the queue drains; `factory withdraw ses_… <id>`
prints `withdrawn <id>`.

**Outcomes a script branches on.** Only `withdrawn` exits 0. `error: already_placed` (a run took
it first) and `error: settled` (it is already over) exit non-zero, as a refusal does: the command
did not do what it was asked. `error: not_found` is an id the session never admitted, or an unknown
session.

**How the skill drives it.** `./withdraw.sh` owns its own API (`WITHDRAW_PORT`, default `:9310`)
with `FAUX_COMMAND="sleep 15 && echo faux-ok"`, because a message only queues behind a run in
flight and the faux turn is too fast to queue behind. In one tmux window `factory run` follows the
turn; in a second, two `factory send --when-busy followUp` calls queue `drop me` and `keep me`, then
`factory withdraw` takes `drop me` back, and is repeated (`settled`) and aimed at an unknown id
(`not_found`). Once the session settles, `factory watch` reads the finished log.

**What proves it.** Three things only a real withdrawal produces: the watcher's last queue reading
is `keep me` alone, not the pair it was a moment before; the transcript carries `[user] keep me` and
its answer but never `[user] drop me`; and withdrawing the same id again answers `settled`. The
`factory run` window also prints `[queued] (empty)` after `[user] keep me`, the drain a placement
causes. A
mutation that answered `withdrawn` without calling Pi Durable failed four checks (the queue reading,
the repeat, the transcript, and the late withdrawal).

**What it does not prove.** `already_placed` from the terminal: the message a run holds is the
run's own task, whose submission id `factory run` does not print. The outcome is covered by
`packages/core/src/SessionService.test.ts` ("withdrawing a queued message"), which withdraws the
running turn's own submission. Withdrawing a steer before its tool boundary is covered there too,
and so is a withdraw on a session nobody owns, which answers from the log without opening an owner.
The dashboard's Withdraw button calls the same RPC (`withdrawMessageAtom`); this skill does not
drive it.
