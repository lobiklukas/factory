import type { Context } from "@earendil-works/chord";
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

const WritesFromJson = Schema.fromJsonString(Schema.Unknown);
const encodeWrites = Schema.encodeSync(WritesFromJson);
const decodeWrites = Schema.decodeUnknownSync(WritesFromJson);

const isWrites = (value: unknown): value is readonly StorageWrite[] =>
  Array.isArray(value);

type Row = { readonly seq: string | number | bigint; readonly writes: string };

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
