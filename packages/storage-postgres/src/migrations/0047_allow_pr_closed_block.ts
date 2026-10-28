import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A card can be blocked `pr_closed` (C20): its PR was closed without being merged, as GitHub's signed
 * `pull_request` delivery or the PR-state read when the card is opened reports it. A reason of its
 * own, because what unblocks it is a person's call about the PR — reopen it, or start a run that opens
 * another — and the card has to say that is what it waits on.
 *
 * Replaced, not added beside, as 0040 replaced it: two checks would refuse the new reason through the
 * old one. Every value the old check allowed is still allowed, so no row is touched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_blocked_reason_check
  `;
  yield* sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_check CHECK (
      blocked_reason IN ('dependency', 'needs_input', 'capability', 'transient', 'setup_failed', 'pr_closed')
    )
  `;
});
