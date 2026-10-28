/**
 * Rebuilding the index tables from the log (docs/design.md D7, docs/features.md §3 A2).
 *
 * `sessions`, `session_activity`, and `repos` are derived: every column in them is a fold of
 * `commits` plus the session id — but for the few listed below — so losing any of them costs
 * timeliness, not truth. This module is the proof of that, and the recovery path: it folds every
 * log the `commits` table holds and rewrites the three indexes to match.
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
 * - `sessions.workspace_released_at` and `workspace_release_reason` (LOB-268) — that a terminal event
 *   tore the session's worktree and branch down. It is a fact about the filesystem, done outside any
 *   log, so the fold cannot recover it: the upsert never writes these columns, so a rebuild over
 *   existing rows keeps them. Dropping the `sessions` table is the one repair that loses them — every
 *   released session would read as unreleased, cut a fresh worktree at its base on its next owner
 *   acquisition, and take a new run. That is the exception to D7's "droppable" recorded in
 *   `docs/design.md`.
 * - `sessions.mission_in_flight` (LOB-231) — whether a mission is live in the session's task graph,
 *   which the owner's activity projection writes. The upsert never writes it either, so a rebuild
 *   keeps it; a row the rebuild inserts reads `false` until its session is next owned, which costs a
 *   mission in flight its resume at the next boot, not its log.
 * - `sessions.run_session_root` (LOB-25) — the same, for a run in flight in the session's
 *   conversation: kept by a rebuild, `NULL` on a row the rebuild inserts, which costs an interrupted
 *   run its resume at the next boot (it still continues when the session is next owned).
 *
 * What it always answers from the fold: title (`factory.title` entries), repo, base ref and a
 * caller-named branch (`factory.session`), the parent a fork was taken from (`factory.fork`), the
 * actor its spend is attributed to (`factory.actor`, LOB-162), the model the root conversation is
 * pinned to (`pi.agent`, LOB-269), the PR link (`factory.pr`), when it merged and was reverted
 * (`factory.merge`, LOB-44), the approvals a session asked for and the decisions that settled them
 * (`factory.approval.requested` / `.decided` / `.used` → `session_approvals`), spend (`pi.usage`),
 * created/last activity (`commits.committed_at`), and status — always `idle`, because a rebuild runs
 * in a process that owns nothing (D8).
 *
 * How it is shaped, because a recovery path is only as good as how long it takes to run: the fold
 * reads every session log in pages (`PostgresStorage.readers`) and writes the index rows in batches,
 * so its cost is in the number of commits and rows rather than in the number of round trips. What
 * it computes is unchanged by either — LOB-115 measured the batched fold writing byte-identical
 * `sessions` and `session_activity` rows, 25x faster.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { PageStrings } from "@repo/domain/Page";
import type { SessionError } from "@repo/domain/Session";
import {
  SessionError as SessionErrorClass,
  SessionId,
} from "@repo/domain/Session";
import {
  readPinnedModelKey,
  readSessionLog,
  usageCostTotal,
} from "@repo/harness";
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

/** One `session_approvals` row as the fold renders it; `null` where a decision has not settled. */
type FoldedApproval = {
  readonly sessionId: string;
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly decision: string | null;
  readonly actor: string | null;
  readonly decidedAt: string | null;
  /** When a gated call spent the approval (LOB-52); `null` while it is unused. */
  readonly usedAt: string | null;
};

type FoldedRow = {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly baseRef: string | null;
  /** The branch a caller named, when it named one (LOB-197). */
  readonly branch: string | null;
  readonly forkedFrom: string | null;
  /** Who the session's spend is attributed to (LOB-162), when anyone was. */
  readonly actor: string | null;
  /** The model the root is pinned to, `provider/modelId` (LOB-269), when the log has a root. */
  readonly model: string | null;
  readonly prUrl: string | null;
  /** When that PR merged and when a revert undid it (LOB-44), from `factory.merge`. */
  readonly prMergedAt: string | null;
  readonly prRevertedAt: string | null;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly costTotal: number;
};

