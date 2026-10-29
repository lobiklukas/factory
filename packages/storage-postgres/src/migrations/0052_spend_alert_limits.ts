import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Spend alerts follow the cap they were raised for (S-aggregate-spend-caps, a follow-up of 0051).
 *
 * - `spend_alerts` is keyed by the limit too. Keyed by (cap, window period, threshold) alone, an
 *   operator who raised a cap mid-window to unblock work never got an alert for the new cap: the
 *   rows of the old limit held the keys, `ON CONFLICT DO NOTHING` wrote nothing, the notifier saw
 *   an event id it had already delivered, and the old "reached its cap" row stayed on the
 *   attention page until the window ended. With the limit in the key, the new limit's 80% and 100%
 *   are alerts of their own.
 * - `spend_cap_limits` is what the deployment's caps are right now (`SPEND_CAPS`): one row per
 *   (scope, subject, window), replaced by each API process that boots with caps configured or
 *   cleared. The attention view lists only the alerts whose cap and limit are in it, so a cap that
 *   was raised, lowered or removed stops showing the alert of what it used to be, and one put back
 *   shows it again. An alert is history of a crossing; this table says whether the cap it crossed
 *   still stands.
 *
 * Idempotent: the primary key is replaced only when it does not already name `limit_usd`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = 'spend_alerts'::regclass
          AND i.indisprimary
          AND a.attname = 'limit_usd'
      ) THEN
        ALTER TABLE spend_alerts DROP CONSTRAINT spend_alerts_pkey;
        ALTER TABLE spend_alerts
          ADD PRIMARY KEY (scope, subject, span, period_start, threshold, limit_usd);
      END IF;
    END $$
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS spend_cap_limits (
      scope TEXT NOT NULL CHECK (scope IN ('repo', 'actor')),
      subject TEXT NOT NULL,
      span TEXT NOT NULL CHECK (span IN ('day', 'month')),
      limit_usd DOUBLE PRECISION NOT NULL CHECK (limit_usd > 0),
      PRIMARY KEY (scope, subject, span)
    )
  `;
});
