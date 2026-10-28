import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Presence (docs/design.md D12, LOB-18): who holds what, for how long, as one lease table.
 *
 * One row is one claim on one thing — `kind` says what sort of thing (`session` today: the process
 * that holds a session's log open; `card` is the board's dispatcher claim, wave 2), `key` which one.
 * A claim is only as good as its `expires_at`: the holder renews it on a heartbeat, and a holder that
 * dies stops renewing, so its claim lapses after the TTL and anyone may take it rather than the thing
 * hanging on a process that is gone.
 *
 * - `holder` is one process's identity, minted at boot, never reused.
 * - `home` is the holder's host and absolute session root — where its sessions' worktrees are: what a
 *   restarted process shares with the process it replaces, so it can take back what that one held
 *   without waiting out the TTL.
 * - `fence` counts the holders the row has had. It rises by one each time the claim changes hands,
 *   and a holder renews or releases only the claim it took (`holder` and `fence` both match), so a
 *   holder that lost its claim while it was not looking cannot renew it back from the new one.
 *
 * Not refolded by `rebuildIndexes` and not in the log: a lease is a fact about running processes,
 * which a log cannot know, and dropping every row costs nothing but a TTL's wait for nobody.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS leases (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      holder TEXT NOT NULL,
      home TEXT NOT NULL,
      fence BIGINT NOT NULL DEFAULT 1 CHECK (fence >= 1),
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      renewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (kind, key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS leases_holder ON leases (holder)
  `;
});
