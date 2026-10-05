/**
 * Rebuilding the index tables from the log (docs/design.md D7, docs/features.md §3 A2).
 *
 * `sessions`, `session_activity`, and `repos` are derived: every column in them is a fold of
 * `commits` plus the session id, so losing any of them costs timeliness, not truth. This module is
 * the proof of that, and the recovery path: it folds every log the `commits` table holds and
 * rewrites the three indexes to match.
 *
 * Only logs whose id is a session id are indexed: the `commits` table is shared with Pi Durable
 * logs that are not sessions (the harness suite's fixtures, the M0 spike), and a session index row
 * for one of those would be a lie the rest of the control plane then fails to parse.
 *
 * What it deliberately keeps, because the log does not know it:
 *
 * - `repos.url` and `repos.local_path` — operator input. A slug a log names is added with no URL,
 *   an already-registered slug keeps what it has.
 * - `sessions.request_id` — the client's deduplication key, which was never committed.
 *
 * What it always answers from the fold: title (`factory.title` entries), repo and base ref
 * (`factory.session`), spend (`pi.usage`), created/last activity (`commits.committed_at`), and
 * status — always `idle`, because a rebuild runs in a process that owns nothing (D8).
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SessionError } from "@repo/domain/Session";
import {
  SessionError as SessionErrorClass,
  SessionId,
} from "@repo/domain/Session";
import { readSessionLog } from "@repo/harness";
import { PostgresStorage } from "@repo/storage-postgres";

export type RebuildReport = {
  /** Logs whose index row was (re)written. */
  readonly sessions: number;
  /** Distinct repos the logs named. */
  readonly repos: number;
  /** Index rows for sessions with no log at all, which a rebuild removes. */
  readonly removed: number;
};

type LogRow = {
  readonly logId: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
};

type FoldedRow = {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly baseRef: string | null;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly costTotal: number;
};

const storageError = (what: string, cause: unknown): SessionError =>
  new SessionErrorClass({
    code: "storage",
    message: `${what}: ${String(cause)}`,
  });

export const rebuildIndexes: Effect.Effect<
  RebuildReport,
  SessionError,
  SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient;

  const logs = yield* sql<LogRow>`
    SELECT
      log_id,
      to_char(min(committed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(max(committed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_activity_at
    FROM commits
    GROUP BY log_id
    ORDER BY log_id
  `;

  const folded: FoldedRow[] = [];
  for (const log of logs) {
    if (!Schema.is(SessionId)(log.logId)) continue;
    const storage = yield* Effect.tryPromise({
      try: () => PostgresStorage.reader(sql, log.logId),
      catch: (cause) => storageError(`open log ${log.logId}`, cause),
    });
    const sessionLog = yield* readSessionLog(storage).pipe(
      Effect.tapError(() => Effect.promise(() => storage.dispose())),
    );
    yield* Effect.promise(() => storage.dispose());

    const title = sessionLog.entries
      .filter((entry) => entry.kind === "title")
      .at(-1)?.text;
    const costTotal = sessionLog.usage.models.reduce(
      (total, model) => total + model.usage.costTotal,
      0,
    );
    const repo =
      sessionLog.binding.repo === "" ? null : sessionLog.binding.repo;
    folded.push({
      id: log.logId,
      title: title ?? "",
      repo,
      baseRef: repo === null ? null : sessionLog.binding.baseRef,
      createdAt: log.createdAt,
      lastActivityAt: log.lastActivityAt,
      costTotal,
    });
  }

  const repoDefaults = new Map<string, string>();
  for (const row of folded) {
    if (row.repo === null || repoDefaults.has(row.repo)) continue;
    repoDefaults.set(row.repo, row.baseRef ?? "main");
  }

  for (const row of folded) {
    yield* sql`
      INSERT INTO sessions (id, title, repo, base_ref, created_at)
      VALUES (${row.id}, ${row.title}, ${row.repo}, ${row.baseRef}, ${row.createdAt}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        repo = EXCLUDED.repo,
        base_ref = EXCLUDED.base_ref,
        created_at = EXCLUDED.created_at
    `;
    yield* sql`
      INSERT INTO session_activity (session_id, status, cost_total, last_activity_at)
      VALUES (${row.id}, 'idle', ${row.costTotal}, ${row.lastActivityAt}::timestamptz)
      ON CONFLICT (session_id) DO UPDATE SET
        status = 'idle',
        cost_total = EXCLUDED.cost_total,
        last_activity_at = EXCLUDED.last_activity_at
    `;
  }

  for (const [slug, baseRef] of repoDefaults) {
    // A slug a log names is registered with no URL; an operator's URL and checkout survive.
    yield* sql`
      INSERT INTO repos (slug, default_base_ref)
      VALUES (${slug}, ${baseRef})
      ON CONFLICT (slug) DO NOTHING
    `;
  }

  // Index rows that can no longer be true: an id that is not a session's, or a log that is gone.
  const present = yield* sql<{ id: string }>`SELECT id FROM sessions`;
  const strays = present
    .filter((row) => !Schema.is(SessionId)(row.id))
    .map((row) => row.id);
  if (strays.length > 0) {
    yield* sql`DELETE FROM sessions WHERE id = ANY(${strays})`;
  }
  const gone = yield* sql<{ count: string }>`
    WITH deleted AS (
      DELETE FROM sessions
      WHERE id NOT IN (SELECT DISTINCT log_id FROM commits)
      RETURNING 1
    )
    SELECT count(*)::text AS count FROM deleted
  `;

  return {
    sessions: folded.length,
    repos: repoDefaults.size,
    removed: strays.length + Number(gone[0]?.count ?? 0),
  };
}).pipe(
  Effect.mapError((cause) =>
    Schema.is(SessionErrorClass)(cause)
      ? cause
      : storageError("rebuild indexes", cause),
  ),
);
