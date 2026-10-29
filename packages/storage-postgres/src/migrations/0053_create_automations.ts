import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Scheduled automations (S-general-automations): work the factory starts on a clock rather than on a
 * person or a delivery.
 *
 * `automations` is one row per schedule: a repo, a five- or six-field cron expression in a time zone
 * or a single instant (`run_at`, a one-off), what the run is told (a prompt, a skill, or both), an
 * optional budget and column, and whether it is enabled. `enabled_at` is when it was last enabled — at
 * creation, or by a resume — and no scheduled tick before it fires, so a resume does not fire the tick
 * it slept through.
 *
 * `automation_ticks` is the history and the dedupe. Its primary key is the automation and the tick's
 * instant, and a tick is claimed with one `INSERT … ON CONFLICT … DO UPDATE SET claimed_at = now()
 * WHERE status = 'claimed' AND claimed_at < now() - <reclaim window> RETURNING`: of two processes (or
 * one process before and after a restart) reaching the same tick only one gets a row back and fires
 * it, and a claim left `claimed` past the window by a process that died is taken over
 * (`AutomationService`'s `RECLAIM_AFTER`). A stale claim on an instant the schedule has moved past is
 * not taken over: the next pass records it `failed`. A tick is `claimed` while it runs, then
 * `started` (it filed a card and opened a run on it), `skipped` (the base had not moved since the
 * last started tick, or the repo has no board), or `failed`, with the reason. `base_commit` is the
 * base's tip the tick read: what the next tick compares against. The run's own status and spend are
 * not copied here: they are `session_activity`'s, joined on read.
 *
 * A repo's automations go with its row; a card or a session that is gone leaves its tick's history
 * with nothing to link to rather than taking the history with it. Both links are indexed, so deleting
 * a card or a session does not scan the history to clear them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY CHECK (id ~ '^aut_[0-9a-z]{26}$'),
      name TEXT NOT NULL,
      repo TEXT NOT NULL REFERENCES repos (slug) ON DELETE CASCADE,
      cron TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      run_at TIMESTAMPTZ,
      prompt TEXT NOT NULL DEFAULT '',
      skill TEXT,
      budget DOUBLE PRECISION CHECK (budget IS NULL OR budget > 0),
      task_column TEXT,
      base_ref TEXT,
      skip_if_unchanged BOOLEAN NOT NULL DEFAULT true,
      enabled BOOLEAN NOT NULL DEFAULT true,
      enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((cron IS NULL) <> (run_at IS NULL)),
      CHECK (prompt <> '' OR skill IS NOT NULL)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_ticks (
      automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
      tick_at TIMESTAMPTZ NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      status TEXT NOT NULL DEFAULT 'claimed'
        CHECK (status IN ('claimed', 'started', 'skipped', 'failed')),
      reason TEXT NOT NULL DEFAULT '',
      base_ref TEXT,
      base_commit TEXT,
      task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      PRIMARY KEY (automation_id, tick_at)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS automation_ticks_task_id_idx
      ON automation_ticks (task_id) WHERE task_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS automation_ticks_session_id_idx
      ON automation_ticks (session_id) WHERE session_id IS NOT NULL
  `;
});
