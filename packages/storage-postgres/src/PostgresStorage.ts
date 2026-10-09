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

/** One commit row of one of the logs a batched read asked for. */
type BatchedRow = Row & { readonly logId: string };

export class PostgresStorage implements Storage {
  private readonly store = new MemoryStorage();
  private readonly mode: StorageMode;
  private lastSeq = 0;
  private closed = false;
  private poisoned: unknown = undefined;
  /** Serializes commits (owner) and log catch-up (reader) so folds never interleave. */
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly sql: SqlClient,
    private readonly logId: string,
    mode: StorageMode,
  ) {
    this.mode = mode;
  }

  /** Open one log, folding every commit already in it. */
  static open(
    sql: SqlClient,
    options: { readonly logId: string; readonly mode?: StorageMode },
    _context: Context,
  ): Promise<PostgresStorage> {
    const storage = new PostgresStorage(
      sql,
      options.logId,
      options.mode ?? "owner",
    );
    return storage.catchUp().then(() => storage);
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
   * The stores are detached and hold no connection, so the caller drops the map when it is done.
   */
  static readers(
    sql: SqlClient,
    logIds: readonly string[],
  ): Promise<ReadonlyMap<string, Storage>> {
    const stores = new Map<string, MemoryStorage>(
      logIds.map((logId) => [logId, new MemoryStorage()]),
    );
    if (stores.size === 0) return Promise.resolve(stores);
    const ids = [...stores.keys()];
    const fold = Effect.gen(function* () {
      let after: { readonly logId: string; readonly seq: number } | undefined;
      for (;;) {
        const rows =
          after === undefined
            ? yield* sql<BatchedRow>`
                SELECT log_id AS "logId", seq, writes::text AS writes
                FROM commits
                WHERE log_id = ANY(${ids})
                ORDER BY log_id, seq
                LIMIT ${READER_PAGE_ROWS}
              `
            : yield* sql<BatchedRow>`
                SELECT log_id AS "logId", seq, writes::text AS writes
                FROM commits
                WHERE log_id = ANY(${ids})
                  AND (log_id, seq) > (${after.logId}, ${after.seq})
                ORDER BY log_id, seq
                LIMIT ${READER_PAGE_ROWS}
              `;
        for (const row of rows) {
          const store = stores.get(row.logId);
          // Unreachable: `ANY(ids)` bounds the rows to ids `stores` holds. Left explicit because
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

  /** Fold every commit after `lastSeq` into memory. */
  private catchUp(): Promise<void> {
    const fold = Effect.gen({ self: this }, function* () {
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
        }
        if (rows.length < BATCH_SIZE) return;
      }
    });
    return this.serialize(() => Effect.runPromise(fold));
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

  close(context: Context): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.store.close(context);
  }
}
