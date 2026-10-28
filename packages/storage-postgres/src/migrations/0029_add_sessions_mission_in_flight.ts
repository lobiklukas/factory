import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Whether a session has a mission in flight (LOB-231): the sessions a restarted control plane
 * reopens on its own, so a mission a shutdown interrupted resumes in the phase it died in rather
 * than waiting, `pending` in its log, for a caller who never comes.
 *
 * A mission is durable work nobody is talking to. Pi Durable keeps it `pending` across a close and
 * schedules it again once the log's harness is reopened and resumed — but nothing reopens a
 * session's log until a client sends it something, and a mission's progress does not depend on a
 * client. This column is how the boot finds the logs to reopen without opening every log it has.
 *
 * It mirrors the session's live task graph, written by the owner's activity projection whenever the
 * graph changes (true while a `factory.mission` task is live, false once none is) and by
 * `startMission` as it returns. A row left `true` by a process that died between a mission settling
 * and the projection writing it costs one reopen at the next boot, which finds nothing to resume and
 * clears it. The partial index keeps the boot's query to the handful of rows that are set.
 *
 * `mission_session_root` is the session root of the process that marked it, resolved to an absolute
 * path, and the boot resumes only the rows marked under its own root. A session's worktree lives
 * under the root (`<root>/<id>`), so a process with another root would cut a fresh worktree beside
 * the one the mission was working in; and the verify skills boot throwaway APIs on the shared
 * development database with roots of their own, which must not take over the missions of the
 * instance that marked them. Two processes on one database *and* one root are still one deployment
 * to this column: it is not an ownership lease (docs/design.md D12, as built for LOB-231).
 *
 * Not refolded from the log by `rebuildIndexes`, like the workspace columns (0023): the upsert never
 * writes it, so a rebuild over existing rows keeps it, and a row the rebuild inserts reads `false`
 * until its session is next owned.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS mission_in_flight BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS mission_session_root TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS sessions_mission_in_flight
    ON sessions (mission_session_root, id) WHERE mission_in_flight
  `;
});
