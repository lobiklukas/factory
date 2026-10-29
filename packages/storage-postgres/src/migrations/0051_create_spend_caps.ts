import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Aggregate spend caps (S-aggregate-spend-caps): what a repository or an actor has spent within a
 * UTC day or month, and the alerts raised as that spend approaches a cap.
 *
 * - `spend_ledger` is one row per increase of a session's `session_activity.cost_total`: the dollars
 *   it added, when, and the repository and actor the session is attributed to. `cost_total` only
 *   says what a session has cost in all, so "what did this repository spend today" cannot be read
 *   from it; the ledger is that read, kept in the same statement that moves `cost_total` (so the two
 *   cannot drift apart for want of a second write). It is not derived from the log and
 *   `rebuildIndexes` does not touch it: it records when spend happened, which the fold does not keep.
 *   There is no foreign key to `sessions`: spend that happened stays spent when its session is gone.
 *   The backfill gives every session that already has spend one row, at its last activity, so a cap
 *   configured the day this lands sees the spend the factory already recorded rather than none.
 * - `spend_alerts` is one row per (cap, window period, threshold) crossed: written once, at the
 *   crossing, by `ON CONFLICT DO NOTHING`, so a cap that stays above 80% for a day is one alert and
 *   one attention item, not one per request. The attention view and the notifier read it; a row stops
 *   counting when its `period_end` passes.
 * - `notification_deliveries.kind` admits `spend`: replaced rather than added beside, as 0049
 *   replaced a block reason's check, because two checks would refuse the new value through the old.
 *   Every value the old check allowed is still allowed.
 *
 * Idempotent: `IF NOT EXISTS`, and the backfill runs only when the ledger is still empty.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS spend_ledger (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      repo TEXT,
      actor TEXT,
      usd DOUBLE PRECISION NOT NULL CHECK (usd > 0),
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS spend_ledger_repo_at ON spend_ledger (repo, at)
    WHERE repo IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS spend_ledger_actor_at ON spend_ledger (actor, at)
    WHERE actor IS NOT NULL
  `;
  yield* sql`
    INSERT INTO spend_ledger (session_id, repo, actor, usd, at)
    SELECT s.id, s.repo, s.actor, a.cost_total, a.last_activity_at
    FROM session_activity a
    JOIN sessions s ON s.id = a.session_id
    WHERE a.cost_total > 0
      AND NOT EXISTS (SELECT 1 FROM spend_ledger)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS spend_alerts (
      scope TEXT NOT NULL CHECK (scope IN ('repo', 'actor')),
      subject TEXT NOT NULL,
      span TEXT NOT NULL CHECK (span IN ('day', 'month')),
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      threshold INT NOT NULL CHECK (threshold IN (80, 100)),
      limit_usd DOUBLE PRECISION NOT NULL,
      spent_usd DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, subject, span, period_start, threshold)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS spend_alerts_open ON spend_alerts (period_end)
  `;

  yield* sql`
    ALTER TABLE notification_deliveries
      DROP CONSTRAINT IF EXISTS notification_deliveries_kind_check
  `;
  yield* sql`
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_kind_check
      CHECK (kind IN ('question', 'approval', 'gate', 'failed', 'spend'))
  `;
});
