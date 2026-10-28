import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Notifications (S-notifications): the failures a person is told about, and the ledger that says
 * who was told what.
 *
 * - `run_failures` is one row per run that ended without an answer because it failed: a budget stop
 *   (LOB-163, `reason = 'budget'`) or a model request Pi Durable gave up on (`model_error`). The
 *   session's activity projection writes it as it sees the stop — the attention view's approvals and
 *   questions are rows already, and a failed run was the one event a notifier could not read from a
 *   row. Keyed by the log entry that announced the stop, so a projection that sees the same entry
 *   again (a reopen replays the snapshot) writes nothing twice. Best-effort like `task_runs`'
 *   `finished_at`, and not refolded by `rebuildIndexes`: a row that is missing is a notification not
 *   sent, never a wrong one.
 * - `notification_deliveries` is the notifier's outbox and its memory: one row per event per sink,
 *   keyed by the event's id (`approval:<session>:<request>`, `question:<card>:<since>`, …). Inserting
 *   the row is the claim that the event will be delivered there, and `delivered_at` is the proof it
 *   was, so a restarted process — or a second replica — that sees the same pending approval inserts
 *   nothing and sends nothing. `claimed_at` and `attempts` are the retry: a delivery whose send
 *   failed (or whose process died mid-send) is claimed again once its claim is older than the retry
 *   interval, up to a bounded number of attempts, and `last_error` says why the last one failed.
 *
 * The pending index serves the flush, which reads only the undelivered rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS run_failures (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('budget', 'model_error')),
      detail TEXT NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, entry_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS run_failures_recent ON run_failures (failed_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      event_id TEXT NOT NULL,
      sink TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'gate', 'failed')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      delivered_at TIMESTAMPTZ,
      last_error TEXT,
      PRIMARY KEY (event_id, sink)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS notification_deliveries_pending
    ON notification_deliveries (created_at) WHERE delivered_at IS NULL
  `;
});
