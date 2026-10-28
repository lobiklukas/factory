import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  Page,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
} from "@earendil-works/pi-durable";
import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  CHECKPOINT_SHAPE,
  compressFold,
  decompressFold,
  encodeFold,
  restoreFold,
} from "./Checkpoint";

/**
 * Pi Durable `Storage` over the Postgres commit log (docs/design.md D7).
 *
 * The table is the source of truth and `MemoryStorage` is the fold: it validates every commit,
 * mints ids, and answers every read. This class only makes the log durable and replays it.
 * That is the same shape as Pi Durable's own JSONL backend, so validation semantics cannot
 * drift from the reference implementation.
 *
 * Two modes:
 * - `owner` — the single writer for one `logId`. Folds the log on open, then appends. A second
 *   owner is fenced by `PRIMARY KEY (log_id, seq)`: its insert collides and it is poisoned.
 * - `reader` — never writes and does not own the log. Every read first catches up on commits
 *   appended since the last read, so the control plane can read a session without opening a
 *   `Harness`.
 *
 * Open costs the tail, not the log (LOB-186). The owner writes a checkpoint of its fold
 * (`log_checkpoints`, encoded by `./Checkpoint`) every `checkpointEvery` commits, and every open,
 * either mode, restores the newest checkpoint that is still valid and folds only the commits after
 * it. Valid means the running shape and a commit at its seq that is the commit it was taken after;
 * anything else — no row, a stale shape, a log truncated or rewritten under it, a fold that does not
 * decode, a failed read — is ignored, and the open folds the whole log as it always has (a failed
 * read or a fold that does not decode is logged as a warning). The checkpoint is an optimisation of
 * a derived value: the commit it follows neither waits for its write nor fails with it, and
 * deleting every row costs one full fold per log. `readers`, the batched fold, starts from the same
 * checkpoints when its caller asks it to (LOB-243).
 */

export type StorageMode = "owner" | "reader";

export class StorageLogError extends Data.TaggedError("StorageLogError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  // Pi Durable surfaces storage failures as plain `Error`s, so the reason must be the message.
  override get message(): string {
    return this.reason;
  }
}

const BATCH_SIZE = 500;

/**
 * Commits an owner folds past its last checkpoint before it writes the next one.
 *
 * It bounds an open's tail at this many commits, at the price of encoding and writing the whole fold
 * once per interval. One read page (`BATCH_SIZE`) is the tail it buys: an open past a checkpoint is
 * then one checkpoint query and one or two commit pages, whatever the log's length.
 */
export const CHECKPOINT_EVERY = 500;

/** How one open was answered, so a caller (and a test) can see what the open cost. */
export type OpenReport = {
  /** The seq of the checkpoint the open restored, or `undefined` when it folded from the start. */
  readonly checkpoint: number | undefined;
  /** Commit rows the open read and folded. */
  readonly commitsRead: number;
};

/**
 * Commit rows one batched read answers per round trip (`PostgresStorage.readers`).
 *
 * A page bounds the result set, not the number of queries: a table of many thin logs pages a few
 * times, and one fat log pages by its own row count. Exported so a test can straddle the boundary
 * with a log of more rows than this, which is the case paging exists for.
 */
export const READER_PAGE_ROWS = 2_000;

const WritesFromJson = Schema.fromJsonString(Schema.Unknown);
const encodeWrites = Schema.encodeSync(WritesFromJson);
const decodeWrites = Schema.decodeUnknownSync(WritesFromJson);

const isWrites = (value: unknown): value is readonly StorageWrite[] =>
  Array.isArray(value);

type Row = { readonly seq: string | number | bigint; readonly writes: string };

type CheckpointRow = {
  readonly seq: string | number | bigint;
  readonly fold: Uint8Array;
};

/**
 * The fold a checkpoint row's bytes hold, restored as of commit `seq`: `undefined` for a fold that
 * does not decode, and a failure for bytes that are not gzip. Either way the caller folds from the
 * start instead, and says which.
 */
const restoreRow = (fold: Uint8Array, seq: number) =>
  Effect.map(
    Effect.try(() => decompressFold(fold)),
    (encoded) => restoreFold(encoded, seq),
  );

/** One commit row of one of the logs a batched read asked for. */
type BatchedRow = Row & { readonly logId: string };

