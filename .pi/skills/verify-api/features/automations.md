# Scheduled automations (S-general-automations)

**What it is.** Work the factory starts on a clock: an automation names a repo, a schedule — a cron
expression in a time zone, or one instant — and what its run is told (a prompt, a factory skill, or
both), with an optional budget, start column and base ref. Each **tick** files one card on the repo's
board and starts one run on it, so what an automation did is reviewed on the board like any card.

- **Stored.** `automations` and `automation_ticks` (migration `0051_create_automations.ts`). Added
  with `factory automation add --repo … (--cron "…" [--tz …] | --at <instant>) (--prompt … |
--skill …) [--name] [--budget] [--column] [--base-ref] [--always]`, or `addAutomation` over RPC
  (`AutomationsRpc`). A cron or zone `effect/Cron` cannot read, an expression no date matches, a
  cron that fires more often than once a minute, a one-off in the past, a skill the library lacks, a column the board does not declare, an unsafe
  base ref and a repo with no board are `invalid_automation` naming the field; an unregistered repo
  `repo_not_found`. Nothing is written for any of them.
- **Fired by the API's clock.** `AUTOMATIONS_POLL_MS` (default 15000; `0` is off) is how often the
  process looks; each enabled automation's latest reached instant at or after it was enabled is its
  due tick — never a backlog after an outage (`packages/core/src/automationSchedule.ts`).
- **One card per tick, across restarts.** The tick is claimed in `automation_ticks` (primary key:
  the automation and the instant) before anything happens, so a second process, or the same one
  after a restart, answers the recorded tick and files nothing. A claim whose process died before
  recording an outcome is taken over after ten minutes when its instant is still the due one (a
  one-off's, an infrequent cron's); the card is filed under `automation:<id>@<instant>`
  (`TaskService.file`), the run created and sent under `automation:<id>@<millis>`, so a retried tick
  makes none of them twice. A stale claim on an instant the schedule has moved past is recorded
  `failed` by the next pass, linked to whatever card and run it made. From filing the card to
  recording the outcome a tick is uninterruptible, so a shutdown waits for it.
- **No card without a run.** When the run cannot be opened (admission control, the board's run cap,
  a start column the board no longer declares), the card the tick filed is moved to `canceled` and
  the tick is `failed` with the reason.
- **Skip if unchanged.** A scheduled tick reads its base's tip first (`SessionService.baseHead`:
  the clone synced, the forge fetched, or the checkout's ref). The same commit as the last `started`
  tick is `skipped` with `no new commits on <base> since the run at <instant> (<sha>), so nothing was
filed`. `--always` opts out; a tip git cannot read never skips.
- **Run now, pause, resume.** `factory automation run <id>` fires one at once — paused or not, never
  skipped on an unmoved base; it exits non-zero (`tick_failed`, `tick_skipped`) when the tick
  started no run. `pause` stops the scheduled ticks; `resume` starts them again from now, so an instant
  reached while paused does not fire.
- **History.** `factory automation history <id>` (`listAutomationTicks`): each tick's trigger,
  status, card, run and reason, newest first, with the run's status and spend read from
  `session_activity`. `factory automation ls` shows the schedule, state, next instant and last tick.

**The docs schedule stays.** `DOCS_SCHEDULE_MS`/`DOCS_SCHEDULE_REPO` (LOB-234) keep their own daemon
and their `factory/doc-*` session branches; a docs pass on a schedule can now also be an automation
(`--skill docs`), whose ticks are cards. Folding the docs schedule into automations is a follow-up.

## How it is proven

`./automations.sh` (API on `API_PORT`, default :9200; about three minutes, because it waits for real
minutes) boots its own API with `AUTOMATIONS_POLL_MS=1000`, registers a fixture checkout with no
remote and gives it a board, then:

1. `factory automation add --cron "* * * * *"` — the API's own clock fires the next minute: one tick
   `started`, one card under `automation:<id>@<minute>`, one run on it; more passes inside the minute
   fire nothing more.
2. The API is stopped and booted again over the same database inside that minute: still one tick,
   one card, one run; the second process's log names the minute nowhere as a tick it started.
3. The next minute, with no commit on `main`, is `skipped` with the reason, the run and the commit;
   `factory automation history` prints it beside the started tick's card and run.
4. `factory automation run` starts one at once on the unmoved base: a second card and run.
5. `factory automation pause` — a whole minute passes with the clock running and no scheduled tick.
6. `factory automation ls` lists it paused; `rm` removes it and `show` answers
   `automation_not_found`.

Evidence: `.verify/evidence/latest/api/automations-before.json`, `automations-after.json`,
`automations.log` and both API logs.

In the core suite: `packages/core/src/AutomationService.test.ts` (real Postgres, a real checkout, the
real session, task and skill services, faux model; a restart is a disposed runtime and a new one) and
`packages/core/src/automationSchedule.test.ts` (the clock, pure).
