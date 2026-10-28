import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A Linear-sourced card's questions, asked in Linear (T5): the agent session each issue's questions
 * ride in, and the ledger of questions already posted.
 *
 * - `linear_agent_sessions` is one row per issue: the id of the Linear agent session the factory
 *   opened on it, so every later question on that issue is posted into the same thread and a reply in
 *   it comes back on a session the factory knows. The first question opens it.
 * - `linear_elicitations` is one row per question posted, keyed by the ask's id
 *   (`<session>:<tool call>`, the key `TaskService.ask` already dedupes the card's comment on). The
 *   row is written after Linear accepted the activity, so a replayed ask finds it and posts nothing,
 *   and an ask whose post failed has none and is posted by its replay. A process that dies between
 *   Linear accepting the activity and this row repeats that one activity — at-least-once, with the
 *   duplicate confined to a crash inside one request.
 *
 * Deliberately no foreign keys, as `webhook_deliveries` has none: what was posted to Linear is a fact
 * about Linear that outlives the card or the session it was posted for.
 * Idempotent: each statement is a no-op on a second run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_agent_sessions (
      issue_id TEXT PRIMARY KEY,
      agent_session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_elicitations (
      ask_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
});
