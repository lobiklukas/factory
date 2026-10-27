# `factory send --when-busy steer` and `--when-busy reject`

**What it is.** The two placements a person picks when a session is already running (LOB-167). A
steer joins the run in flight: Pi Durable places it after the current tool round, and the same run
answers it. A reject is a send that refuses to queue: on a running session the server answers
`busy` and admits nothing; on an idle one it starts a run like any other send.

**How a user reaches it.** `factory send ses_… "use pnpm, not npm" --when-busy steer` prints
`submission <id> placement steer`; a `factory watch` on the session shows `[queued:steer:<id>] …`
until the tool round places it. `factory send ses_… "…" --when-busy reject` prints
`error: busy: …` on stderr and exits 1 while the session runs, or `submission <id> placement run`
when it is idle.

**How the skill drives it.** `./steer.sh` owns its own API (`STEER_PORT`, default `:9320`) with the
sleeping faux script, `FAUX_SLEEP_MS=8000` (`STEER_SLEEP_MS`): the scripted model naps before each
step of a turn (`fauxSleepMs` in `packages/harness/src/models.ts`), so the run is genuinely in
flight for about sixteen seconds without scripting a slow command. In one tmux window `factory run`
follows the run; in a second, `factory send --when-busy steer` and then `--when-busy reject` land
during the first nap. Once the run settles, `factory watch` reads the finished log, and a last
`--when-busy reject` goes to the now idle session.

**What proves it.** The faux model answers the newest user message, so the answer itself says
which run took the steer: `answer: faux-ok (re: use the steer)` from `factory run`, and exactly one
`[assistant] faux-ok …` line in the transcript. A steer treated as a follow-up would have let the
first run answer `steer probe` and settle, then started a second — two answers. The steer's entry
follows the `[tool:bash]` result, which is where a steer is placed. The rejected message has no
`submission` line, never appears as `[user] only if idle`, and the refusal arrived while `factory
run` was still following the run. The idle control makes the refusal about the session, not about
the flag. A mutation run with the nap off (`STEER_SLEEP_MS=0`) failed 9 of the 13 checks: the
sends land on an idle session, so the steer is a run and the reject is admitted.

**What it does not prove.** A steer placed at the run's final boundary (one sent during the second
nap, after the tool round) and `steeringMode: "all"`: both are Pi Durable's placement rules, not
this app's. The service-level claims — placement, the queue reading, one answer, `busy` with an
empty queue — are also asserted in `packages/core/src/SessionService.test.ts` ("a message that
arrives while a run is in flight"), and the nap itself, including that an abort ends it, in
`packages/harness/src/models.test.ts` ("the sleeping faux script").
