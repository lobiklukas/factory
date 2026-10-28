import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Whether a session has a run in flight, and under which session root (LOB-25): the sessions a
 * restarted control plane reopens on its own, so a run a dead process was in the middle of carries
 * on rather than sitting placed and unanswered until somebody sends the session another message.
 *
 * The twin of `mission_in_flight` (0029), for the conversation rather than a mission. A process that
 * dies mid-run — a SIGTERM's close, or a SIGKILL that runs no finalizer and writes nothing — leaves
 * the run's submission placed in the log, and any owner that opens the log continues it. Nothing
 * opens it until a client acts on the session, though, and a client that reconnects only to watch
 * reads a fold. This column is how the boot finds those logs without opening every log it has.
 *
 * One nullable column rather than a flag and a root: `NULL` is "no run in flight", and a value is
 * the absolute session root of the process whose run it was. The owner's activity projection writes
 * it when the run starts and clears it when the run ends; a release of the session's workspace
 * clears it too, because a released session takes no new run. A row left set by a process that died
 * between a run ending and the projection writing it costs one reopen at the next boot, which finds
 * nothing to continue and clears it. The boot reads only the rows under its own root, for the reason
 * 0029 gives: another root would cut a fresh worktree beside the run's, and the verify skills' API
 * instances share the development database under roots of their own.
 *
 * Not refolded from the log by `rebuildIndexes`, like 0029's columns: the upsert never writes it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS run_session_root TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS sessions_run_in_flight
    ON sessions (run_session_root, id) WHERE run_session_root IS NOT NULL
  `;
});
