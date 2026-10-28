import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The head each of a card's PRs was last reported at (LOB-241): what `review_verdict` judges the
 * review of.
 *
 * The review trigger opens one run per head (LOB-36), and a delivery for a head that already has a
 * run is a replay that writes no `task_runs` row. So the newest review run is not the review of the
 * PR's newest head once a push returns the PR to a head it had before (a force-push back to A after
 * B): A's `synchronize` replays A's old run, and B's run stays the newest. This row is the fact the
 * run rows cannot carry — which head the newest `pull_request` delivery named — written by every
 * review delivery for a card's PR, a replay included, before its run is opened, so a head whose run
 * is still being created (or could not be, when the head was not fetchable) is already the head the
 * gate asks about.
 *
 * - `pr_url` is the PR's page (`html_url`), what a review run's target records; `api_url` its API
 *   resource, which a session's `pr_url` may record instead.
 * - `reported_at` is the delivery's `pull_request.updated_at` when it names one, the time it was
 *   received otherwise; a delivery older than the row (GitHub redelivering a past event) does not
 *   move it back.
 *
 * Idempotent: `IF NOT EXISTS`. Nothing is backfilled — a PR with no row is judged as before, on its
 * newest review run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_heads (
      pr_url TEXT PRIMARY KEY,
      api_url TEXT,
      task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      head TEXT NOT NULL,
      reported_at TIMESTAMPTZ NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS review_heads_by_task ON review_heads (task_id)
  `;
});