const storageError = (what: string, cause: unknown): SessionError =>
  new SessionErrorClass({
    code: "storage",
    message: `${what}: ${String(cause)}`,
  });

/**
 * Folded index rows per `INSERT … SELECT FROM unnest(…)`, so the write side costs a bounded number
 * of round trips instead of one per row. It bounds a statement's payload, not what the fold means:
 * every row still lands, and the conflict clauses are the ones that were there before.
 */
const WRITE_BATCH_ROWS = 1_000;

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

  // One batched read per group of session logs, not one reader per log: the per-log path costs
  // several sequential round trips for every log, which is what made the fold grow with the log
  // table rather than with the number of commits in it. The fold below is unchanged — the stores
  // `readers` returns are Pi Durable's own `MemoryStorage`, so a session reads here exactly as it
  // read through `PostgresStorage.reader`. From the first commit, never from a checkpoint: this is
  // the recovery path, and a checkpoint is itself a derived row (LOB-186, LOB-243).
  const sessionLogs = logs.filter((log) => Schema.is(SessionId)(log.logId));
  const folds = yield* Effect.tryPromise({
    try: () =>
      PostgresStorage.readers(
        sql,
        sessionLogs.map((log) => log.logId),
        { checkpoints: false },
      ),
    catch: (cause) => storageError("read the session logs", cause),
  });

  const folded: FoldedRow[] = [];
  const approvals: FoldedApproval[] = [];
  const taskRuns: {
    id: string;
    taskId: string;
    sessionId: string;
    column: string;
    startedAt: string;
  }[] = [];
  const pages: {
    sessionId: string;
    name: string;
    kind: string;
    content: string;
    links: string;
    sources: string;
  }[] = [];
  for (const log of sessionLogs) {
    const storage = folds.get(log.logId);
    // `readers` returns a store for every id it was given and this loop walks the same list, so a
    // miss is a broken promise rather than a shape — and it is loud rather than a skip, because a
    // skip writes an index that is missing a session and a count that agrees with the omission.
    if (storage === undefined)
      return yield* storageError(
        `fold log ${log.logId}`,
        "no store for a log the batched read was asked for",
      );
    const sessionLog = yield* readSessionLog(storage);

    const title = sessionLog.entries
      .filter((entry) => entry.kind === "title")
      .at(-1)?.text;
    // Both `pi.usage` buckets, models and tools: the live writer (`SessionService`'s projector)
    // adds them the same way, so a rebuilt `cost_total` matches the number the list showed before
    // the index was emptied. Model-only would quietly drop a tool's spend (LOB-153).
    const costTotal = usageCostTotal(sessionLog.usage);
    const repo =
      sessionLog.binding.repo === "" ? null : sessionLog.binding.repo;
    folded.push({
      id: log.logId,
      title: title ?? "",
      repo,
      baseRef: repo === null ? null : sessionLog.binding.baseRef,
      branch: sessionLog.binding.branch ?? null,
      forkedFrom: sessionLog.forkedFrom ?? null,
      actor: sessionLog.actor ?? null,
      model: sessionLog.model ?? null,
      prUrl: sessionLog.pr?.url ?? null,
      prMergedAt:
        sessionLog.merge === undefined || sessionLog.merge.mergedAt === ""
          ? null
          : sessionLog.merge.mergedAt,
      prRevertedAt: sessionLog.merge?.revert?.at ?? null,
      createdAt: log.createdAt,
      lastActivityAt: log.lastActivityAt,
      costTotal,
    });
    for (const record of sessionLog.approvals) {
      approvals.push({
        sessionId: log.logId,
        requestId: record.requestId,
        action: record.action,
        detail: record.detail,
        requestedAt: record.requestedAt,
        decision: record.decision?.decision ?? null,
        actor: record.decision?.actor ?? null,
        decidedAt: record.decision?.decidedAt ?? null,
        usedAt: record.usedAt ?? null,
      });
    }
    // The pages are the `factory.page` entries, not the documents: a fold reads `commits`, and a
    // document is a separate record (LOB-204). Each row is written with its citations as JSON text,
    // so a rebuild reproduces a page that cites a session the index no longer holds.
    for (const page of sessionLog.pages) {
      pages.push({
        sessionId: log.logId,
        name: page.name,
        kind: page.kind,
        content: page.content,
        links: yield* Schema.encodeEffect(PageStrings)(page.links).pipe(
          Effect.mapError((cause) =>
            storageError("encode a page's links", cause),
          ),
        ),
        sources: yield* Schema.encodeEffect(PageStrings)(page.sources).pipe(
          Effect.mapError((cause) =>
            storageError("encode a page's sources", cause),
          ),
        ),
      });
    }
    if (sessionLog.task !== undefined) {
      taskRuns.push({
        id: log.logId,
        taskId: sessionLog.task.taskId,
        sessionId: log.logId,
        column: sessionLog.task.column,
        // A run is its session (B1), created when the run starts: its first commit is the start.
        startedAt: log.createdAt,
      });
    }
  }

  const repoDefaults = new Map<string, string>();
  for (const row of folded) {
    if (row.repo === null || repoDefaults.has(row.repo)) continue;
    repoDefaults.set(row.repo, row.baseRef ?? "main");
  }

  // Two statements per batch of index rows rather than two per row: the fold's cost has to be in
  // the number of rows, not in the number of round trips it takes to write them.
  //
  // `NULLIF(…, '')` rather than passing nulls: the client's array encoder refuses an array whose
  // values are *all* null (it has no element to infer a type from), and a batch of scratch sessions
  // is exactly that for `repo` and `base_ref` — and a batch of sessions that are not forks, or have
  // no PR, or no actor, is exactly that for `forked_from`, `pr_url` and `actor` (and a batch of logs
  // with no root for `model`, and of unmerged PRs for `pr_merged_at` and `pr_reverted_at`, which
  // cross as text and are cast after the sentinel is gone). An empty string is never a legal slug, session id, URL, actor or
  // `provider/modelId`, so the sentinel cannot collide with a real value.
  //
  // `cost_total` crosses as text too: the client could not encode a number array holding an unpriced
  // session (`0`) beside a priced one (`0.02`) — "Failed to encode query" — so a rebuild of any
  // database with real spend in it failed (found by LOB-162's spend test, which rebuilds one).
  // `String` of a JS number is its shortest round-trip form, so the stored double is the one the
  // fold computed.
  for (let at = 0; at < folded.length; at += WRITE_BATCH_ROWS) {
    const batch = folded.slice(at, at + WRITE_BATCH_ROWS);
    const ids = batch.map((row) => row.id);
    yield* sql`
      INSERT INTO sessions (id, title, repo, base_ref, branch, forked_from, actor, model, pr_url, pr_merged_at, pr_reverted_at, created_at)
      SELECT
        id,
        title,
        NULLIF(repo, ''),
        NULLIF(base_ref, ''),
        NULLIF(branch, ''),
        NULLIF(forked_from, ''),
        NULLIF(actor, ''),
        NULLIF(model, ''),
        NULLIF(pr_url, ''),
        NULLIF(pr_merged_at, '')::timestamptz,
        NULLIF(pr_reverted_at, '')::timestamptz,
        created_at
      FROM unnest(
        ${ids}::text[],
        ${batch.map((row) => row.title)}::text[],
        ${batch.map((row) => row.repo ?? "")}::text[],
        ${batch.map((row) => row.baseRef ?? "")}::text[],
        ${batch.map((row) => row.branch ?? "")}::text[],
        ${batch.map((row) => row.forkedFrom ?? "")}::text[],
        ${batch.map((row) => row.actor ?? "")}::text[],
        ${batch.map((row) => row.model ?? "")}::text[],
        ${batch.map((row) => row.prUrl ?? "")}::text[],
        ${batch.map((row) => row.prMergedAt ?? "")}::text[],
        ${batch.map((row) => row.prRevertedAt ?? "")}::text[],
        ${batch.map((row) => row.createdAt)}::text[]::timestamptz[]
      ) AS folded(id, title, repo, base_ref, branch, forked_from, actor, model, pr_url, pr_merged_at, pr_reverted_at, created_at)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        repo = EXCLUDED.repo,
        base_ref = EXCLUDED.base_ref,
        branch = EXCLUDED.branch,
        forked_from = EXCLUDED.forked_from,
        actor = EXCLUDED.actor,
        model = EXCLUDED.model,
        pr_url = EXCLUDED.pr_url,
        pr_merged_at = EXCLUDED.pr_merged_at,
        pr_reverted_at = EXCLUDED.pr_reverted_at,
        created_at = EXCLUDED.created_at
    `;
    yield* sql`
      INSERT INTO session_activity (session_id, status, cost_total, last_activity_at)
      SELECT * FROM unnest(
        ${ids}::text[],
        ${batch.map(() => "idle")}::text[],
        ${batch.map((row) => String(row.costTotal))}::text[]::double precision[],
        ${batch.map((row) => row.lastActivityAt)}::text[]::timestamptz[]
      )
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

  // Fold `factory.approval.*` entries into `session_approvals`, so a rebuild recovers what is
  // waiting for a person (`listApprovals`) as well as what a snapshot shows. A part of the log is
  // authoritative for its session here, so a session's rows are replaced rather than merged: a
  // request the log no longer records is not pending, whatever the row said.
  //
  // The delete is one statement over every session with a request, *not* one per write batch: a
  // session's rows are contiguous in `approvals` but not aligned to a batch boundary, so a batch
  // that deleted its own sessions would clobber the first batch's rows for a session the two
  // batches share — a rebuild that loses rows its log still holds, which is the one thing this
  // recovery path may not do. Replacing a batch's worth of rows is an insert, not a delete, so
  // batching the writes costs nothing.
  //
  // `NULLIF(…, '')` for the same reason the `sessions` write above uses it: the client's array
  // encoder refuses an array whose values are all null, and a batch of requests nobody decided is
  // exactly that for `decision`, `actor` and `decided_at`.
  const approvalSessions = [...new Set(approvals.map((row) => row.sessionId))];
  if (approvalSessions.length > 0) {
    yield* sql`DELETE FROM session_approvals WHERE session_id = ANY(${approvalSessions}::text[])`;
  }
  for (let at = 0; at < approvals.length; at += WRITE_BATCH_ROWS) {
    const batch = approvals.slice(at, at + WRITE_BATCH_ROWS);
    yield* sql`
      INSERT INTO session_approvals (session_id, request_id, action, detail, requested_at, decision, actor, decided_at, used_at)
      SELECT
        session_id,
        request_id,
        action,
        detail,
        requested_at,
        NULLIF(decision, ''),
        NULLIF(actor, ''),
        NULLIF(decided_at, '')::timestamptz,
        NULLIF(used_at, '')::timestamptz
      FROM unnest(
        ${batch.map((row) => row.sessionId)}::text[],
        ${batch.map((row) => row.requestId)}::text[],
        ${batch.map((row) => row.action)}::text[],
        ${batch.map((row) => row.detail)}::text[],
        ${batch.map((row) => row.requestedAt)}::text[]::timestamptz[],
        ${batch.map((row) => row.decision ?? "")}::text[],
        ${batch.map((row) => row.actor ?? "")}::text[],
        ${batch.map((row) => row.decidedAt ?? "")}::text[],
        ${batch.map((row) => row.usedAt ?? "")}::text[]
      ) AS folded(session_id, request_id, action, detail, requested_at, decision, actor, decided_at, used_at)
    `;
  }

  // Fold `factory.task` documents into `task_runs`, so a rebuild recovers run→task links. A row the
  // rebuild re-creates starts at its session's first commit rather than at the rebuild. Its
  // `finished_at` is no fact any log holds (LOB-44, docs/design.md D7), so it is the session's last
  // activity — refolded from the log above, and the end the outcome metrics would read anyway —
  // as the fold reads every session idle. It cannot stay NULL: a board's run caps count a run
  // with no end as in flight (B9, LOB-71), so a rebuilt `task_runs` would hold every past run's
  // slot on a card that is not finished, refusing its card and board until each was discarded.
  // A rebuild frees slots rather than holding them: a run opened without a prompt loses its slot.
  // The one exception is a row whose `run_session_root` the rebuild kept (a run a dead process
  // left in flight, LOB-25): its end is left NULL for the boot's `resumeRuns`, which continues the
  // run and ends it at its next idle, or ends it at once if it had settled.
  for (const run of taskRuns) {
    yield* sql`
      INSERT INTO task_runs (id, task_id, session_id, "column", started_at, finished_at)
      SELECT ${run.id}, ${run.taskId}, ${run.sessionId}, ${run.column}, ${run.startedAt}::timestamptz,
        (SELECT a.last_activity_at
         FROM session_activity a
         JOIN sessions s ON s.id = a.session_id
         WHERE a.session_id = ${run.sessionId} AND s.run_session_root IS NULL)
      ON CONFLICT (session_id) DO NOTHING
    `;
  }
  yield* sql`DELETE FROM task_runs WHERE session_id NOT IN (SELECT DISTINCT log_id FROM commits)`;

  // Fold the pages into `session_pages`: the delete is one statement over every session the fold
  // covers, before the inserts, rather than one per write batch. A session's rows are contiguous in
  // the fold but not aligned to `WRITE_BATCH_ROWS`, so a per-batch delete would clobber another
  // batch's rows for the same session — a rebuild losing pages its log still holds. That is the
  // lesson the approvals fold was reviewed into (LOB-147), applied here from the start.
  yield* sql`DELETE FROM session_pages`;
  for (let at = 0; at < pages.length; at += WRITE_BATCH_ROWS) {
    const batch = pages.slice(at, at + WRITE_BATCH_ROWS);
    yield* sql`
      INSERT INTO session_pages (session_id, name, kind, content, links, sources)
      SELECT
        session_id,
        name,
        kind,
        content,
        links::jsonb,
        sources::jsonb
      FROM unnest(
        ${batch.map((page) => page.sessionId)}::text[],
        ${batch.map((page) => page.name)}::text[],
        ${batch.map((page) => page.kind)}::text[],
        ${batch.map((page) => page.content)}::text[],
        ${batch.map((page) => page.links)}::text[],
        ${batch.map((page) => page.sources)}::text[]
      ) AS folded(session_id, name, kind, content, links, sources)
      ON CONFLICT (session_id, name) DO UPDATE SET
        kind = EXCLUDED.kind,
        content = EXCLUDED.content,
        links = EXCLUDED.links,
        sources = EXCLUDED.sources
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

/**
 * Fill `sessions.model` for every index row that has none, from its log's `pi.agent` (LOB-269).
 *
 * Migration 0027 adds the column and reads no log, so on an existing deployment every older row
 * would list no model until its owner reopens or someone runs `rebuildIndexes`, which nothing runs
 * at boot. The server calls this once its migrations are applied. It is narrower than a rebuild:
 * one reader per blank row, one document read each, and only the `model` column is written — `AND
 * model IS NULL`, so an owner that opened meanwhile and wrote the column is never overwritten. A
 * row whose log has no root yet stays blank: that owner's first open writes it. Answers how many
 * rows it filled.
 */
export const backfillSessionModels: Effect.Effect<
  number,
  SessionError,
  SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ id: string }>`
    SELECT id FROM sessions WHERE model IS NULL ORDER BY id
  `.pipe(
    Effect.mapError((cause) =>
      storageError("read the sessions with no model", cause),
    ),
  );
  let filled = 0;
  for (const { id } of rows) {
    if (!Schema.is(SessionId)(id)) continue;
    const model = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => PostgresStorage.reader(sql, id),
        catch: (cause) => storageError(`open log ${id}`, cause),
      }),
      readPinnedModelKey,
      (storage) => Effect.promise(() => storage.dispose()),
    );
    if (model === undefined) continue;
    yield* sql`
      UPDATE sessions SET model = ${model} WHERE id = ${id} AND model IS NULL
    `.pipe(
      Effect.mapError((cause) =>
        storageError(`write the model of ${id}`, cause),
      ),
    );
    filled += 1;
  }
  return filled;
});
