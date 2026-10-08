import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { BoardColumn } from "@repo/domain/Task";

/**
 * The board's tables and the default pipeline (docs/board.md B1–B6).
 *
 * Cards are rows, not a log (B3): `tasks` holds the current state of each card and `task_events`
 * its append-only history, one transaction per mutation, with `revision` on the task for optimistic
 * concurrency. A board-scope log under `commits` was rejected for the same reason D17 rejects it
 * for sessions — a log is a single-writer resource requiring owner routing, and a card is _input_:
 * a person typed it, and there is no log to replay it from.
 *
 * Definitions and instances are separate because B2 separates them: a definition declares columns
 * and their policies, an instance binds one repository to a definition version, and every task
 * pins the version it started under. One row per definition _version_ (never an update in place) is
 * what makes that pin meaningful — editing a definition cannot mutate work in flight.
 *
 * The contracts these rows satisfy are `packages/domain/src/Task.ts`. **No `PostgresStorage` method
 * is added here, and none is needed for DDL plus a seed:** every reader and writer of these tables
 * lands with the service that owns them (LOB-59 for cards, LOB-60 for runs and events), which is
 * also where the revision CAS and the declared-transition refusals live. The issue text named
 * "the PostgresStorage methods they need" because it could not know in advance; what the tables
 * need for *this* issue is the migration and the seed, and both are here. `task_runs` is created
 * here because B1 makes a run a first-class thing a task owns, and its typed contract
 * (`TaskRun`, in `Task.ts`) is in this change too — what LOB-60 owns is the run-start and
 * run-finish events and the `factory.task` log document.
 *
 * The seed is idempotent: `ON CONFLICT (id, version) DO NOTHING`, so a second run over the same
 * database leaves one definition row rather than a second copy of the pipeline.
 *
 * The DDL is idempotent for the same reason — `CREATE TABLE IF NOT EXISTS` and
 * `CREATE INDEX IF NOT EXISTS` — because the acceptance criterion is that a *second migration
 * run* over one database leaves one definition row, and a run that dies on
 * `relation "board_definitions" already exists` never reaches the seed. The cost is that a table
 * which already exists under a different definition is silently kept rather than rejected; that is
 * Postgres's own behaviour for `IF NOT EXISTS`, and a migration that has run far enough to leave a
 * table behind has already committed to this file's shape.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_definitions (
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      name TEXT NOT NULL,
      columns JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_instances (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (definition_id, definition_version)
        REFERENCES board_definitions (id, version)
    )
  `;

  // `revision` is the optimistic-concurrency token (B3), so it starts at 1 for a card that exists
  // and is bumped by every mutation. `column` is a name under the task's pinned definition version,
  // not a position: B9 rejects a drag-ordered queue as a second source of truth about what is next.
  yield* sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES board_instances (id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      "column" TEXT NOT NULL,
      repo TEXT,
      definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'normal')),
      blocked_reason TEXT CHECK (blocked_reason IN ('dependency', 'needs_input', 'capability', 'transient')),
      blocked_column TEXT,
      blocked_note TEXT,
      blocked_since TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- B4: blocked is a card state, not a column, so the three columns that define a block
      -- travel together — a card is either blocked (all three set) or not (all three null), never
      -- half-way. blocked_note is optional metadata and sits outside that rule.
      CONSTRAINT tasks_blocked_is_all_or_nothing CHECK (
        (blocked_reason IS NULL) = (blocked_column IS NULL)
        AND (blocked_reason IS NULL) = (blocked_since IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS tasks_by_board ON tasks (board_id, priority, created_at)
  `;

  // Append-only by convention, not by trigger: a card's history is the audit trail for a gated
  // move (B5), so the writer must never update or delete an event. The database does **not**
  // enforce that here — `commits` does, with `commits_append_only` in `0002_create_commits.ts`,
  // and this table has no equivalent, because a `BEFORE DELETE` trigger would reject this
  // migration's own `ON DELETE CASCADE` from `board_instances`. Adding one is a decision about
  // which of the two gives, and the case in `PostgresStorage.test.ts` asserts the real behaviour
  // (an event can be rewritten and deleted today) so the gap is visible rather than assumed away.
  // `revision` is the revision the mutation expected, which is what makes a stale write detectable
  // after the fact as well as at the time.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS task_events_by_task ON task_events (task_id, id)
  `;

  // A run is exactly one Pi Durable session (B1), so `session_id` is the run's `log_id` and the
  // log is the truth for what the run did — this row is the index, not the record. `column` is the
  // column the run was started from, whose `requires[]` the run must satisfy on exit.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      "column" TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS task_runs_by_task ON task_runs (task_id, started_at)
  `;

  // The default pipeline, B4. `requires[]` holds only what is machine-checkable on exit (B8): a
  // `key` the refusal names and a `description` a person reads. `intake` and the two terminal
  // columns have empty `requires` — nothing auto-starts and nothing is checked on the way out of
  // `done` or `canceled`. `planning` and `review` each carry B5's human gate as a requirement,
  // because a human move is a fact the board has to be able to name even though no code checks it.
  // The seed's JSON is produced by the domain schema's own encoder rather than `JSON.stringify`, so
  // the value is schema-valid by construction: a typo in the literal above is a decode failure here
  // rather than a bad row in the database. **What is not claimed here:** that the *column* is
  // checked. `board_definitions.columns` is unconstrained JSONB, so any other writer can store a
  // column set `BoardColumn` rejects — the case in `PostgresStorage.test.ts` that writes exactly
  // that proves it. The encoder's refusal on the seed path is the migration's own decode failing
  // loudly; no case in this diff mutates the encoder to witness it.
  const columns = [
    { name: "intake", kind: "resting", skills: [], requires: [] },
    {
      name: "specifying",
      kind: "working",
      role: "specifier",
      skills: [],
      requires: [
        {
          key: "spec_doc",
          description:
            "a spec doc, gaps declared (explicitly [] when there are none)",
        },
      ],
    },
    {
      name: "planning",
      kind: "working",
      role: "planner",
      skills: [],
      requires: [
        { key: "plan_doc", description: "a plan doc" },
        {
          key: "human_move",
          description: "a human move (B5's plan approval gate)",
        },
      ],
    },
    {
      name: "building",
      kind: "working",
      role: "builder",
      skills: [],
      requires: [
        { key: "run_completed", description: "a run that completed" },
        { key: "non_empty_diff", description: "a non-empty diff" },
        { key: "pr_link", description: "a PR link" },
      ],
    },
    {
      name: "review",
      kind: "working",
      role: "reviewer",
      skills: [],
      requires: [
        { key: "review_verdict", description: "a review verdict" },
        { key: "human_merge", description: "a human merge (B5's merge gate)" },
      ],
    },
    { name: "done", kind: "terminal", skills: [], requires: [] },
    { name: "canceled", kind: "terminal", skills: [], requires: [] },
  ] as const;

  // `encodeEffect`, not `encodeSync`: this runs inside an Effect generator, and the typed error
  // channel is the one a migration failure should travel.
  const columnsJson = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(BoardColumn)),
  )(columns);

  yield* sql`
    INSERT INTO board_definitions (id, version, name, columns)
    VALUES ('default', 1, 'Default pipeline', ${columnsJson}::jsonb)
    ON CONFLICT (id, version) DO NOTHING
  `;
});
