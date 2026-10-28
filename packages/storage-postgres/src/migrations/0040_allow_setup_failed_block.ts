import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A card can be blocked `setup_failed` (S-env-setup): its run's worktree setup — the repo's declared
 * `install` and `build`, run before the agent's first turn — failed, so the run parked rather than
 * letting the agent guess. A reason of its own rather than `capability` or `transient`, because the
 * fix is the repo's or the machine's, and the card has to say which of its blocks that is.
 *
 * `tasks.blocked_reason`'s check is the column's own, so Postgres named it `tasks_blocked_reason_check`
 * when 0007 created the table. Replaced, not added beside: two checks would refuse the new reason
 * through the old one. Every value the old check allowed is still allowed, so no row is touched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_blocked_reason_check
  `;
  yield* sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_check CHECK (
      blocked_reason IN ('dependency', 'needs_input', 'capability', 'transient', 'setup_failed')
    )
  `;
});
