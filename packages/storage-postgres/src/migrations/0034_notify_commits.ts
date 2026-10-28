import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The bus (docs/design.md D12, LOB-18): every commit says so on the `factory_commits` channel.
 *
 * The payload is a cursor, `{"log_id": …, "seq": …}`, never the commit: `NOTIFY` payloads cap at
 * 8000 bytes and D7 makes the log the truth, so a listener that hears a cursor reads the log from it.
 * A notification is a hint — Postgres delivers it after the inserting transaction commits, and drops
 * it for a listener that was not connected — so a reader that missed one still converges on its next
 * read of the log.
 *
 * One channel for every log rather than one per session: a process listens once, whatever it
 * follows, and a channel name is an identifier capped at 63 bytes while a `log_id` is anybody's text.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE OR REPLACE FUNCTION commits_notify() RETURNS trigger AS $$
    BEGIN
      -- A log id too long for the payload is not announced rather than failing its commit: the
      -- hint is optional, the commit is not, and a follower's poll still reads it.
      IF octet_length(NEW.log_id) <= 7900 THEN
        PERFORM pg_notify(
          'factory_commits',
          json_build_object('log_id', NEW.log_id, 'seq', NEW.seq)::text
        );
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `;

  yield* sql`
    DROP TRIGGER IF EXISTS commits_notify ON commits
  `;

  yield* sql`
    CREATE TRIGGER commits_notify
    AFTER INSERT ON commits
    FOR EACH ROW EXECUTE FUNCTION commits_notify()
  `;
});
