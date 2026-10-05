import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The session index.
 *
 * `commits` is the truth (D7) and this table is a droppable cache of what the control plane has to
 * answer without folding a log: which sessions exist, what they are called, and when they were
 * created. `id` is the session's `log_id`, so the join back to the log needs no lookup table.
 *
 * `title` is also committed into the log as a `factory.title` entry, so dropping this table loses
 * nothing but the index. `request_id` is the client's deduplication key: a retried create returns
 * the same session instead of making a second one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      request_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
});