export class PostgresStorage implements Storage {
  private store = new MemoryStorage();
  private readonly mode: StorageMode;
  private lastSeq = 0;
  /** The seq the newest checkpoint this instance restored or wrote was taken at. */
  private checkpointSeq = 0;
  private commitsRead = 0;
  private report: OpenReport = { checkpoint: undefined, commitsRead: 0 };
  private closed = false;
  private poisoned: unknown = undefined;
  /**
   * The checkpoint writes this owner has started, chained so they land in the order they were
   * taken. A commit does not wait on it; `checkpointsWritten` and `close` do.
   */
  private checkpointWrites: Promise<void> = Promise.resolve();
  /** Serializes commits (owner) and log catch-up (reader) so folds never interleave. */
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly sql: SqlClient,
    private readonly logId: string,
    mode: StorageMode,
    private readonly checkpointEvery: number,
  ) {
    this.mode = mode;
  }

  /**
   * Open one log: restore its checkpoint when it has a valid one, then fold every commit after it.
   *
   * `checkpointEvery` is how many commits an owner folds past its last checkpoint before writing
   * the next (`CHECKPOINT_EVERY`); a reader never writes one.
   */
  static open(
    sql: SqlClient,
    options: {
      readonly logId: string;
      readonly mode?: StorageMode;
      readonly checkpointEvery?: number;
    },
    _context: Context,
  ): Promise<PostgresStorage> {
    const storage = new PostgresStorage(
      sql,
      options.logId,
      options.mode ?? "owner",
      options.checkpointEvery ?? CHECKPOINT_EVERY,
    );
    return storage.serialize(() => storage.openLog()).then(() => storage);
  }

  /**
   * The single writer for one log, for Effect callers.
   *
   * The Chord context is deliberately the never-cancelling one: a session's log outlives the
   * request that opens it, so cancelling that request must not cancel the storage.
   */
  static owner(sql: SqlClient, logId: string): Promise<PostgresStorage> {
    return PostgresStorage.open(
      sql,
      { logId, mode: "owner" },
      BACKGROUND_CONTEXT,
    );
  }

  /** Read-only, non-owning mode for one log, for Effect callers. */
  static reader(sql: SqlClient, logId: string): Promise<PostgresStorage> {
    return PostgresStorage.open(
      sql,
      { logId, mode: "reader" },
      BACKGROUND_CONTEXT,
    );
  }

  /**
   * Read-only folds of many logs at once, for a caller that indexes logs it does not own.
   *
   * `reader()` costs one round trip per read, and a `Storage` read is several, so a caller walking a
   * whole log table (the control plane's index rebuild) pays that per log. This pays it per page
   * instead: one paged `SELECT … WHERE log_id = ANY(…)` seeds a `MemoryStorage` per requested id,
   * each folded by the same `MemoryStorage.prepareCommit` the single-log reader uses — so
   * validation, id minting and the resulting state are Pi Durable's own and cannot drift from it.
   *
   * Two properties the single-log path has and this keeps. Every id in `logIds` is present in the
   * result even when its log holds no commits, because `reader()` on an empty log answers as an
   * empty fold and a missing key would be a different answer. And commits still arrive in `seq`
   * order per log: the page is ordered by `(log_id, seq)` and keyed on that pair, so a page may
   * split a log across two queries without reordering or dropping the half that did not fit.
   *
   * `checkpoints` says whether a log may start from its checkpoint (LOB-243). With it, every log
   * with a valid checkpoint — the same test `open` applies, in one query for the batch — is restored
   * and folds only its commits after it, so a log costs its tail, as an open does; one whose
   * checkpoint is missing, stale or does not decode folds from the start. Its callers say which they
   * are. The board's run evidence (`TaskService`) passes `true`: it reads documents and the runs'
   * entries off the fold, which a checkpoint holds exactly. The index rebuild (`rebuildIndexes`)
   * passes `false`: it is the recovery path, and a fold that trusted a derived row could only rebuild
   * what that row already believed.
   *
   * The stores are detached and hold no connection, so the caller drops the map when it is done.
   */
  static readers(
    sql: SqlClient,
    logIds: readonly string[],
    options: { readonly checkpoints: boolean },
  ): Promise<ReadonlyMap<string, Storage>> {
    const stores = new Map<string, MemoryStorage>(
      logIds.map((logId) => [logId, new MemoryStorage()]),
    );
    if (stores.size === 0) return Promise.resolve(stores);
    const ids = [...stores.keys()];
    const fold = Effect.gen(function* () {
      // The seq each log's fold already holds: its checkpoint's, or 0 for a fold from the start.
      const folded = new Map<string, number>();
      if (options.checkpoints) {
        const rows = yield* sql<CheckpointRow & { readonly logId: string }>`
          SELECT k.log_id AS "logId", k.seq, k.fold
          FROM log_checkpoints k
          JOIN commits c ON c.log_id = k.log_id AND c.seq = k.seq
          WHERE k.log_id = ANY(${ids})
            AND k.shape = ${CHECKPOINT_SHAPE}
            AND md5(c.writes::text) = k.commit_hash
        `.pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning(
                `checkpoints of ${ids.length} logs could not be read; folding them whole`,
                cause,
              ),
              [],
            ),
          ),
        );
        for (const row of rows) {
          const seq = Number(row.seq);
          const restored = yield* restoreRow(row.fold, seq).pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning(
                  `checkpoint of log ${row.logId} could not be read; folding the whole log`,
                  cause,
                ),
                null,
              ),
            ),
          );
          if (restored === null) continue;
          if (restored === undefined) {
            yield* Effect.logWarning(
              `checkpoint of log ${row.logId} at commit ${seq} did not decode; folding the whole log`,
            );
            continue;
          }
          stores.set(row.logId, restored);
          folded.set(row.logId, seq);
        }
      }
      const floors = ids.map((logId) => folded.get(logId) ?? 0);
      let after: { readonly logId: string; readonly seq: number } | undefined;
      for (;;) {
        const rows =
          after === undefined
            ? yield* sql<BatchedRow>`
                SELECT c.log_id AS "logId", c.seq, c.writes::text AS writes
                FROM commits c
                JOIN unnest(${ids}::text[], ${floors}::bigint[]) AS f(log_id, folded)
                  ON f.log_id = c.log_id AND c.seq > f.folded
                ORDER BY c.log_id, c.seq
                LIMIT ${READER_PAGE_ROWS}
              `
            : yield* sql<BatchedRow>`
                SELECT c.log_id AS "logId", c.seq, c.writes::text AS writes
                FROM commits c
                JOIN unnest(${ids}::text[], ${floors}::bigint[]) AS f(log_id, folded)
                  ON f.log_id = c.log_id AND c.seq > f.folded
                WHERE (c.log_id, c.seq) > (${after.logId}, ${after.seq})
                ORDER BY c.log_id, c.seq
                LIMIT ${READER_PAGE_ROWS}
              `;
        for (const row of rows) {
          const store = stores.get(row.logId);
          // Unreachable: the join bounds the rows to ids `stores` holds. Left explicit because
          // the fold below assumes the store exists, and a missing one would be a silent skip.
          if (store === undefined) continue;
          const seq = Number(row.seq);
          const writes = decodeWrites(row.writes);
          if (!isWrites(writes)) {
            return yield* new StorageLogError({
              reason: `commit ${seq} of log ${row.logId} is not a write array`,
            });
          }
          yield* Effect.try({
            try: () => store.prepareCommit(writes, seq as Seq).apply(),
            catch: (cause) =>
              new StorageLogError({
                reason: `commit ${seq} of log ${row.logId} does not fold`,
                cause,
              }),
          });
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < READER_PAGE_ROWS) return;
        after = { logId: last.logId, seq: Number(last.seq) };
      }
    });
    return Effect.runPromise(fold).then(() => stores);
  }

  /** `close()` with the never-cancelling context, for Effect callers. */
  dispose(): Promise<void> {
    return this.close(BACKGROUND_CONTEXT);
  }

  private serialize<A>(operation: () => Promise<A>): Promise<A> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private assertUsable(): void {
    if (this.closed) throw new Error("PostgresStorage is closed");
    if (this.poisoned !== undefined) {
      throw new StorageLogError({
        reason:
          "storage is poisoned after a failed append and must be reopened",
        cause: this.poisoned,
      });
    }
  }

  /**
   * Resolves when every checkpoint write this owner has started has landed or failed (a failure is
   * logged, never thrown). A commit resolves before its checkpoint is written; a caller that needs
   * the row — a test, a benchmark — waits here. `close` waits here too.
   */
  checkpointsWritten(): Promise<void> {
    return this.checkpointWrites;
  }

  /** How this instance's open was answered: the checkpoint it restored and the commits it read. */
  get opened(): OpenReport {
    return this.report;
  }

  /**
   * The fold this instance holds, encoded as a checkpoint would store it.
   *
   * Two opens of one log at one seq answer identically exactly when these are equal, so this is how
   * an open from a checkpoint is compared with the full fold. `undefined` when the installed
   * `MemoryStorage` is not the shape `./Checkpoint` encodes.
   */
  encodedFold(): string | undefined {
    return encodeFold(this.store);
  }

  /** Fold every commit after `lastSeq` into memory. */
  private foldTail() {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const rows = yield* this.sql<Row>`
          SELECT seq, writes::text AS writes
          FROM commits
          WHERE log_id = ${this.logId} AND seq > ${this.lastSeq}
          ORDER BY seq
          LIMIT ${BATCH_SIZE}
        `;
        for (const row of rows) {
          const seq = Number(row.seq);
          const writes = decodeWrites(row.writes);
          if (!isWrites(writes)) {
            return yield* new StorageLogError({
              reason: `commit ${seq} of log ${this.logId} is not a write array`,
            });
          }
          yield* Effect.try({
            try: () => this.store.prepareCommit(writes, seq as Seq).apply(),
            catch: (cause) =>
              new StorageLogError({
                reason: `commit ${seq} of log ${this.logId} does not fold`,
                cause,
              }),
          });
          this.lastSeq = seq;
          this.commitsRead += 1;
        }
        if (rows.length < BATCH_SIZE) return;
      }
    });
  }

  /**
   * Restore the log's checkpoint when it is valid, leaving the empty fold when it is not.
   *
   * The query is the validity check: the shape must be the running one, and commit `seq` must exist
   * and hash to what it hashed to when the checkpoint was taken; a row that fails it is not
   * returned, which is the quiet case. A row that passes and still does not decode, or a query that
   * fails (a missing table, a permission), is a fault: it is logged as a warning, and the fold that
   * follows answers either way, so the only symptom it would otherwise have is a slower open.
   */
  private restoreCheckpoint() {
    return Effect.gen({ self: this }, function* () {
      const rows = yield* this.sql<CheckpointRow>`
        SELECT k.seq, k.fold
        FROM log_checkpoints k
        JOIN commits c ON c.log_id = k.log_id AND c.seq = k.seq
        WHERE k.log_id = ${this.logId}
          AND k.shape = ${CHECKPOINT_SHAPE}
          AND md5(c.writes::text) = k.commit_hash
      `;
      const row = rows[0];
      if (row === undefined) return;
      const seq = Number(row.seq);
      const restored = yield* restoreRow(row.fold, seq);
      if (restored === undefined) {
        yield* Effect.logWarning(
          `checkpoint of log ${this.logId} at commit ${seq} did not decode; folding the whole log`,
        );
        return;
      }
      this.store = restored;
      this.lastSeq = seq;
      this.checkpointSeq = seq;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `checkpoint of log ${this.logId} could not be read; folding the whole log`,
          cause,
        ),
      ),
    );
  }

  /**
   * Start writing the fold as the log's checkpoint, when the owner has folded `checkpointEvery`
   * commits past the last one.
   *
   * Only the encoding happens here, synchronously, because the next commit mutates the store the
   * fold is read from. Compressing (off the event loop) and the upsert run on `checkpointWrites`,
   * which the commit does not wait on: a checkpoint is an optimisation, so neither its cost nor a
   * lock its upsert waits behind lands on the commit's latency. The chain keeps writes in the order
   * they were taken, so a later checkpoint is never replaced by an earlier one.
   *
   * The row is taken from commit `seq` itself (`INSERT … SELECT … FROM commits`), so a checkpoint
   * can only name a commit the log holds, and its hash is the one an open compares. It never fails:
   * a failure is logged, and a checkpoint that did not land is only a slower next open. The interval
   * restarts on a failed write too, so a write that cannot succeed (a fold too large for a row, say)
   * is not retried on every commit.
   */
  private checkpointIfDue(): void {
    if (this.mode !== "owner") return;
    const seq = this.lastSeq;
    if (seq - this.checkpointSeq < this.checkpointEvery) return;
    this.checkpointSeq = seq;
    const warn = (cause: unknown) =>
      Effect.logWarning(
        `checkpoint of log ${this.logId} at commit ${seq} was not written`,
        cause,
      );
    let encoded: string | undefined;
    try {
      encoded = encodeFold(this.store);
    } catch (cause) {
      // A fold too large to stringify, say: the commit has landed, so this is only a warning.
      Effect.runFork(warn(cause));
      return;
    }
    if (encoded === undefined) return;
    const write = Effect.gen({ self: this }, function* () {
      const fold = yield* Effect.tryPromise(() => compressFold(encoded));
      yield* this.sql`
        INSERT INTO log_checkpoints (log_id, seq, shape, commit_hash, fold)
        SELECT log_id, seq, ${CHECKPOINT_SHAPE}, md5(writes::text), ${fold}
        FROM commits
        WHERE log_id = ${this.logId} AND seq = ${seq}
        ON CONFLICT (log_id) DO UPDATE SET
          seq = EXCLUDED.seq,
          shape = EXCLUDED.shape,
          commit_hash = EXCLUDED.commit_hash,
          fold = EXCLUDED.fold,
          written_at = now()
      `;
    }).pipe(Effect.catchCause(warn));
    this.checkpointWrites = this.checkpointWrites.then(() =>
      Effect.runPromise(write),
    );
  }

  /** The first fold: checkpoint, tail, and — for an owner that read a long tail — a new checkpoint. */
  private openLog(): Promise<void> {
    const open = Effect.gen({ self: this }, function* () {
      yield* this.restoreCheckpoint();
      yield* this.foldTail();
      this.report = {
        checkpoint: this.checkpointSeq === 0 ? undefined : this.checkpointSeq,
        commitsRead: this.commitsRead,
      };
      this.checkpointIfDue();
    });
    return Effect.runPromise(open);
  }

  /** Fold every commit appended since the last read. */
  private catchUp(): Promise<void> {
    return this.serialize(() => Effect.runPromise(this.foldTail()));
  }

  /** Readers observe commits appended by the owner; the owner already holds the fold. */
  private fresh(): Promise<MemoryStorage> {
    return Promise.resolve().then(() => {
      this.assertUsable();
      return this.mode === "reader"
        ? this.catchUp().then(() => this.store)
        : this.store;
    });
  }

  commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    if (this.mode === "reader") {
      return Promise.reject(
        new StorageLogError({ reason: "a reader cannot commit" }),
      );
    }
    return this.serialize(() =>
      Promise.resolve().then(() => {
        this.assertUsable();
        // Validation failures reject here with Pi Durable's own error, before anything is
        // written, and leave the storage usable.
        const prepared = this.store.prepareCommit(writes);
        const payload = encodeWrites(prepared.writes);
        const insert = this.sql`
          INSERT INTO commits (log_id, seq, writes)
          VALUES (${this.logId}, ${prepared.seq}, ${payload}::json)
        `;
        return Effect.runPromise(insert).then(
          () => {
            const seq = prepared.apply();
            this.lastSeq = seq;
            this.checkpointIfDue();
            return seq;
          },
          (cause: unknown) => {
            // Whether the row landed is unknown (or a second owner holds that seq), so memory
            // and the log may disagree. Refuse further use rather than fork the log.
            this.poisoned = cause;
            throw new StorageLogError({
              reason: `append of commit ${prepared.seq} to log ${this.logId} failed`,
              cause,
            });
          },
        );
      }),
    );
  }

  mintId<I extends Id<string>>(): Promise<I> {
    return Promise.resolve().then(() => {
      if (this.mode === "reader") {
        throw new StorageLogError({ reason: "a reader cannot mint ids" });
      }
      this.assertUsable();
      return this.store.mintId<I>();
    });
  }

  conversation(
    id: ConversationId,
    context: Context,
  ): Promise<ConversationRecord | undefined> {
    return this.fresh().then((store) => store.conversation(id, context));
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.fresh().then((store) =>
      store.scanConversations(query, limit, cursor, context),
    );
  }

  entry(
    id: EntryId,
    context: Context,
  ): Promise<
    { readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined
  >;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<
    { readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined
  >;
  entry(
    first: EntryId | ConversationId,
    second: EntryId | Context,
    third?: Context,
  ): Promise<
    { readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined
  > {
    return this.fresh().then((store) =>
      third === undefined
        ? store.entry(first as EntryId, second as Context)
        : store.entry(first as ConversationId, second as EntryId, third),
    );
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.fresh().then((store) =>
      store.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context),
    );
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.fresh().then((store) =>
      store.scanEntries(query, limit, cursor, context),
    );
  }

  task(id: TaskId, context: Context) {
    return this.fresh().then((store) => store.task(id, context));
  }

  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ) {
    return this.fresh().then((store) =>
      store.scanTasks(query, limit, cursor, context),
    );
  }

  submission(
    id: SubmissionId,
    context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.fresh().then((store) => store.submission(id, context));
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.fresh().then((store) =>
      store.scanSubmissions(query, limit, cursor, context),
    );
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.fresh().then((store) =>
      store.submissionByRequest(conversationId, requestId, context),
    );
  }

  findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    context: Context,
  ): Promise<DocumentRecord | undefined> {
    return this.fresh().then((store) =>
      store.findDocument(address, at, context),
    );
  }

  document(
    id: DocumentId,
    at: DocumentPoint,
    context: Context,
  ): Promise<StoredDocument | undefined> {
    return this.fresh().then((store) => store.document(id, at, context));
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.fresh().then((store) =>
      store.scanDocuments(query, limit, cursor, context),
    );
  }

  /** Close, after the checkpoint writes already started have settled. */
  close(context: Context): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.checkpointWrites.then(() => this.store.close(context));
  }
}
