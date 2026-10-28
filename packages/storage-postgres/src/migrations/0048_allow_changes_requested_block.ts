import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A card can be blocked `changes_requested` (C21): a review of its PR requested changes, as GitHub's
 * signed `pull_request_review` delivery reports it. A reason of its own, because what the card waits
 * on is a person starting the run that addresses the review — the review is on the card's thread,
 * and the next run on the card reads it and lifts the block.
 *
 * Replaced, not added beside, as 0047 replaced it: two checks would refuse the new reason through
 * the old one. Every value the old check allowed is still allowed, so no row is touched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_blocked_reason_check
  `;
  yield* sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_check CHECK (
      blocked_reason IN ('dependency', 'needs_input', 'capability', 'transient', 'setup_failed', 'pr_closed', 'changes_requested')
    )
  `;
});
