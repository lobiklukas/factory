# The per-session budget cap: a run stops at its limit, and says so

**Status: passing.** A session may carry a spend ceiling in US dollars. Once its spend has reached
it, the run stops before the next model request it would send, and the stop is reported wherever an
operator looks: the transcript, the session snapshot, the session stream, the API's log, and
`factory run` (LOB-163, part 3 of LOB-17).

## What it is

- `createSession({ budget })` (`packages/domain/src/Session.ts`, `CreateSessionInput.budget`) names
  the cap. `SessionBudgetCap` refuses zero, a negative amount, `NaN` and infinity at the contract.
  A create that names none gets the server's `SESSION_BUDGET`, when the API was started with one
  (`apps/api/src/index.ts`; a value that is not a positive number fails the boot).
- `SessionService.create` commits the cap to the session's own log as the `factory.budget` document
  (`writeBudget`, `packages/harness/src/budget.ts`) before it answers, so no message can start a run
  before the cap is there, and a restart or a fold reads it back (D7).
- The cap is enforced in the harness: `budgetExtension`, a `beforeRequest` hook on Pi Durable's
  generation task, installed by `openSession` on every session. The stop semantics are documented at
  the top of `budget.ts`; in short:
  - spend is both `pi.usage` buckets of the root conversation — the total the session list shows;
  - it is checked before every request a run sends (the first, each after a tool round, every
    retry), and the run stops once `spent >= cap`; a request already sent is paid for, so a session
    ends above its cap by at most the one request that crossed it;
  - the stop is an abort of the root conversation, as an interrupt is: the request is never sent,
    the run settles `unanswered` (`aborted`), queued messages are withdrawn, and the session is idle;
  - before the abort, one commit records the stop: a `factory.budget.stopped` entry (kind `budget`
    in the transcript) and the stop fields of `factory.budget` — once per generation task, so a
    request recovered after a crash finds its stop already recorded;
  - the session stays capped: a later message starts a run that stops before its first request;
  - a stop the log refuses to commit (its record or its abort) fails closed: Pi Durable poisons a
    harness whose commit failed, so the hook logs the failure and holds the request until the
    harness closes — the run sits busy and spends nothing — and the recovered request re-checks in
    the next process;
  - a fork keeps its parent's cap and carries its spend (`factory.budget`'s `carried`), so a fork
    of a session the cap stopped is stopped too; a replay keeps its source's cap but starts at no
    spend, being a fresh run of the same task; a fork or a replay of an uncapped session gets
    `SESSION_BUDGET`, as a create does (`inheritBudget`).
- `getSession().budget` is `{ cap, spent, stopped? }`, absent for an uncapped session, on the live
  and the folded read alike. A fork's `spent` includes what it carried from its parent, so it can
  exceed the cost the session list shows for the fork's own requests. `stopped` carries `at`, `spent` and `cap` of the last stop.
- `SessionService` logs `session <id> stopped by its budget: …` as a warning when the stop entry
  reaches its activity projection, so the process log (and motel) names the session.
- `factory run --budget <dollars>` creates the session with that cap, prints the `[budget]` line as
  it lands, and ends with `stopped: budget reached ($spent of $cap)` instead of an answer.

## How a user reaches it

`factory run "…" --budget 2`, or `createSession({ budget: 2 })` over the RPC surface, or a server
started with `SESSION_BUDGET=2` so every session that names no cap gets one — a created one, and a
fork or a replay of an uncapped one. The dashboard's transcript shows the stop as a marker row, not as
an agent reply (`apps/web/src/components/transcript-entry.tsx`).

## What proves it

`./budget.sh` (API on `BUDGET_PORT`, default `:9419`), which starts its own API with the faux model
priced at `FAUX_COST=0.01` a request and `SESSION_BUDGET=1`. pi-ai's faux provider reports a cost of
zero whatever its model is priced at, so without `FAUX_COST` (`ModelAccessOptions.fauxCost` in
`packages/harness/src/models.ts`) no cap could ever be reached. The faux script is two requests a
run — a `bash` call, then a reply — so a one-cent cap is reached by the first answer:

- **capped** — a create with `budget: 0.01` reports the cap unspent; a watcher attached before the
  send receives the `budget` entry and, after it, `status: idle` (the drive compares the indices); the transcript is user, call, tool
  result, stop — no reply; spend equals the cap; the entry names `$0.0100 of its $0.0100 cap`; the
  snapshot's `budget.stopped` says the same.
- **again** — a second message starts a run that stops before its first request: a second stop and
  the spend unchanged.
- **default** — a create naming no cap gets `SESSION_BUDGET`, and its run answers as an uncapped one.
- **operator** — the API log names the stopped session; `factory run --budget 0.01` prints the
  `budget` line, the `[budget]` entry, `answer: (no answer)` and the `stopped:` line.

Evidence under `$EVIDENCE_DIR/api/`: `budget.json`, `budget-transcript.txt`, `budget-cli.txt`,
`budget-process.json`, `budget-api.log`.

The suites cover what a drive cannot reach: `packages/harness/src/budget.test.ts` counts the faux
provider's calls (the stopped request was never sent), the exact-cap boundary, the fold, and a crash
between the stop's commit and the abort — the first process holds the request instead of sending it,
and the recovered request re-checks and records no second stop — a refused stop record and a refused
abort, each holding the request rather than sending it, and the inheritance rules for a fork and a
replay. `packages/core/src/SessionService.test.ts` ("the budget cap") proves the default, the activity
row's cost, a second process folding the same stop, a fork of a stopped session staying stopped
without sending a request, and a fork of an uncapped session getting the default.

## What it does not prove

- **Compaction and curation spend.** Neither is a generation request, so the hook does not stop
  them; their spend counts toward the total it checks.
- **Raising a cap.** Not built: a stopped session stays stopped, and so does a fork of it. A replay
  of it runs again from no spend, under the same cap.
- **Forks and replays over the wire.** The inheritance is proven by the suites, not by `./budget.sh`.
- **The dashboard.** The web transcript's marker row for a stop is not driven by a browser here.
- **A real provider's prices.** The drive prices the faux model; the hook reads `pi.usage`, which a
  real provider fills the same way.
