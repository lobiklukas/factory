import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Notification settings (F21): what the dashboard's settings page stores and the notifier reads on
 * every pass, so a change needs no restart. Control-plane state like `secrets`: `rebuildIndexes`
 * neither writes nor clears it.
 *
 * - `notification_kinds` holds one row per kind a person has switched, on or off, for the whole
 *   deployment. A kind with no row follows `NOTIFY_TYPES`, so a fresh install behaves as before.
 * - `notification_sinks` is a person's own destinations: `actor` is the control-plane actor that
 *   added it (the credential's, LOB-20) and `config` is what the sink needs to send — `{address}` for
 *   `email`, `{endpoint, p256dh, auth}` for `web_push`. A Web Push subscription is useless without
 *   the deployment's VAPID private key, which is never stored here. `expired_at` is set, with
 *   `enabled` cleared, when the push service answers 404 or 410: the subscription is gone and the
 *   page says so.
 *
 * Neither table is part of `notification_deliveries`' exactly-once: a sink's ledger identity is a
 * fingerprint of its destination (`email:<digest of the address>`), not this row's id, so removing
 * a sink and adding the same address back is the same destination and is sent nothing twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS notification_kinds (
      kind TEXT PRIMARY KEY CHECK (kind IN ('question', 'approval', 'gate', 'failed', 'spend')),
      enabled BOOLEAN NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS notification_sinks (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('email', 'web_push')),
      config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      expired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS notification_sinks_by_actor ON notification_sinks (actor)
  `;
});
