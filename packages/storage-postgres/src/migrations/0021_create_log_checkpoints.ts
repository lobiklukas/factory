import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * One checkpoint of a log's fold, so opening a long log reads its tail rather than all of it
 * (LOB-186, closes the open half of R6).
 *
 * `PostgresStorage` folds every commit into Pi Durable's `MemoryStorage` on open. This row holds
 * that fold as it stood after commit `seq`, so an open restores it and folds only the commits after
 * `seq`. It is derived, like every table but `commits`: deleting any row, or all of them, costs one
 * full fold on the next open and nothing else.
 *
 * - `log_id` is the primary key: only the latest checkpoint is kept, and the single owner of a log
 *   is its only writer, so the newest write is the newest checkpoint.
 * - `shape` names the encoding and the Pi Durable release whose fold it encodes. A checkpoint whose
 *   shape is not the running one is ignored, so a dependency bump falls back to the fold instead of
 *   restoring a state the new release would read differently.
 * - `commit_hash` is `md5` of commit `seq`'s `writes` as written. Rows of `commits` are immutable,
 *   but the table can still be truncated (tests do) and a `log_id` reused, so an open serves a
 *   checkpoint only when commit `seq` of the log is still the commit it was taken after. There is no
 *   foreign key to `commits` for the same reason: it would make that `TRUNCATE` fail.
 * - `fold` is `bytea`: gzip of the fold's JSON (`compressFold` in `../Checkpoint.ts`). A fold is
 *   as large as the log's live records and an open past its tail is mostly moving it, so it travels
 *   compressed. Postgres never parses it, which is also why the strings `commits.writes` keeps in
 *   `json` for (lone surrogates, U+0000) cannot be rejected here. `STORAGE EXTERNAL` because
 *   compressing gzip again is wasted work.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE log_checkpoints (
      log_id TEXT PRIMARY KEY,
      seq BIGINT NOT NULL CHECK (seq >= 1),
      shape TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      fold BYTEA NOT NULL,
      written_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  yield* sql`ALTER TABLE log_checkpoints ALTER COLUMN fold SET STORAGE EXTERNAL`;
});
