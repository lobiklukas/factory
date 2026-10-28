import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The model a session's root conversation is pinned to, `provider/modelId`, on the index row
 * (LOB-269).
 *
 * The log is the truth: Pi Durable commits the model into the root's `pi.agent` when the session's
 * owner first opens, and it never changes after that (a reopen keeps the model it started on). This
 * column is its index, so `listSessions` and every summary can name the model without folding a log
 * (R6). The control plane writes it right after an owner opens, and `rebuildIndexes` refolds it from
 * `pi.agent` like every other derived column (D7).
 *
 * Existing rows keep `NULL` until a rebuild refolds them or their owner next opens: the migration
 * does not read logs, and guessing the deployment's current model would be a claim about history a
 * replay or a role row may contradict.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT`;
});
