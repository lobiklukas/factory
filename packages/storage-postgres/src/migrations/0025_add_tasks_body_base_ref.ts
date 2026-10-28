import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * What a card says, where its runs start, and where it came from (LOB-260; docs/board.md B1).
 *
 * - `body` is the card's description in markdown, quoted verbatim into every run's prompt as its
 *   `task_body` section. `''` is a card with none — every card made before this column — which gets
 *   no section, so the column is `NOT NULL DEFAULT ''` rather than nullable: there is one way to
 *   have no body.
 * - `base_ref` is the ref a run on the card cuts its worktree from when the run names none. `NULL`
 *   is the repository's own default (`repos.default_base_ref`), as before.
 * - `external_ref` is the tracker issue the card was filed from — a URL or a key. `NULL` is none.
 *
 * All three are input, like the title: `createTask` writes them into the row and into the `created`
 * event in one transaction, so the card stays derivable from `task_events` (B3). Nothing here is
 * backfilled — a card from before has no body, no base ref and no external ref, in its row and in
 * its history alike.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS base_ref TEXT,
      ADD COLUMN IF NOT EXISTS external_ref TEXT
  `;
});
