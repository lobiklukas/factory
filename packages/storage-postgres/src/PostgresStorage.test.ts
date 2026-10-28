import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type Cursor,
  type EntryId,
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  ConversationQuery,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  EntryQuery,
  Id,
  SubmissionId,
  SubmissionQuery,
  TaskId,
  TaskQuery,
} from "@earendil-works/pi-durable";
import {
  createExpectAssertions,
  createStorageConformance,
  registerStorageConformance,
  seedStorageBenchmark,
  STORAGE_READ_BENCHMARKS,
  TIMING_SCALE,
} from "@earendil-works/pi-durable/testing";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { BunServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import {
  Clock,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Random,
  Redacted,
  Schema,
  // Aliased: this file's `beforeAll` calls the global `String` on a caught cause, and
  // `effect`'s own `String` module would shadow it.
  String as EffectString,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseConfig, DatabaseLive } from "./index";
import {
  CHECKPOINT_SHAPE,
  compressFold,
  encodeFold,
  foldShape,
  restoreFold,
} from "./Checkpoint";
import {
  CHECKPOINT_EVERY,
  PostgresStorage,
  READER_PAGE_ROWS,
} from "./PostgresStorage";
import { Skill } from "@repo/domain/Skill";
import { BoardDefinition } from "@repo/domain/Task";

/**
 * Pi Durable's storage conformance suite is the acceptance oracle (docs/design.md M1).
 * It runs against `MemoryStorage` as a control: a case that fails on both is a problem in
 * this harness, not in the Postgres adapter.
 *
 * Needs a running Postgres: `docker compose up -d --wait postgres`.
 */
const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;

let sql: SqlClient;
let counter = 0;
// Unique per run so cases never see each other's commits, and the append-only table is never
// cleaned up.
const runId = `test-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
const nextLogId = () => `${runId}-${counter++}`;
/** A `task_runs.id`, unique per call so two rows on one card never collide on the primary key. */
let runCounter = 0;
const nextRunId = () => `run-${runId}-${runCounter++}`;

beforeAll(async () => {
  try {
    sql = await runtime.runPromise(SqlClient);
  } catch (cause) {
    const configuredUrl = Object.entries(process.env).find(
      ([name]) => name === "DATABASE_URL",
    )?.[1];
    const urlNote = configuredUrl
      ? `(DATABASE_URL=${configuredUrl})`
      : `(DATABASE_URL defaults to postgres://factory:factory@localhost:5442/factory)`;
    throw new Error(
      "Postgres is unreachable. Start it with `docker compose up -d --wait postgres` " +
        `${urlNote}. ${String(cause)}`,
      { cause },
    );
  }
}, 60_000);

afterAll(async () => {
  await runtime.dispose();
});

describe("storage conformance case count", () => {
  it("is identical for both backends", { timeout: 30_000 }, () => {
    const cases = createStorageConformance({
      assertions: createExpectAssertions(expect),
      withStorage: async () => {},
    });
    expect(cases.length).toBe(23);
  });
});

registerStorageConformance(
  { describe, expect, it },
  "MemoryStorage (control)",
  async (use) => {
    const storage = new MemoryStorage();
    try {
      await use(storage);
    } finally {
      await storage.close(context);
    }
  },
);

registerStorageConformance(
  { describe, expect, it },
  "PostgresStorage (owner)",
  async (use) => {
    const storage = await PostgresStorage.open(
      sql,
      { logId: nextLogId() },
      context,
    );
    try {
      await use(storage);
    } finally {
      await storage.close(context);
    }
  },
);

/**
 * Every read answered by a fold restored from a checkpoint (LOB-186).
 *
 * The owner writes a checkpoint after every commit, and each read opens a fresh reader, which must
 * restore that checkpoint and fold nothing after it — so the 23 cases' reads are all answered by a
 * restored `MemoryStorage`, and the suite is the oracle for the restore as it is for the fold. A
 * reader that had to fold a commit throws instead of answering, because answering would prove the
 * fold again rather than the checkpoint.
 */
class ReadsFromCheckpoint implements Storage {
  private closed = false;

  private constructor(
    private readonly owner: PostgresStorage,
    private readonly logId: string,
  ) {}

  static async open(logId: string): Promise<ReadsFromCheckpoint> {
    const owner = await PostgresStorage.open(
      sql,
      { logId, checkpointEvery: 1 },
      context,
    );
    return new ReadsFromCheckpoint(owner, logId);
  }

  private async read<A>(use: (storage: Storage) => Promise<A>): Promise<A> {
    // Each read opens its own reader, so the owner's closed flag is the wrapper's to keep.
    if (this.closed) throw new Error("ReadsFromCheckpoint is closed");
    const reader = await PostgresStorage.open(
      sql,
      { logId: this.logId, mode: "reader" },
      context,
    );
    try {
      if (reader.opened.commitsRead !== 0) {
        throw new Error(
          `the reader folded ${reader.opened.commitsRead} commits past checkpoint ${String(reader.opened.checkpoint)}`,
        );
      }
      return await use(reader);
    } finally {
      await reader.close(context);
    }
  }

  async commit(writes: readonly StorageWrite[], at: typeof context) {
    // A commit does not wait for its checkpoint; the next read's reader must find it.
    const seq = await this.owner.commit(writes, at);
    await this.owner.checkpointsWritten();
    return seq;
  }
  mintId<I extends Id<string>>(): Promise<I> {
    return this.owner.mintId<I>();
  }
  conversation(id: ConversationId, at: typeof context) {
    return this.read((storage) => storage.conversation(id, at));
  }
  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    at: typeof context,
  ) {
    return this.read((storage) =>
      storage.scanConversations(query, limit, cursor, at),
    );
  }
  entry(id: EntryId, at: typeof context): ReturnType<Storage["entry"]>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    at: typeof context,
  ): ReturnType<Storage["entry"]>;
  entry(
    first: EntryId | ConversationId,
    second: EntryId | typeof context,
    third?: typeof context,
  ): ReturnType<Storage["entry"]> {
    return this.read((storage) =>
      third === undefined
        ? storage.entry(first as EntryId, second as typeof context)
        : storage.entry(first as ConversationId, second as EntryId, third),
    );
  }
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    at: typeof context,
  ) {
    return this.read((storage) =>
      storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, at),
    );
  }
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    at: typeof context,
  ) {
    return this.read((storage) =>
      storage.scanEntries(query, limit, cursor, at),
    );
  }
  task(id: TaskId, at: typeof context) {
    return this.read((storage) => storage.task(id, at));
  }
  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    at: typeof context,
  ) {
    return this.read((storage) => storage.scanTasks(query, limit, cursor, at));
  }
  submission(id: SubmissionId, at: typeof context) {
    return this.read((storage) => storage.submission(id, at));
  }
  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    at: typeof context,
  ) {
    return this.read((storage) =>
      storage.scanSubmissions(query, limit, cursor, at),
    );
  }
  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    at: typeof context,
  ) {
    return this.read((storage) =>
      storage.submissionByRequest(conversationId, requestId, at),
    );
  }
  findDocument(
    address: DocumentAddress,
    point: DocumentPoint,
    at: typeof context,
  ) {
    return this.read((storage) => storage.findDocument(address, point, at));
  }
  document(id: DocumentId, point: DocumentPoint, at: typeof context) {
    return this.read((storage) => storage.document(id, point, at));
  }
  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    at: typeof context,
  ) {
    return this.read((storage) =>
      storage.scanDocuments(query, limit, cursor, at),
    );
  }
  close(at: typeof context) {
    this.closed = true;
    return this.owner.close(at);
  }
}

registerStorageConformance(
  { describe, expect, it },
  "PostgresStorage (every read restored from a checkpoint)",
  async (use) => {
    const storage = await ReadsFromCheckpoint.open(nextLogId());
    try {
      await use(storage);
    } finally {
      await storage.close(context);
    }
  },
);

/** Behavior the conformance suite cannot see because it never reopens or shares a log. */
describe("PostgresStorage log semantics", () => {
  const root = {
    type: "conversation",
    value: { id: ROOT_CONVERSATION_ID },
  } as const;
  const entryWrite = (id: EntryId, text: string): StorageWrite => ({
    type: "entry",
    value: {
      id,
      conversationId: ROOT_CONVERSATION_ID,
      kind: "user",
      data: { text },
    },
  });

  it(
    "folds the log on reopen and continues sequence and ids",
    { timeout: 30_000 },
    async () => {
      const logId = nextLogId();
      const first = await PostgresStorage.open(sql, { logId }, context);
      await first.commit([root], context);
      const entryId = await first.mintId<EntryId>();
      const seq = await first.commit([entryWrite(entryId, "kept")], context);
      await first.close(context);

      const second = await PostgresStorage.open(sql, { logId }, context);
      expect((await second.entry(entryId, context))?.entry.data).toEqual({
        text: "kept",
      });
      expect((await second.entry(entryId, context))?.commitSeq).toBe(seq);
      expect(await second.mintId<EntryId>()).toBeGreaterThan(entryId);
      expect(
        await second.commit(
          [entryWrite(await second.mintId<EntryId>(), "next")],
          context,
        ),
      ).toBe(seq + 1);
      await second.close(context);
    },
  );

  it(
    "round-trips U+0000 and lone surrogates through the log",
    { timeout: 30_000 },
    async () => {
      const logId = nextLogId();
      const owner = await PostgresStorage.open(sql, { logId }, context);
      await owner.commit([root], context);
      const id = await owner.mintId<EntryId>();
      const text = "a\u0000b\ud800c";
      await owner.commit([entryWrite(id, text)], context);
      await owner.close(context);

      const reopened = await PostgresStorage.open(sql, { logId }, context);
      expect((await reopened.entry(id, context))?.entry.data).toEqual({ text });
      await reopened.close(context);
    },
  );

  it("keeps logs isolated by log id", { timeout: 30_000 }, async () => {
    const a = await PostgresStorage.open(sql, { logId: nextLogId() }, context);
    const b = await PostgresStorage.open(sql, { logId: nextLogId() }, context);
    await a.commit([root], context);
    expect(await b.conversation(ROOT_CONVERSATION_ID, context)).toBeUndefined();
    await a.close(context);
    await b.close(context);
  });

  it(
    "reader sees commits appended after it opened, and cannot write",
    { timeout: 30_000 },
    async () => {
      const logId = nextLogId();
      const owner = await PostgresStorage.open(sql, { logId }, context);
      const reader = await PostgresStorage.open(
        sql,
        { logId, mode: "reader" },
        context,
      );
      expect(
        await reader.conversation(ROOT_CONVERSATION_ID, context),
      ).toBeUndefined();

      await owner.commit([root], context);
      const id = await owner.mintId<EntryId>();
      await owner.commit([entryWrite(id, "live")], context);

      expect((await reader.entry(id, context))?.entry.data).toEqual({
        text: "live",
      });
      await expect(
        reader.commit([entryWrite(id, "nope")], context),
      ).rejects.toThrow("reader cannot commit");
      await expect(reader.mintId()).rejects.toThrow("reader cannot mint");
      await owner.close(context);
      await reader.close(context);
    },
  );

  it(
    "fences a second owner: its append collides and poisons it",
    { timeout: 30_000 },
    async () => {
      const logId = nextLogId();
      const first = await PostgresStorage.open(sql, { logId }, context);
      const intruder = await PostgresStorage.open(sql, { logId }, context);
      await first.commit([root], context);

      await expect(intruder.commit([root], context)).rejects.toThrow(
        "append of commit 1",
      );
      await expect(
        intruder.conversation(ROOT_CONVERSATION_ID, context),
      ).rejects.toThrow("poisoned");

      // The rightful owner's log is untouched.
      expect(await first.conversation(ROOT_CONVERSATION_ID, context)).toEqual({
        id: ROOT_CONVERSATION_ID,
      });
      await first.close(context);
      await intruder.close(context);
    },
  );

  it(
    "does not poison on a rejected commit and writes nothing for it",
    { timeout: 30_000 },
    async () => {
      const logId = nextLogId();
      const owner = await PostgresStorage.open(sql, { logId }, context);
      await owner.commit([root], context);
      await expect(owner.commit([root], context)).rejects.toThrow(
        "already belongs to conversation",
      );
      const id = await owner.mintId<EntryId>();
      expect(await owner.commit([entryWrite(id, "still works")], context)).toBe(
        2,
      );
      await owner.close(context);
    },
  );

  it("is append-only in the database", { timeout: 30_000 }, async () => {
    const logId = nextLogId();
    const owner = await PostgresStorage.open(sql, { logId }, context);
    await owner.commit([root], context);
    await owner.close(context);
    await expect(
      Effect.runPromise(
        sql`UPDATE commits SET writes = '[]'::json WHERE log_id = ${logId}`,
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(sql`DELETE FROM commits WHERE log_id = ${logId}`),
    ).rejects.toThrow();
  });
});

/**
 * Opening a log from its checkpoint (LOB-186).
 *
 * Every case reads the open's own report (`opened`) for what it read, never the wall clock, and
 * compares the fold it restored with the full fold of the same log (`encodedFold`) rather than with
 * a hand-written expectation: the claim is that the checkpoint changed the cost and not the answer.
 */
describe("PostgresStorage checkpoints", () => {
  const root = {
    type: "conversation",
    value: { id: ROOT_CONVERSATION_ID },
  } as const;
  const entryWrite = (id: EntryId, text: string): StorageWrite => ({
    type: "entry",
    value: {
      id,
      conversationId: ROOT_CONVERSATION_ID,
      kind: "user",
      data: { text },
    },
  });

  /** A log of a root and `entries` one-entry commits, its owner checkpointing every `every`. */
  const seedLog = async (
    entries: number,
    every: number,
    text: (at: number) => string = (at) => `message ${at}`,
  ) => {
    const logId = nextLogId();
    const owner = await PostgresStorage.open(
      sql,
      { logId, checkpointEvery: every },
      context,
    );
    await owner.commit([root], context);
    for (let at = 0; at < entries; at += 1) {
      await owner.commit(
        [entryWrite(await owner.mintId<EntryId>(), text(at))],
        context,
      );
    }
    const fold = owner.encodedFold();
    await owner.close(context);
    return { logId, fold };
  };

  type CheckpointRow = {
    readonly seq: number;
    readonly shape: string;
    readonly commitHash: string;
  };
  const checkpointOf = async (
    logId: string,
  ): Promise<CheckpointRow | undefined> => {
    const rows = await Effect.runPromise(
      sql<CheckpointRow>`
        SELECT seq::int AS seq, shape, commit_hash AS "commitHash"
        FROM log_checkpoints WHERE log_id = ${logId}
      `,
    );
    return rows[0];
  };
  const deleteCheckpoint = (logId: string) =>
    Effect.runPromise(sql`DELETE FROM log_checkpoints WHERE log_id = ${logId}`);

  const openReader = (logId: string) =>
    PostgresStorage.open(sql, { logId, mode: "reader" }, context);

  /** Every user message the log holds, oldest first, read through the public `Storage` reads. */
  const texts = async (storage: Storage) => {
    const items: unknown[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        500,
        cursor,
        context,
      );
      items.push(...page.items.map((entry) => entry.data));
      cursor = page.next;
      if (cursor === undefined) break;
    }
    return items.reverse();
  };

  it(
    "opens from its checkpoint and reads only the commits after it",
    { timeout: 30_000 },
    async () => {
      // 26 commits, checkpointed after 10 and 20: an open restores 20 and reads 6.
      const { logId, fold } = await seedLog(25, 10);
      expect((await checkpointOf(logId))?.seq).toBe(20);

      const reader = await openReader(logId);
      expect(reader.opened).toEqual({ checkpoint: 20, commitsRead: 6 });
      expect(reader.encodedFold()).toBe(fold);
      expect(await texts(reader)).toEqual(
        Array.from({ length: 25 }, (_, at) => ({ text: `message ${at}` })),
      );
      await reader.close(context);

      // An owner opened the same way continues the log where the fold would.
      const owner = await PostgresStorage.open(
        sql,
        { logId, checkpointEvery: 10 },
        context,
      );
      expect(owner.opened).toEqual({ checkpoint: 20, commitsRead: 6 });
      const id = await owner.mintId<EntryId>();
      expect(id).toBe(27);
      expect(await owner.commit([entryWrite(id, "after")], context)).toBe(27);
      await owner.close(context);
    },
  );

  it(
    "opens through the full fold, with an identical snapshot, once the checkpoint row is deleted",
    { timeout: 30_000 },
    async () => {
      // Pi Durable's own benchmark seed: entries with a head, tasks in every status, a family of
      // documents, delta replay tails, a rewindable history and an eight-deep fork chain — plus
      // submissions with request ids, the one doubly-keyed index the seed does not reach.
      const logId = nextLogId();
      const owner = await PostgresStorage.open(
        sql,
        { logId, checkpointEvery: 100 },
        context,
      );
      const dataset = await seedStorageBenchmark(owner, TIMING_SCALE);
      const submissionIds = [
        await owner.mintId<SubmissionId>(),
        await owner.mintId<SubmissionId>(),
      ];
      await owner.commit(
        submissionIds.map((id, at) => ({
          type: "submission",
          value: {
            id,
            conversationId: ROOT_CONVERSATION_ID,
            requestId: `request-${at}`,
            type: "input",
            status: "queued",
          },
        })),
        context,
      );
      // A minted id that is never committed: neither open may remember it.
      await owner.mintId();
      const live = owner.encodedFold();
      await owner.close(context);

      const checkpoint = await checkpointOf(logId);
      expect(checkpoint?.shape).toBe(CHECKPOINT_SHAPE);
      const fromCheckpoint = await openReader(logId);
      const { commitsRead, checkpoint: restoredAt } = fromCheckpoint.opened;
      expect(restoredAt).toBe(checkpoint?.seq);
      expect(commitsRead).toBeLessThan(100);

      await deleteCheckpoint(logId);
      const fromFold = await openReader(logId);
      expect(fromFold.opened).toEqual({
        checkpoint: undefined,
        commitsRead: (restoredAt ?? 0) + commitsRead,
      });

      const encoded = fromFold.encodedFold();
      expect(encoded).toBeDefined();
      expect(fromCheckpoint.encodedFold()).toBe(encoded);
      // The live owner's fold, too: what a checkpoint is taken from is what a fold rebuilds.
      expect(live).toBe(encoded);
      for (const benchmark of STORAGE_READ_BENCHMARKS) {
        const expected = benchmark.expected(dataset);
        expect(
          [
            await benchmark.run(fromCheckpoint, dataset),
            await benchmark.run(fromFold, dataset),
          ],
          benchmark.name,
        ).toEqual([expected, expected]);
      }
      await fromCheckpoint.close(context);
      await fromFold.close(context);

      // Two owners, one through the fold and one through the checkpoint the first wrote on open,
      // mint the same next id and would commit the same next seq.
      const throughFold = await PostgresStorage.open(sql, { logId }, context);
      expect(throughFold.opened.checkpoint).toBeUndefined();
      await throughFold.checkpointsWritten();
      expect((await checkpointOf(logId))?.seq).toBe(
        (restoredAt ?? 0) + commitsRead,
      );
      const throughCheckpoint = await PostgresStorage.open(
        sql,
        { logId },
        context,
      );
      expect(throughCheckpoint.opened.commitsRead).toBe(0);
      const next = await throughCheckpoint.mintId<EntryId>();
      expect(next).toBe(await throughFold.mintId());
      const head = (restoredAt ?? 0) + commitsRead;
      expect(
        await throughCheckpoint.commit([entryWrite(next, "after")], context),
      ).toBe(head + 1);
      await throughFold.close(context);
      await throughCheckpoint.close(context);
    },
  );

  /** What `run` wrote to the console, each call's arguments joined. */
  const logged = async (run: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      }),
    );
    try {
      await run();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return lines;
  };

  describe("a stale checkpoint is ignored, not served", () => {
    /** Open `logId` as a reader and assert it folded all `commits` and reads back `expected`. */
    const expectFullFold = async (
      logId: string,
      commits: number,
      fold: string | undefined,
    ) => {
      const reader = await openReader(logId);
      expect(reader.opened).toEqual({
        checkpoint: undefined,
        commitsRead: commits,
      });
      expect(reader.encodedFold()).toBe(fold);
      await reader.close(context);
    };

    /** Put `from`'s checkpoint row on `to`, as if `to`'s log had been rewritten under it. */
    const moveCheckpoint = (from: string, to: string) =>
      Effect.runPromise(sql`
        INSERT INTO log_checkpoints (log_id, seq, shape, commit_hash, fold)
        SELECT ${to}, seq, shape, commit_hash, fold FROM log_checkpoints WHERE log_id = ${from}
        ON CONFLICT (log_id) DO UPDATE SET
          seq = EXCLUDED.seq,
          shape = EXCLUDED.shape,
          commit_hash = EXCLUDED.commit_hash,
          fold = EXCLUDED.fold
      `);

    it(
      "of another shape, as after a Pi Durable bump",
      { timeout: 30_000 },
      async () => {
        const { logId, fold } = await seedLog(12, 5);
        await Effect.runPromise(sql`
          UPDATE log_checkpoints SET shape = 'memory-fold/0 pi-durable@0.0.0'
          WHERE log_id = ${logId}
        `);
        await expectFullFold(logId, 13, fold);
      },
    );

    it(
      "taken after a commit the log does not hold",
      { timeout: 30_000 },
      async () => {
        // A checkpoint at seq 21 on a log whose head is 6: the log was truncated and reused.
        const longer = await seedLog(20, 5, (at) => `longer ${at}`);
        const shorter = await seedLog(5, 100);
        expect(await checkpointOf(shorter.logId)).toBeUndefined();
        await moveCheckpoint(longer.logId, shorter.logId);
        expect((await checkpointOf(shorter.logId))?.seq).toBe(20);
        await expectFullFold(shorter.logId, 6, shorter.fold);
      },
    );

    it(
      "taken after a different commit at the same seq",
      { timeout: 30_000 },
      async () => {
        // Same length, same ids, different text: only the commit hash tells the two apart.
        const theirs = await seedLog(10, 5, (at) => `theirs ${at}`);
        const ours = await seedLog(10, 5, (at) => `ours ${at}`);
        await moveCheckpoint(theirs.logId, ours.logId);
        const reader = await openReader(ours.logId);
        expect(reader.opened).toEqual({
          checkpoint: undefined,
          commitsRead: 11,
        });
        expect(await texts(reader)).toEqual(
          Array.from({ length: 10 }, (_, at) => ({ text: `ours ${at}` })),
        );
        expect(reader.encodedFold()).toBe(ours.fold);
        await reader.close(context);
      },
    );

    it("whose fold does not decode", { timeout: 30_000 }, async () => {
      // Bytes that are not gzip, and gzip of JSON that is not a fold: neither is served, and
      // each is a fault an operator can see, not only a slower open.
      const { logId, fold } = await seedLog(12, 5);
      for (const [bytes, warning] of [
        [Uint8Array.from([1, 2, 3]), "could not be read"],
        [await compressFold('{"recordTypes": "not a map"}'), "did not decode"],
      ] as const) {
        await Effect.runPromise(sql`
          UPDATE log_checkpoints SET fold = ${bytes} WHERE log_id = ${logId}
        `);
        const warnings = await logged(() => expectFullFold(logId, 13, fold));
        expect(warnings).toContainEqual(
          expect.stringContaining(`checkpoint of log ${logId}`),
        );
        expect(warnings).toContainEqual(expect.stringContaining(warning));
      }
    });
  });

  it(
    "writes one every interval, and only from an owner",
    { timeout: 30_000 },
    async () => {
      // A log written with checkpoints off has none; a reader folding it writes none either.
      const { logId } = await seedLog(12, Number.POSITIVE_INFINITY);
      expect(await checkpointOf(logId)).toBeUndefined();
      const reader = await PostgresStorage.open(
        sql,
        { logId, mode: "reader", checkpointEvery: 1 },
        context,
      );
      expect(reader.opened.commitsRead).toBe(13);
      await reader.close(context);
      expect(await checkpointOf(logId)).toBeUndefined();

      // An owner that folded a tail at least an interval long checkpoints at open, then every
      // interval after that and not between.
      const owner = await PostgresStorage.open(
        sql,
        { logId, checkpointEvery: 4 },
        context,
      );
      await owner.checkpointsWritten();
      expect((await checkpointOf(logId))?.seq).toBe(13);
      for (let at = 0; at < 3; at += 1) {
        await owner.commit(
          [entryWrite(await owner.mintId<EntryId>(), `more ${at}`)],
          context,
        );
      }
      await owner.checkpointsWritten();
      expect((await checkpointOf(logId))?.seq).toBe(13);
      await owner.commit(
        [entryWrite(await owner.mintId<EntryId>(), "fourth")],
        context,
      );
      await owner.checkpointsWritten();
      expect((await checkpointOf(logId))?.seq).toBe(17);
      await owner.close(context);
      expect(CHECKPOINT_EVERY).toBeGreaterThan(0);
    },
  );

  it(
    "commits on when a checkpoint write fails, and waits an interval before the next",
    { timeout: 30_000 },
    async () => {
      // A trigger that rejects this one log's checkpoint rows, so no other log in the shared
      // database is touched. The log id is this file's own `[a-z0-9-]` shape, safe to inline.
      const logId = nextLogId();
      const name = `reject_checkpoint_${logId.replaceAll("-", "_")}`;
      await Effect.runPromise(
        sql.unsafe(`
          CREATE FUNCTION ${name}() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'checkpoint rejected for the test'; END;
          $$ LANGUAGE plpgsql
        `),
      );
      await Effect.runPromise(
        sql.unsafe(`
          CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON log_checkpoints
          FOR EACH ROW WHEN (NEW.log_id = '${logId}') EXECUTE FUNCTION ${name}()
        `),
      );
      try {
        const owner = await PostgresStorage.open(
          sql,
          { logId, checkpointEvery: 3 },
          context,
        );
        await owner.commit([root], context);
        const seqs: number[] = [];
        for (let at = 0; at < 4; at += 1) {
          seqs.push(
            await owner.commit(
              [entryWrite(await owner.mintId<EntryId>(), `kept ${at}`)],
              context,
            ),
          );
        }
        // Commit 3's checkpoint was rejected; 4 and 5 are inside the restarted interval.
        expect(seqs).toEqual([2, 3, 4, 5]);
        await owner.checkpointsWritten();
        expect(await checkpointOf(logId)).toBeUndefined();
        await owner.close(context);

        await Effect.runPromise(
          sql.unsafe(`DROP TRIGGER ${name} ON log_checkpoints`),
        );
        const reader = await openReader(logId);
        expect(reader.opened).toEqual({
          checkpoint: undefined,
          commitsRead: 5,
        });
        expect(await texts(reader)).toEqual(
          Array.from({ length: 4 }, (_, at) => ({ text: `kept ${at}` })),
        );
        await reader.close(context);
      } finally {
        await Effect.runPromise(
          sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON log_checkpoints`),
        );
        await Effect.runPromise(
          sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`),
        );
      }
    },
  );

  it(
    "resolves a commit before its checkpoint is written, and writes them in order",
    { timeout: 30_000 },
    async () => {
      // A trigger that makes this one log's checkpoint upsert wait on an advisory lock the test
      // holds, so the write is stuck for as long as the test says. A commit that waited for its
      // checkpoint would never resolve here.
      const logId = nextLogId();
      const name = `hold_checkpoint_${logId.replaceAll("-", "_")}`;
      await Effect.runPromise(
        sql.unsafe(`
          CREATE FUNCTION ${name}() RETURNS trigger AS $$
          BEGIN PERFORM pg_advisory_xact_lock(hashtext(NEW.log_id)); RETURN NEW; END;
          $$ LANGUAGE plpgsql
        `),
      );
      await Effect.runPromise(
        sql.unsafe(`
          CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON log_checkpoints
          FOR EACH ROW WHEN (NEW.log_id = '${logId}') EXECUTE FUNCTION ${name}()
        `),
      );
      const locked = Deferred.makeUnsafe<void>();
      const released = Deferred.makeUnsafe<void>();
      const release = () =>
        Effect.runSync(Deferred.succeed(released, undefined));
      const holder = Effect.runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${logId}))`;
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(released);
          }),
        ),
      );
      try {
        await Effect.runPromise(Deferred.await(locked));
        const owner = await PostgresStorage.open(
          sql,
          { logId, checkpointEvery: 2 },
          context,
        );
        const within = <A>(promise: Promise<A>) =>
          Effect.runPromise(
            Effect.promise(() => promise).pipe(
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () =>
                  Effect.die(new Error("the commit waited on its checkpoint")),
              }),
            ),
          );
        await within(owner.commit([root], context));
        const seqs: number[] = [];
        for (let at = 0; at < 3; at += 1) {
          seqs.push(
            await within(
              owner.commit(
                [entryWrite(await owner.mintId<EntryId>(), `held ${at}`)],
                context,
              ),
            ),
          );
        }
        // Commits 2 and 4 each started a checkpoint; neither has landed, and neither held up a commit.
        expect(seqs).toEqual([2, 3, 4]);
        expect(await checkpointOf(logId)).toBeUndefined();

        release();
        await holder;
        await owner.checkpointsWritten();
        // Both landed, in the order they were taken: the row is the later one.
        expect((await checkpointOf(logId))?.seq).toBe(4);
        await owner.close(context);
        const reader = await openReader(logId);
        expect(reader.opened).toEqual({ checkpoint: 4, commitsRead: 0 });
        await reader.close(context);
      } finally {
        release();
        await holder;
        await Effect.runPromise(
          sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON log_checkpoints`),
        );
        await Effect.runPromise(
          sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`),
        );
      }
    },
  );

  it(
    "starts a batched read of each log from its checkpoint, when asked to (LOB-243)",
    { timeout: 30_000 },
    async () => {
      // `rewritten` holds `good`'s commits with commit 5 replaced by one that does not fold (a second
      // root), and `good`'s checkpoint at 20 — still valid, since commit 20 is the same commit. A
      // read that starts from the checkpoint never meets commit 5; a read from the start fails on it.
      // So `rewritten` folding at all is the proof that commits 1–20 were not read.
      const good = await seedLog(25, 10);
      const rewritten = nextLogId();
      await Effect.runPromise(sql`
        INSERT INTO commits (log_id, seq, writes)
        SELECT ${rewritten}, seq,
               CASE WHEN seq = 5 THEN ${JSON.stringify([root])}::json ELSE writes END
        FROM commits WHERE log_id = ${good.logId}
      `);
      await Effect.runPromise(sql`
        INSERT INTO log_checkpoints (log_id, seq, shape, commit_hash, fold)
        SELECT ${rewritten}, seq, shape, commit_hash, fold
        FROM log_checkpoints WHERE log_id = ${good.logId}
      `);
      // A stale checkpoint is not served here either: `stale` folds whole and still answers.
      const stale = await seedLog(12, 5);
      await Effect.runPromise(sql`
        UPDATE log_checkpoints SET shape = 'memory-fold/0 pi-durable@0.0.0'
        WHERE log_id = ${stale.logId}
      `);

      const batched = await PostgresStorage.readers(
        sql,
        [good.logId, rewritten, stale.logId],
        { checkpoints: true },
      );
      const expected = Array.from({ length: 25 }, (_, at) => ({
        text: `message ${at}`,
      }));
      expect(await texts(batched.get(good.logId)!)).toEqual(expected);
      expect(await texts(batched.get(rewritten)!)).toEqual(expected);
      expect(await texts(batched.get(stale.logId)!)).toEqual(
        Array.from({ length: 12 }, (_, at) => ({ text: `message ${at}` })),
      );
      // The fold a checkpoint start leaves is the full fold's, not only the same transcript.
      const fromStart = await PostgresStorage.readers(sql, [good.logId], {
        checkpoints: false,
      });
      const encoded = (storage: Storage | undefined) =>
        storage instanceof MemoryStorage ? encodeFold(storage) : undefined;
      expect(encoded(batched.get(good.logId))).toBe(good.fold);
      expect(encoded(fromStart.get(good.logId))).toBe(good.fold);

      await expect(
        PostgresStorage.readers(sql, [rewritten], { checkpoints: false }),
      ).rejects.toThrow(`commit 5 of log ${rewritten} does not fold`);
    },
  );

  it(
    "round-trips U+0000 and lone surrogates through the checkpoint",
    { timeout: 30_000 },
    async () => {
      const text = "a\u0000b\ud800c";
      const { logId } = await seedLog(1, 1, () => text);
      const reader = await openReader(logId);
      expect(reader.opened).toEqual({ checkpoint: 2, commitsRead: 0 });
      expect(await texts(reader)).toEqual([{ text }]);
      await reader.close(context);
    },
  );

  it(
    "knows the installed MemoryStorage, and restores nothing that is not a fold it wrote",
    { timeout: 30_000 },
    () => {
      // `false` would turn checkpoints off silently; this is where a Pi Durable bump that changed
      // the store's fields surfaces.
      expect(foldShape()).toBe(true);
      expect(CHECKPOINT_SHAPE).toMatch(
        /^memory-fold\/1 pi-durable@\d+\.\d+\.\d+/,
      );
      const encoded = encodeFold(new MemoryStorage());
      if (encoded === undefined)
        throw new Error("the empty fold did not encode");
      const fields = (): Record<string, unknown> => ({
        ...JSON.parse(encoded),
      });
      const restored = restoreFold(encoded, 3);
      expect(restored).toBeInstanceOf(MemoryStorage);
      expect(restored === undefined ? undefined : encodeFold(restored)).toBe(
        encoded,
      );
      for (const bad of [
        "not json",
        "[]",
        "{}",
        JSON.stringify({ ...fields(), extra: [] }),
        JSON.stringify({ ...fields(), taskIds: {} }),
        JSON.stringify({ ...fields(), recordTypes: [["x", "entry"]] }),
        JSON.stringify({ ...fields(), entries: [[1]] }),
      ]) {
        expect(restoreFold(bad, 1), bad).toBeUndefined();
      }
      expect(restoreFold(encoded, 0)).toBeUndefined();
    },
  );
});

/**
 * `PostgresStorage.readers` (LOB-115): many logs in pages, where `reader` is one log at a time.
 *
 * Every case below compares against the single-log path rather than against a fixed expectation,
 * because the claim being made is that batching changed the cost and not the answer — a hand-written
 * expected transcript would only say the two implementations agree with each other's bug.
 */
describe.each([false, true])(
  "PostgresStorage.readers, checkpoints: %s",
  (checkpoints) => {
    const modes = { checkpoints } as const;
    const root = {
      type: "conversation",
      value: { id: ROOT_CONVERSATION_ID },
    } as const;
    const entryWrite = (id: EntryId, text: string): StorageWrite => ({
      type: "entry",
      value: {
        id,
        conversationId: ROOT_CONVERSATION_ID,
        kind: "user",
        data: { text },
      },
    });

    /** Write a log of `entries` user messages and hand back its id and the entry ids, in order. */
    const seedLog = async (entries: number) => {
      const logId = nextLogId();
      const owner = await PostgresStorage.open(sql, { logId }, context);
      await owner.commit([root], context);
      const ids: EntryId[] = [];
      for (let at = 0; at < entries; at += 1) {
        const id = await owner.mintId<EntryId>();
        ids.push(id);
        await owner.commit([entryWrite(id, `message ${at}`)], context);
      }
      await owner.close(context);
      return { logId, ids };
    };

    /**
     * Everything the fold reads of one log, as one comparable value.
     *
     * Paged and reversed the way `readAllEntries` pages and reverses (`ENTRY_PAGE` in
     * `@repo/harness`), because a scan answers newest first and a limit that fits only the first page
     * would make a long log look like a short one — the batched read's whole risk is reading a page
     * and believing it was the log.
     */
    const transcript = async (storage: Storage) => {
      const items: { id: EntryId; data: unknown }[] = [];
      let cursor: Cursor | undefined;
      for (;;) {
        const page = await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          500,
          cursor,
          context,
        );
        items.push(
          ...page.items.map((entry) => ({ id: entry.id, data: entry.data })),
        );
        cursor = page.next;
        if (cursor === undefined) break;
      }
      return {
        conversation: await storage.conversation(ROOT_CONVERSATION_ID, context),
        entries: items.reverse(),
      };
    };

    /** The store a batched read returned for `logId`, or a thrown error as a comparable value. */
    const folded = async (store: Storage | undefined) => {
      if (store === undefined) return "no store";
      try {
        return await transcript(store);
      } catch (cause) {
        return `threw: ${(cause as Error).message}`;
      }
    };

    it(
      "answers each requested log exactly as the single-log reader answers it",
      { timeout: 30_000 },
      async () => {
        const a = await seedLog(3);
        const b = await seedLog(1);
        const c = await seedLog(7);

        const batched = await PostgresStorage.readers(
          sql,
          [a.logId, b.logId, c.logId],
          modes,
        );
        expect([...batched.keys()].sort()).toEqual(
          [a.logId, b.logId, c.logId].sort(),
        );

        for (const { logId, ids } of [a, b, c]) {
          const reader = await PostgresStorage.reader(sql, logId);
          expect(await folded(batched.get(logId))).toEqual(
            await folded(reader),
          );
          const fromBatch = await transcript(batched.get(logId)!);
          expect(fromBatch.entries.map((entry) => entry.id)).toEqual([...ids]);
          await reader.close(context);
        }
      },
    );

    it(
      "gives a log with no commits a store that reads as empty, not a missing key",
      { timeout: 30_000 },
      async () => {
        const present = await seedLog(2);
        const absent = nextLogId();

        const batched = await PostgresStorage.readers(
          sql,
          [present.logId, absent],
          modes,
        );
        expect(batched.has(absent)).toBe(true);

        // The comparison is the whole claim: a log with no commits has no conversation in it, so
        // `MemoryStorage` refuses to scan it — and it refuses the same way through both paths. What
        // would be new here is the *missing key*, which is what a `continue` in the caller would read.
        const reader = await PostgresStorage.reader(sql, absent);
        expect(await folded(batched.get(absent))).toEqual(await folded(reader));
        expect(
          await batched
            .get(absent)!
            .conversation(ROOT_CONVERSATION_ID, context),
        ).toBeUndefined();
        await reader.close(context);
      },
    );

    it(
      "folds a log whose commits span more than one page",
      { timeout: 30_000 },
      async () => {
        // One row over the page size, so the log is split across two queries and the second starts
        // mid-log: the case `(log_id, seq)` paging exists for, and the one that would silently drop
        // the tail if a page were keyed on the log id alone.
        const fat = await seedLog(READER_PAGE_ROWS + 1);

        const batched = await PostgresStorage.readers(sql, [fat.logId], modes);
        const reader = await PostgresStorage.reader(sql, fat.logId);
        const fromReader = await transcript(reader);
        const fromBatch = await transcript(batched.get(fat.logId)!);
        expect(fromBatch).toEqual(fromReader);
        expect(fromBatch.entries).toHaveLength(READER_PAGE_ROWS + 1);
        expect(fromBatch.entries.map((entry) => entry.id)).toEqual(fat.ids);
        await reader.close(context);
      },
    );

    it(
      "keeps logs separate when a fat log pages beside a thin one",
      { timeout: 30_000 },
      async () => {
        // Both in one `ANY(…)`, ordered by `(log_id, seq)`: the thin log's rows can straddle a page
        // boundary the fat one forced. Comparing each against its own single-log reader is what says
        // the pages did not cross-contaminate.
        const fat = await seedLog(READER_PAGE_ROWS + 1);
        const thin = await seedLog(3);
        const batched = await PostgresStorage.readers(
          sql,
          [fat.logId, thin.logId],
          modes,
        );
        for (const { logId, ids } of [fat, thin]) {
          const reader = await PostgresStorage.reader(sql, logId);
          expect(await folded(batched.get(logId))).toEqual(
            await folded(reader),
          );
          const fromBatch = await transcript(batched.get(logId)!);
          expect(fromBatch.entries.map((entry) => entry.id)).toEqual([...ids]);
          await reader.close(context);
        }
      },
    );

    it(
      "answers an empty request with an empty map and no query",
      { timeout: 30_000 },
      async () => {
        expect([...(await PostgresStorage.readers(sql, [], modes))]).toEqual(
          [],
        );
      },
    );

    it(
      "names the log whose commit does not fold, and refuses the whole batch",
      { timeout: 30_000 },
      async () => {
        const good = await seedLog(2);
        const broken = nextLogId();
        // A `writes` array Pi Durable will not accept: the conversation already belongs to another log,
        // so folding it raises rather than skipping. Written through SQL because `commit` validates
        // before it persists, which is the property the adapter relies on elsewhere.
        await Effect.runPromise(
          sql`
        INSERT INTO commits (log_id, seq, writes)
        VALUES (${broken}, 1, ${`[{"type":"conversation","value":{"id":${JSON.stringify(ROOT_CONVERSATION_ID)}}}]`}::json),
               (${broken}, 2, ${JSON.stringify([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }])}::json)
      `,
        );

        await expect(
          PostgresStorage.readers(sql, [good.logId, broken], modes),
        ).rejects.toThrow(`of log ${broken} does not fold`);
        // The log that was fine is not the casualty of the one that was not: a batched read fails whole.
        expect(await PostgresStorage.reader(sql, good.logId)).toBeTruthy();
      },
    );

    it(
      "names the log whose commit is not a write array",
      { timeout: 30_000 },
      async () => {
        const broken = nextLogId();
        await Effect.runPromise(
          sql`INSERT INTO commits (log_id, seq, writes) VALUES (${broken}, 1, '{"not":"an array"}'::json)`,
        );
        await expect(
          PostgresStorage.readers(sql, [broken], modes),
        ).rejects.toThrow(`of log ${broken} is not a write array`);
      },
    );
  },
);

/**
 * The board's tables and the default pipeline seed (docs/board.md B1–B6, migration 0007).
 *
 * These cases read the database rather than the migration's source, because the claim being made is
 * about what a reader finds after the migration has run: the seed is a fact in the database, not a
 * string in a file. The one exception is the second-run case, which drives the migration's own
 * default export twice — `PgMigrator` records what it has already applied, so going through the
 * layer again would prove nothing about the seed's idempotence.
 *
 * Needs the same Postgres as the rest of this file.
 */
describe("the board's tables and seed", () => {
  const table = (name: string) =>
    Effect.runPromise(
      sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}
      `,
    );

  /**
   * The SQLSTATE of a failed statement, which is the part of a Postgres error that does not depend
   * on how the driver words it. Effect wraps it two levels deep (`SqlError` -> the reason -> the
   * driver's own error), and the message a caller sees is `PgConnection: Query failed` either way.
   */
  const sqlstate = (error: unknown): string | undefined => {
    let current: unknown = error;
    for (
      let depth = 0;
      current !== null && typeof current === "object";
      depth += 1
    ) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = (current as { cause?: unknown }).cause;
      if (depth > 6) break;
    }
    return undefined;
  };

  it(
    "creates the five tables the board's contract names",
    { timeout: 30_000 },
    async () => {
      for (const name of [
        "tasks",
        "task_events",
        "task_runs",
        "board_definitions",
        "board_instances",
      ]) {
        expect(await table(name)).toHaveLength(1);
      }
    },
  );

  it(
    "seeds definition version 1 as B4's seven columns, with their kinds and requires",
    { timeout: 30_000 },
    async () => {
      const [row] = await Effect.runPromise(
        sql<{ id: string; version: number; name: string; columns: unknown }>`
          SELECT id, version, name, columns FROM board_definitions
          WHERE id = 'default' AND version = 1
        `,
      );
      expect(row).toBeDefined();

      // Decoded through the domain contract, not asserted field by field against a hand-written
      // copy: the claim is that the database holds what `BoardDefinition` says a definition is, so
      // a column set the contract rejects is a failure here rather than in a reader.
      const definition = Schema.decodeUnknownSync(BoardDefinition)(row);
      expect(definition.id).toBe("default");
      expect(definition.version).toBe(1);
      expect(definition.name).toBe("Default pipeline");

      expect(definition.columns.map((column) => column.name)).toEqual([
        "intake",
        "specifying",
        "planning",
        "building",
        "review",
        "done",
        "canceled",
      ]);

      const byName = new Map(
        definition.columns.map((column) => [column.name, column]),
      );
      const column = (name: string) => {
        const found = byName.get(name);
        if (found === undefined)
          throw new Error(`seed is missing the ${name} column`);
        return found;
      };

      // B4's kinds: one resting, four working, two terminal.
      expect(column("intake").kind).toBe("resting");
      for (const name of ["specifying", "planning", "building", "review"]) {
        expect(column(name).kind).toBe("working");
      }
      for (const name of ["done", "canceled"]) {
        expect(column(name).kind).toBe("terminal");
      }

      // B4's roles: the four working columns name one, the rest have none.
      expect(column("intake").role).toBeUndefined();
      expect(column("specifying").role).toBe("specifier");
      expect(column("planning").role).toBe("planner");
      expect(column("building").role).toBe("builder");
      expect(column("review").role).toBe("reviewer");
      expect(column("done").role).toBeUndefined();
      expect(column("canceled").role).toBeUndefined();

      // B4's exit requirements, by key. `intake` and the two terminal columns gate nothing on exit;
      // `planning` and `review` each carry B5's human gate as a requirement the board can name.
      expect(column("intake").requires).toEqual([]);
      expect(column("done").requires).toEqual([]);
      expect(column("canceled").requires).toEqual([]);
      expect(
        column("specifying").requires.map((requirement) => requirement.key),
      ).toEqual(["spec_doc"]);
      expect(
        column("planning").requires.map((requirement) => requirement.key),
      ).toEqual(["plan_doc", "human_move"]);
      expect(
        column("building").requires.map((requirement) => requirement.key),
      ).toEqual(["run_completed", "non_empty_diff", "pr_link"]);
      expect(
        column("review").requires.map((requirement) => requirement.key),
      ).toEqual(["review_verdict", "human_merge"]);

      // Every requirement carries the key B5 requires a refusal to name, and the description a
      // person reads — a requirement with either missing is prose the gate cannot check.
      for (const column of definition.columns) {
        for (const requirement of column.requires) {
          expect(requirement.key).toMatch(/^[a-z][a-z0-9_]*$/);
          expect(requirement.description.length).toBeGreaterThan(0);
        }
      }
    },
  );

  it(
    "leaves one version-1 row when 0007's seed runs a second time",
    { timeout: 30_000 },
    async () => {
      const migration = (await import("./migrations/0007_create_tasks"))
        .default;
      // Run directly, not through `MigratedLive`: the migrator records what it has applied, so a
      // second trip through the layer would skip 0007 and prove nothing about the seed.
      await Effect.runPromise(
        migration.pipe(Effect.provideService(SqlClient, sql)),
      );

      // The claim is 0007's own idempotence, so it is asked about the row 0007 seeds. 0010 adds a
      // second version *of the same definition* beside it (B2 never edits a version in place), and
      // a total row count would read that as 0007 seeding twice.
      const rows = await Effect.runPromise(
        sql<{ id: string; version: number }>`
          SELECT id, version FROM board_definitions
          WHERE id = 'default' AND version = 1
        `,
      );
      expect(rows).toEqual([{ id: "default", version: 1 }]);
    },
  );

  /**
   * 0010: the second version of the default pipeline, which binds the skills 0009 seeds to the
   * stages that need them (docs/board.md B6, LOB-174).
   *
   * Read from the database, like the version-1 case above, because the claim is what a reader finds
   * after the migration ran. The columns are compared through `BoardDefinition` rather than against
   * a copied literal, so a column set the contract rejects fails here.
   */
  it(
    "binds the seeded skills to their stages on version 2, and only ever once",
    { timeout: 30_000 },
    async () => {
      const read = (version: number) =>
        Effect.runPromise(
          sql<{ id: string; version: number; name: string; columns: unknown }>`
            SELECT id, version, name, columns FROM board_definitions
            WHERE id = 'default' AND version = ${version}
          `,
        );

      const [row] = await read(2);
      expect(row).toBeDefined();
      if (row === undefined) return;
      const definition = Schema.decodeUnknownSync(BoardDefinition)(row);
      expect(definition.version).toBe(2);
      expect(definition.name).toBe("Default pipeline");

      const skills = new Map(
        definition.columns.map((column) => [column.name, column.skills]),
      );
      // The three skills 0009 seeds are the three working stages' rules, so each is bound to its
      // stage; the resting and terminal columns run nothing and name none.
      expect(Object.fromEntries(skills)).toEqual({
        intake: [],
        specifying: ["specify"],
        planning: [],
        building: ["implement"],
        review: ["review"],
        done: [],
        canceled: [],
      });

      // Version 1 is untouched: a card pinned to it keeps the columns it started under (B2).
      const [version1] = await read(1);
      expect(version1).toBeDefined();
      if (version1 === undefined) return;
      const before = Schema.decodeUnknownSync(BoardDefinition)(version1);
      for (const column of before.columns) expect(column.skills).toEqual([]);

      // Idempotent: `(id, version)` is the primary key, so a second pass over a database that
      // already has the row is a no-op rather than a second copy of the pipeline.
      const migration = (await import("./migrations/0010_seed_pipeline_skills"))
        .default;
      await Effect.runPromise(
        migration.pipe(Effect.provideService(SqlClient, sql)),
      );
      expect(await read(2)).toHaveLength(1);
    },
  );

  it(
    "refuses a card that is blocked without the column it blocked from",
    { timeout: 30_000 },
    async () => {
      // No instance exists until something creates one — the writer is LOB-59's — so this case
      // makes its own rather than depending on a reader that does not exist yet. Minted per run and
      // dropped in the `finally` rather than reused: a fixed id would collide with a second run of
      // this file against one database (`23505` on the instance, a red case rather than a red
      // file), which is the shape LOB-98 was filed for in the core suite, and leaving the row
      // behind would make every later run's `SELECT … LIMIT 1` find a *different* board than the
      // one it just made. The shape is `BoardInstanceId`'s — `brd_` and twenty-six Crockford-base32
      // characters, of which hex's sixteen are a subset — so the fixture is one the contract
      // accepts, not a shorter stand-in that only the database accepts.
      const boardId = `brd_${randomBytes(13).toString("hex")}`;
      await Effect.runPromise(
        sql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
            VALUES (${boardId}, 'factory/test', 'default', 1)`,
      );

      try {
        const refused = await Effect.runPromise(
          sql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, blocked_reason)
              VALUES ('tsk_test_blocked_card', ${boardId}, 'blocked', 'building', 1, 1, 'needs_input')`,
        ).then(
          () => {
            throw new Error("the half-blocked card was accepted");
          },
          (error: unknown) => error,
        );
        // 23514 is check_violation. Asserted by code rather than by the constraint's name because the
        // name is generated from the table and column and would make this case brittle to a rename.
        expect(sqlstate(refused)).toBe("23514");
      } finally {
        await Effect.runPromise(
          sql`DELETE FROM board_instances WHERE id = ${boardId}`,
        );
      }
    },
  );

  it(
    "refuses a board instance that names a definition version which does not exist",
    { timeout: 30_000 },
    async () => {
      const refused = await Effect.runPromise(
        sql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
            VALUES ('brd_test_unknown_version', 'factory/test', 'default', 99)`,
      ).then(
        () => {
          throw new Error("the unknown definition version was accepted");
        },
        (error: unknown) => error,
      );
      // 23503 is foreign_key_violation.
      expect(sqlstate(refused)).toBe("23503");
    },
  );

  /**
   * B4's table, every field of every column, as the literal a reader of `docs/board.md` would copy
   * out of it: the name, the kind, the role (`undefined` where B4 prints an em dash) and the exit
   * requirements with their descriptions, not only their keys.
   *
   * `intake`'s empty `requires` is the one entry B4 does not spell as a requirement. Its exit cell
   * reads "a person moves it on (nothing auto-starts; the card may be nearly empty)", which is a
   * statement about the column rather than a gate: B5 names exactly two human gates (the plan
   * approval and the merge) and describes the move out of `intake` as "the recorded move that
   * starts the first run", so nothing is checked on the way out and there is no requirement key a
   * refusal could name. The two columns B5 does call gates carry theirs.
   */
  const B4_COLUMNS = [
    {
      name: "intake",
      kind: "resting",
      role: undefined,
      skills: [],
      requires: [],
    },
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
    {
      name: "done",
      kind: "terminal",
      role: undefined,
      skills: [],
      requires: [],
    },
    {
      name: "canceled",
      kind: "terminal",
      role: undefined,
      skills: [],
      requires: [],
    },
  ];

  /**
   * What the migration *writes*, read on a database it has never run against.
   *
   * The seed case above reads `board_definitions` in the run's database, which is a weaker claim
   * than it looks: `PgMigrator` records 0007 as applied and the seed is `ON CONFLICT … DO NOTHING`,
   * so a database seeded by an *earlier* run keeps the row that run wrote, and every one of the
   * seed's fields can be edited without a single case above going red (measured: shortening
   * `spec_doc`'s description to "a spec doc", or `planning`'s kind to `resting`, leaves those cases
   * green — only this case reddens). A criterion about what the seed *resolves to* is a claim about
   * a database the migration has just created the tables in, so that is where it is read.
   *
   * The database is this case's own, minted here and dropped in the `finally`; the configured
   * database only ever sees the `CREATE DATABASE` and the `DROP DATABASE` below. A run killed
   * between the two leaks its database — empty, seconds old — and **nothing sweeps it**: the sweep
   * in `packages/core/src/SessionService.test.ts` is prefix-scoped to `${base}_core_`, which
   * `factory_lob58_*` is not. So these leaks are real and currently uncollected; a sweep that
   * takes a prefix rather than a hard-coded one would collect them, and until then a killed run of
   * this file leaves a database behind. (The DDL suite below has the same window around its
   * `beforeAll`/`afterAll` pair and the same absence of a collector.)
   *
   * The client mirrors `DatabaseLive`: `DatabaseConfig`'s own URL with the database swapped, and the
   * same name transforms, so the migration runs against the client shape `db:migrate` gives it.
   */
  it(
    "writes B4's columns, field by field, into a database it has never run against",
    { timeout: 120_000 },
    async () => {
      const configured = new URL(
        Redacted.value((await runtime.runPromise(DatabaseConfig)).url),
      );
      const scratchName = `factory_lob58_seed_${randomBytes(4).toString("hex")}`;
      const scratchUrl = new URL(configured.toString());
      scratchUrl.pathname = `/${scratchName}`;

      await Effect.runPromise(sql`CREATE DATABASE ${sql(scratchName)}`);

      const scratch = ManagedRuntime.make(
        PgClient.layer({
          url: Redacted.make(scratchUrl.toString()),
          maxConnections: 2,
          transformQueryNames: EffectString.camelToSnake,
          transformResultNames: EffectString.snakeToCamel,
        }).pipe(Layer.provide(BunServices.layer)),
      );

      try {
        const scratchSql = await scratch.runPromise(SqlClient);
        const migration = (await import("./migrations/0007_create_tasks"))
          .default;
        const migrate = migration.pipe(
          Effect.provideService(SqlClient, scratchSql),
        );

        /** How many relations of this name the database holds. */
        const present = async (name: string) => {
          const rows = await Effect.runPromise(
            scratchSql<{ present: number }>`
              SELECT count(*)::int AS present FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = ${name}
            `,
          );
          return rows[0]?.present ?? 0;
        };

        /** Every definition row the database holds, undecoded. */
        const definitions = () =>
          Effect.runPromise(
            scratchSql<{
              id: string;
              version: number;
              name: string;
              columns: unknown;
            }>`SELECT id, version, name, columns FROM board_definitions`,
          );

        const tables = [
          "tasks",
          "task_events",
          "task_runs",
          "board_definitions",
          "board_instances",
        ];

        // A database nothing has migrated has none of them, so the `1`s below are this run's
        // `CREATE TABLE`s rather than `IF NOT EXISTS` finding another run's tables.
        for (const name of tables) expect(await present(name)).toBe(0);

        await Effect.runPromise(migrate);

        for (const name of tables) expect(await present(name)).toBe(1);

        const afterFirst = await definitions();
        expect(afterFirst).toHaveLength(1);
        const seeded = Schema.decodeUnknownSync(BoardDefinition)(afterFirst[0]);
        expect(seeded.id).toBe("default");
        expect(seeded.version).toBe(1);
        expect(seeded.name).toBe("Default pipeline");
        expect(
          seeded.columns.map((column) => ({
            name: column.name,
            kind: column.kind,
            role: column.role,
            skills: column.skills,
            requires: column.requires,
          })),
        ).toEqual(B4_COLUMNS);

        // The second run is the acceptance criterion's own: one definition row, and the same one.
        await Effect.runPromise(migrate);
        expect(await definitions()).toEqual(afterFirst);
      } finally {
        await scratch.dispose();
        await Effect.runPromise(
          sql`DROP DATABASE IF EXISTS ${sql(scratchName)} WITH (FORCE)`,
        );
      }
    },
  );
});

/**
 * The `docs` skill 0015 seeds (LOB-225, part 1 of LOB-195), and the scope that part states: no
 * existing skill row is rewritten and no board definition is touched.
 *
 * Read from the configured database, not a scratch one, because the claim is about what a reader
 * finds after a real migrate — `DatabaseLive` in this file's runtime is what applies 0015. The rows
 * are decoded through `Skill` rather than compared field by field against a hand-written copy, so a
 * seeded document the contract rejects fails here instead of at the loader that would inject it.
 *
 * Mutation checked: deleting the INSERT from `0015_seed_docs_skill.ts` fails the first case (no
 * `docs` row to decode) and the second (the snapshot loses the only row 0015 adds); dropping the
 * `ON CONFLICT (name) DO NOTHING` fails neither, because the migration is not re-run through the
 * migrator — the second case runs the export directly and asserts the table does not move.
 */
describe("the skills table and its seeds", () => {
  const AttachmentsJson = Schema.fromJsonString(Schema.Array(Schema.String));

  /** One `skills` row as the driver returns it; `attachments` is selected as text. */
  type SkillRow = {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly body: string;
    readonly attachments: string;
  };

  /** Every skill row, as a comparable snapshot; `attachments` is selected as text. */
  const skills = () =>
    Effect.runPromise(
      sql<SkillRow>`
        SELECT name, version, description, body, attachments::text AS attachments
        FROM skills ORDER BY name
      `,
    );

  /**
   * Every version of the shipped `default` definition, as a comparable snapshot. 0015 must not move
   * any of them. Only the shipped rows: other suites (core's `createBoard` cases) add definitions of
   * their own to the same database while this file runs, and a whole-table snapshot would see them.
   */
  const definitions = () =>
    Effect.runPromise(
      sql<{ id: string; version: number; name: string; columns: string }>`
        SELECT id, version, name, columns::text AS columns
        FROM board_definitions WHERE id = 'default' ORDER BY version
      `,
    );

  const decode = (row: SkillRow) =>
    Schema.decodeSync(Skill)({
      ...row,
      attachments: Schema.decodeSync(AttachmentsJson)(row.attachments),
    });

  it(
    "seeds the docs skill with a name, version, description and body",
    { timeout: 30_000 },
    async () => {
      const [row] = (await skills()).filter((skill) => skill.name === "docs");
      expect(row).toBeDefined();
      if (row === undefined) return;

      const docs = decode(row);
      expect(docs.name).toBe("docs");
      expect(docs.version).toBe("1");
      expect(docs.description.length).toBeGreaterThan(0);
      expect(docs.body.length).toBeGreaterThan(0);
      // The body has to say *what* a docs run does, or the row is the wrong prompt: it edits
      // documentation, and it carries no attachments.
      expect(docs.body.toLowerCase()).toContain("documentation");
      expect(docs.attachments).toEqual([]);
    },
  );

  it(
    "adds the docs row once, and rewrites no other skill row or board definition",
    { timeout: 30_000 },
    async () => {
      // A row 0015 does not name, written with plain SQL: `ON CONFLICT (name) DO NOTHING` names one
      // name, so this row must come out of a second pass byte-identical or the seed is not the
      // single-row insert it claims to be. Minted per run and dropped in the `finally`, as the
      // board cases above mint their ids, because a fixed name would collide with a second run of
      // this file against one database.
      const neighbourName = `test-docs-neighbour-${randomBytes(6).toString("hex")}`;
      await Effect.runPromise(
        sql`
          INSERT INTO skills (name, version, description, body, attachments)
          VALUES (${neighbourName}, '7', 'a neighbour', '# Neighbour\n', '[]'::jsonb)
        `,
      );

      try {
        const skillsBefore = await skills();
        const definitionsBefore = await definitions();

        // Run directly, not through `MigratedLive`: the migrator records what it has applied, so a
        // second trip through the layer would skip 0015 and prove nothing about the seed.
        const migration = (await import("./migrations/0015_seed_docs_skill"))
          .default;
        await Effect.runPromise(
          migration.pipe(Effect.provideService(SqlClient, sql)),
        );

        const skillsAfter = await skills();
        // One `docs` row before and after: the primary key did its job rather than a second copy of
        // the skill landing beside the first.
        expect(
          skillsAfter.filter((skill) => skill.name === "docs"),
        ).toHaveLength(1);
        // Nothing moved, including the row 0015 does not name and the three stage skills 0009
        // seeded.
        expect(skillsAfter).toEqual(skillsBefore);
        expect(await definitions()).toEqual(definitionsBefore);
      } finally {
        await Effect.runPromise(
          sql`DELETE FROM skills WHERE name = ${neighbourName}`,
        );
      }
    },
  );

  it(
    "leaves the three stage skills 0009 seeded exactly as they were",
    { timeout: 30_000 },
    async () => {
      const byName = new Map(
        (await skills()).map((row) => [row.name, decode(row)]),
      );
      for (const name of ["specify", "implement", "review"]) {
        const seeded = byName.get(name);
        expect(seeded).toBeDefined();
        if (seeded === undefined) continue;
        // 0009 wrote `version: "1"` and a body headed by the stage's own name; 0015 adds a row and
        // must not have rewritten one of these.
        expect(seeded.version).toBe("1");
        expect(seeded.body).toContain(
          name.charAt(0).toUpperCase() + name.slice(1),
        );
      }
    },
  );

  // The `decompose` skill 0022 seeds (LOB-201): what a decomposition call is told. Mutation checked
  // the way the `docs` cases above are — deleting 0022's INSERT fails both cases.
  it(
    "seeds the decompose skill with the rules the proposal validator holds a decomposition to",
    { timeout: 30_000 },
    async () => {
      const [row] = (await skills()).filter(
        (skill) => skill.name === "decompose",
      );
      expect(row).toBeDefined();
      if (row === undefined) return;

      const decompose = decode(row);
      expect(decompose.version).toBe("1");
      expect(decompose.description.length).toBeGreaterThan(0);
      // The body has to say the rules `decodeProposedIssues` refuses on, or the model is held to
      // rules it was never told: a unique title, an acceptance line, edges only where real.
      const body = decompose.body.toLowerCase();
      expect(body).toContain("acceptance line");
      expect(body).toContain("title no other proposal has");
      expect(body).toContain("blockedby");
      expect(body).toContain("create nothing");
      expect(decompose.attachments).toEqual([]);
    },
  );

  it(
    "adds the decompose row once, and rewrites no other skill row",
    { timeout: 30_000 },
    async () => {
      // Only the rows no test writes: core's SkillService suite adds and drops `test-skill-*` rows
      // in the same database while this file runs.
      const shipped = async () =>
        (await skills()).filter((skill) => !skill.name.startsWith("test-"));
      const before = await shipped();
      const migration = (await import("./migrations/0022_seed_decompose_skill"))
        .default;
      await Effect.runPromise(
        migration.pipe(Effect.provideService(SqlClient, sql)),
      );
      const after = await shipped();
      expect(after.filter((skill) => skill.name === "decompose")).toHaveLength(
        1,
      );
      expect(after).toEqual(before);
    },
  );
});

/**
 * What 0007's DDL actually creates, read on a database this migration has just migrated.
 *
 * **Why this suite exists separately from the one above.** The cases above that refuse a write read
 * the *configured* database, whose tables were created by whichever run of 0007 first reached it.
 * 0007's DDL is `CREATE TABLE IF NOT EXISTS`, so editing a constraint in the file changes nothing
 * there — measured (`.verify/evidence/lob58-verifier/experiment-a-ddl-not-observed.log`): deleting
 * `tasks_blocked_is_all_or_nothing` from 0007 leaves *every* case in the file green, including the
 * blocked-refusal case (A1) and the scratch-database seed case (A3). The same is true of
 * `revision >= 1` (A6), `priority IN (...)` (A6c), `task_events.revision >= 1` (A6d), the
 * `blocked_since` pairing (A6e), `task_runs.session_id UNIQUE` (A7), `ON DELETE CASCADE` (A8),
 * `board_instances`' foreign key (A9), `tasks.blocked_note` (A4) and the `tasks_by_board` index
 * (A5). Every one of those SURVIVED. The DDL is therefore unwitnessed, and a case on the configured
 * database can never witness it: the constraint it reads may not exist in the file at all.
 *
 * So these cases own a scratch database they migrate themselves, and assert the shape and the
 * refusals the migration writes rather than the shape some earlier run happened to leave behind.
 * That is what makes each of them a real gate on the file.
 *
 * Two things this still cannot prove, stated here so no reader assumes otherwise:
 *
 * 1. **Nothing here runs the whole migrator**, only 0007's default export. That the directory is
 *    globbed and 0007 is picked up in order is `Migrations.ts`'s claim, not this file's; the
 *    configured database's `effect_sql_migrations` row is what says a real `db:migrate` applied it,
 *    and no case asserts that row.
 * 2. **The `columns` JSONB column is not checked by the database.** A column set `BoardColumn`
 *    rejects can be written with plain SQL and read back (proven below), so the migration header's
 *    "schema-valid by construction" is a claim about the *seed path* — the encoder runs before the
 *    INSERT — and about nothing else. The case that reads the seeded value back through the contract
 *    closes the loop for that path; nothing closes it for a writer that is not the migration.
 *
 * Needs the same Postgres as the rest of this file, and drops what it creates.
 */
describe("the board's DDL, as 0007 writes it", () => {
  let scratchName: string;
  /** Releases the scratch client; the runtime's own type is not nameable without a cast. */
  let disposeScratch: () => Promise<void> = async () => {};
  let scratchSql: SqlClient;

  /** The SQLSTATE of a refusal, three levels down through Effect's `SqlError`. */
  const sqlstate = (error: unknown): string | undefined => {
    let current: unknown = error;
    for (
      let depth = 0;
      current !== null && typeof current === "object";
      depth += 1
    ) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = (current as { cause?: unknown }).cause;
      if (depth > 6) break;
    }
    return undefined;
  };

  /**
   * The name of the constraint a refusal names, which is the part that says *which* rule fired.
   * Three levels deep for a check violation (the reason carries no `constraint`), two for a foreign
   * key or a unique violation (the reason does).
   */
  const constraint = (error: unknown): string | undefined => {
    let current: unknown = error;
    for (
      let depth = 0;
      current !== null && typeof current === "object";
      depth += 1
    ) {
      const name = (current as { constraint?: unknown }).constraint;
      if (typeof name === "string") return name;
      current = (current as { cause?: unknown }).cause;
      if (depth > 6) break;
    }
    return undefined;
  };

  /**
   * The refusal of a statement, as `undefined` when it was accepted — so a case that expects one
   * fails on the *acceptance*, not on a comparison of an error that was never thrown.
   *
   * Typed as an `Effect<unknown, SqlError>` rather than `Effect<unknown, unknown>`: the
   * sql client's error channel is `SqlError`, and the lint rule for an `unknown` error is right that
   * the wider type says nothing about what a caller receives.
   */
  const refusedBy = async (
    statement: Effect.Effect<unknown, SqlError>,
  ): Promise<unknown> =>
    await Effect.runPromise(statement).then(
      () => undefined,
      (error: SqlError) => error,
    );

  /** A `board_instances` id shaped the way `BoardInstanceId`'s pattern accepts, unique per call. */
  const boardId = () => `brd_${randomBytes(13).toString("hex")}`;
  /** A `tasks` id shaped the way `TaskId`'s pattern accepts, unique per call. */
  const taskId = () => `tsk_${randomBytes(13).toString("hex")}`;
  /** A `task_runs.session_id` shaped the way `SessionId`'s pattern accepts, unique per call. */
  const sessionId = () => `ses_${randomBytes(13).toString("hex")}`;
  /** A `task_runs.id`; the table has no pattern for it, only a primary key, so any string will do. */
  const runRowId = () => nextRunId();

  beforeAll(async () => {
    const configured = new URL(
      Redacted.value((await runtime.runPromise(DatabaseConfig)).url),
    );
    scratchName = `factory_lob58_ddl_${randomBytes(4).toString("hex")}`;
    const scratchUrl = new URL(configured.toString());
    scratchUrl.pathname = `/${scratchName}`;
    await Effect.runPromise(sql`CREATE DATABASE ${sql(scratchName)}`);

    const client = ManagedRuntime.make(
      PgClient.layer({
        url: Redacted.make(scratchUrl.toString()),
        maxConnections: 2,
        transformQueryNames: EffectString.camelToSnake,
        transformResultNames: EffectString.snakeToCamel,
      }).pipe(Layer.provide(BunServices.layer)),
    );
    disposeScratch = () => client.dispose();
    scratchSql = await client.runPromise(SqlClient);
    const migration = (await import("./migrations/0007_create_tasks")).default;
    await Effect.runPromise(
      migration.pipe(Effect.provideService(SqlClient, scratchSql)),
    );
  }, 120_000);

  afterAll(async () => {
    await disposeScratch();
    await Effect.runPromise(
      sql`DROP DATABASE IF EXISTS ${sql(scratchName)} WITH (FORCE)`,
    );
  });

  /**
   * The columns each table holds, in ordinal order.
   *
   * Read from `pg_attribute` rather than `information_schema` because the latter needs a per-table
   * query to keep the order, and this is the shape the *file* declares, so the order is part of it.
   */
  // The client's `transformResultNames` is `snakeToCamel` (it mirrors `DatabaseLive`, and the
  // scratch case above says so), so every aliased column below is written without an underscore: a
  // `column_name` alias would arrive as `columnName` and read as `undefined` here.

  const columnsOf = (table: string) =>
    Effect.runPromise(
      scratchSql<{ column: string }>`
        SELECT a.attname AS column
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table} AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
    ).then((rows) => rows.map((row) => row.column));

  /** Every index on the three tables, primary keys and unique constraints included. */
  const indexNames = () =>
    Effect.runPromise(
      scratchSql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('tasks', 'task_events', 'task_runs')
        ORDER BY indexname
      `,
    ).then((rows) => rows.map((row) => row.indexname));

  /**
   * The five tables, field by field — the shape `docs/board.md` B1–B3 ask for, and the part
   * `information_schema.tables` cannot see. `blocked_note` is here because `TaskBlocked.note` is a
   * real field: dropping the column is invisible to every other case in the file (A4).
   *
   * Mutation: delete `blocked_note TEXT,` from 0007 — this reddens.
   */
  it(
    "gives each table the columns the contract names, in the order it declares them",
    { timeout: 30_000 },
    async () => {
      expect(await columnsOf("board_definitions")).toEqual([
        "id",
        "version",
        "name",
        "columns",
        "created_at",
      ]);
      expect(await columnsOf("board_instances")).toEqual([
        "id",
        "repo",
        "definition_id",
        "definition_version",
        "created_at",
      ]);
      expect(await columnsOf("tasks")).toEqual([
        "id",
        "board_id",
        "title",
        "column",
        "repo",
        "definition_version",
        "revision",
        "priority",
        "blocked_reason",
        "blocked_column",
        "blocked_note",
        "blocked_since",
        "created_at",
        "updated_at",
      ]);
      expect(await columnsOf("task_events")).toEqual([
        "id",
        "task_id",
        "kind",
        "actor",
        "revision",
        "payload",
        "created_at",
      ]);
      expect(await columnsOf("task_runs")).toEqual([
        "id",
        "task_id",
        "session_id",
        "column",
        "started_at",
        "finished_at",
      ]);
    },
  );

  /**
   * The three indexes the migration creates, by name **and `tasks_by_board` by column list**, plus
   * `title`'s default.
   *
   * B9's ordering clause (`board_id, priority, created_at`) is the index a reader of a lane would
   * use, and asserting its *name* alone leaves the columns free: `(board_id)` alone stayed green
   * when the three columns were measured as unwitnessed.
   *
   * The names are asserted as *containment* rather than equality: Postgres names the primary keys
   * and the unique constraint too, and listing all of them would be asserting the key declarations
   * as well as the three `CREATE INDEX` lines, which the other cases already cover. The *columns*
   * are asserted exactly, because that is the part B9 is about.
   *
   * `pg_index.indkey` is the column numbers as an array of attribute numbers, so this joins
   * `pg_attribute` for the names and orders by the number's position in that array — rather than
   * reading the migration's source, which is the thing under test.
   *
   * Mutation: delete the `tasks_by_board` line from 0007 — the first assertion goes. Mutation:
   * narrow it to `(board_id)` — the columns assertion goes. Mutation: drop `NOT NULL DEFAULT `\'\'`
   * from `title` — the last assertion goes.
   */
  it(
    "indexes the three reads a board makes, with tasks_by_board's columns and title's default",
    { timeout: 30_000 },
    async () => {
      const names = await indexNames();
      expect(names).toContain("tasks_by_board");
      expect(names).toContain("task_events_by_task");
      expect(names).toContain("task_runs_by_task");

      // `pg_index.indkey` is an `int2vector`, whose subscripting is **0-based** and which is not an
      // array, so `a.attnum = ANY(i.indkey)` silently matches one column. `generate_series` over
      // `indnkeyatts` and `i.indkey[k]` is the idiom that reads all of them, in order.
      const ordered = await Effect.runPromise(
        scratchSql<{ column: string }>`
          SELECT a.attname AS column
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL generate_series(0, i.indnkeyatts - 1) AS k(pos)
          JOIN pg_attribute a
            ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k.pos]
          WHERE n.nspname = 'public' AND c.relname = 'tasks_by_board'
          ORDER BY k.pos
        `,
      ).then((rows) => rows.map((row) => row.column));
      expect(ordered).toEqual(["board_id", "priority", "created_at"]);

      // `title TEXT NOT NULL DEFAULT ''`: a card inserted without a title reads back as the empty
      // string, not null, which is what an `intake` card that is "nearly empty" (B4) needs. Every
      // other insert in both suites supplies a title, so nothing else would notice the default.
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );
      const untitled = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, "column", definition_version, revision)
                    VALUES (${untitled}, ${board}, 'intake', 1, 1)`,
      );
      const [row] = await Effect.runPromise(
        scratchSql<{
          title: string | null;
        }>`SELECT title FROM tasks WHERE id = ${untitled}`,
      );
      expect(row?.title).toBe("");
    },
  );

  /**
   * The four `>= 1` floors and `blocked_reason`'s four literals — the database's side of two things
   * `Task.ts` states, and the elements the previous pass of this suite left unwitnessed.
   *
   * `BlockReason` (`Task.ts:132-138`) is pinned tightly by `Task.test.ts`, but that pins the
   * *contract*: nothing tied `tasks.blocked_reason` to it, so the list could be narrowed, widened
   * or deleted in 0007 with every case green while the table and the contract silently drifted
   * apart. The same is true of the `>= 1` on `board_definitions.version`,
   * `board_instances.definition_version` and `tasks.definition_version`: the pin case above inserts
   * 99, which any `>= 1` accepts.
   *
   * Mutation: delete `CHECK (blocked_reason IN (...))` from 0007 — the first assertion goes.
   * Mutation: delete `CHECK (version >= 1)` from `board_definitions` — the second. From
   * `board_instances` — the third. From `tasks` — the fourth. Each names its own assertion, which
   * is why they are four separate refusals rather than one loop.
   */
  it(
    "refuses a version below 1 on all three tables and a block reason outside B4's four",
    { timeout: 30_000 },
    async () => {
      // A board of this case's own rather than one borrowed from the table: an insert whose
      // `board_id` subquery found nothing would be refused by the foreign key instead of the CHECK
      // under test, and a refusal for the wrong reason is what this suite exists to catch.
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );

      // B4's four, verbatim, in the order `Task.ts` declares them.
      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO tasks (id, board_id, "column", definition_version, revision, blocked_reason, blocked_column, blocked_since)
                        VALUES (${taskId()}, ${board}, 'building', 1, 1, 'sideways', 'building', now())`,
          ),
        ),
      ).toBe("tasks_blocked_reason_check");

      // A definition version below 1 on each of the three tables that carries one. Each insert
      // mints its own id, because on the failure path a row *is* left behind and a second run
      // against one database would then collide on the primary key instead of reaching the CHECK.
      const instance = boardId();
      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO board_definitions (id, version, name, columns)
                        VALUES ('below_one', 0, 'a version below one', '[]'::jsonb)`,
          ),
        ),
      ).toBe("board_definitions_version_check");

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                        VALUES (${instance}, 'factory/test', 'default', 0)`,
          ),
        ),
      ).toBe("board_instances_definition_version_check");

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO tasks (id, board_id, "column", definition_version, revision)
                        VALUES (${taskId()}, ${board}, 'building', 0, 1)`,
          ),
        ),
      ).toBe("tasks_definition_version_check");
    },
  );

  /**
   * `tasks_blocked_is_all_or_nothing` (B4: blocked is a card state, not a column), in both
   * directions and with the note outside the rule.
   *
   * The case above proves one direction — reason set, column null. This proves the other two the
   * constraint also claims: column set with no reason, and reason+column with no `blocked_since`.
   * And it proves the third clause the comment makes, that `blocked_note` is *outside* the rule: a
   * note alone on an unblocked card is accepted.
   *
   * Each refusal is asserted by constraint name, not only by SQLSTATE, because 23514 is every check
   * violation in the table and the name is what says which rule fired.
   *
   * Mutation: delete the whole `CONSTRAINT tasks_blocked_is_all_or_nothing CHECK (...)` block from
   * 0007 — all three refusals go and this reddens. Mutation: delete only the
   * `AND (blocked_reason IS NULL) = (blocked_since IS NULL)` line — the `blocked_since` case reddens.
   */
  it(
    "refuses a half-blocked card in every direction, and keeps blocked_note outside the rule",
    { timeout: 30_000 },
    async () => {
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );

      // The reverse of the direction the other suite proves: the column is named, the reason is not.
      const columnOnly = await refusedBy(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, blocked_column)
                    VALUES (${taskId()}, ${board}, 'x', 'building', 1, 1, 'building')`,
      );
      expect(constraint(columnOnly)).toBe("tasks_blocked_is_all_or_nothing");

      // Two of the three travel together, the third does not: the rule is all-or-nothing over
      // reason, column and timestamp, so a card blocked with no `blocked_since` is refused too.
      const noSince = await refusedBy(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, blocked_reason, blocked_column)
                    VALUES (${taskId()}, ${board}, 'x', 'building', 1, 1, 'needs_input', 'building')`,
      );
      expect(constraint(noSince)).toBe("tasks_blocked_is_all_or_nothing");

      // And the shape the rule admits: all three set, which is what B4's blocked card is.
      const whole = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, blocked_reason, blocked_column, blocked_since)
                    VALUES (${whole}, ${board}, 'x', 'building', 1, 1, 'needs_input', 'building', now())`,
      );

      // `blocked_note` sits outside the rule, which is what the migration's comment says: a note on
      // an unblocked card is accepted, so a note is metadata rather than part of a block.
      const noted = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, blocked_note)
                    VALUES (${noted}, ${board}, 'x', 'building', 1, 1, 'a note with no block')`,
      );

      // Read back by id rather than by position: both ids are minted from randomness, so `ORDER BY id`
      // would order them by a coin flip and the two assertions below would swap.
      const readBack = (id: string) =>
        Effect.runPromise(
          scratchSql<{
            blockedReason: string | null;
            blockedSince: Date | null;
            blockedNote: string | null;
          }>`
            SELECT blocked_reason, blocked_since, blocked_note FROM tasks WHERE id = ${id}
          `,
        );
      const [blocked] = await readBack(whole);
      const [withNote] = await readBack(noted);
      expect(blocked?.blockedReason).toBe("needs_input");
      expect(blocked?.blockedSince).toBeInstanceOf(Date);
      expect(withNote?.blockedReason).toBeNull();
      expect(withNote?.blockedNote).toBe("a note with no block");
    },
  );

  /**
   * `revision >= 1` on both tables and `priority IN ('urgent', 'normal')` on `tasks`.
   *
   * `revision` is B3's optimistic-concurrency token and starts at 1 (the migration's comment says
   * so), so a card at 0 is a card that was never created; `priority` is B9's two-valued flag. Both
   * are CHECKs in the file and neither has a case anywhere in this file.
   *
   * Mutation: drop `CHECK (revision >= 1)` from `tasks` — the first refusal goes. Mutation: drop it
   * from `task_events` — the second. Mutation: drop `CHECK (priority IN (...))` — the third.
   */
  it(
    "refuses a revision below 1 on a card and on an event, and a priority outside the two literals",
    { timeout: 30_000 },
    async () => {
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );
      const card = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                    VALUES (${card}, ${board}, 'x', 'building', 1, 1)`,
      );

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                        VALUES (${taskId()}, ${board}, 'x', 'building', 1, 0)`,
          ),
        ),
      ).toBe("tasks_revision_check");

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO task_events (task_id, kind, actor, revision, payload)
                        VALUES (${card}, 'moved', 'test', 0, '{}'::jsonb)`,
          ),
        ),
      ).toBe("task_events_revision_check");

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, priority)
                        VALUES (${taskId()}, ${board}, 'x', 'building', 1, 1, 'high')`,
          ),
        ),
      ).toBe("tasks_priority_check");

      // The two literals B9 names are accepted, so the check is not refusing everything.
      for (const priority of ["urgent", "normal"]) {
        await Effect.runPromise(
          scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, priority)
                      VALUES (${taskId()}, ${board}, 'x', 'building', 1, 1, ${priority})`,
        );
      }
    },
  );

  /**
   * The three refusals 0007's foreign keys and unique constraint are there to make.
   *
   * - `tasks.board_id` must name a board, or a card is on no board at all (B1: a task belongs to a
   *   board instance).
   * - `task_runs.session_id` is UNIQUE because B1 says a run *is* one Pi Durable session: two runs
   *   sharing a session would make "the run's log is the truth" ambiguous.
   * - `board_instances (definition_id, definition_version)` must name a definition that exists,
   *   which is B2's "references a definition version".
   *
   * The last of the three is already proven against the configured database by the case above; it is
   * repeated here because that proof does not witness this file (A9: deleting the FOREIGN KEY from
   * 0007 leaves the whole file green).
   *
   * Mutation: delete `UNIQUE` from `task_runs.session_id` — the second refusal goes. Mutation:
   * delete `REFERENCES board_instances (id)` — the first. Mutation: delete the composite
   * `FOREIGN KEY` from `board_instances` — the third.
   */
  it(
    "refuses a card on no board, two runs on one session, and an instance on no definition",
    { timeout: 30_000 },
    async () => {
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );
      const card = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                    VALUES (${card}, ${board}, 'x', 'building', 1, 1)`,
      );

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                        VALUES (${taskId()}, 'brd_absent_board', 'x', 'building', 1, 1)`,
          ),
        ),
      ).toBe("tasks_board_id_fkey");

      const session = sessionId();
      await Effect.runPromise(
        scratchSql`INSERT INTO task_runs (id, task_id, session_id, "column")
                    VALUES (${runRowId()}, ${card}, ${session}, 'building')`,
      );
      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO task_runs (id, task_id, session_id, "column")
                        VALUES (${runRowId()}, ${card}, ${session}, 'building')`,
          ),
        ),
      ).toBe("task_runs_session_id_key");

      expect(
        constraint(
          await refusedBy(
            scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                        VALUES (${boardId()}, 'factory/test', 'default', 99)`,
          ),
        ),
      ).toBe("board_instances_definition_id_definition_version_fkey");

      // 23503 and 23505 rather than the names alone, so the *kind* of refusal is pinned too: the
      // names are what a rename would change, the codes are what a reader depends on.
      expect(
        sqlstate(
          await refusedBy(
            scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                        VALUES (${boardId()}, 'factory/test', 'default', 99)`,
          ),
        ),
      ).toBe("23503");
    },
  );

  /**
   * The `ON DELETE CASCADE` chain, in the direction that loses data.
   *
   * Deleting a board instance takes its cards with it, and a card's history and runs go with the
   * card — so one `DELETE` empties three tables. That is a deliberate reading of B3 ("a card is
   * *input*: a person typed it") made concrete, and it is worth a case because it is the opposite
   * of what `commits` does and the two rules are stated in the same breath.
   *
   * What this cannot prove: that cascading is *wanted*. Deleting a board destroys its audit trail,
   * and no case here can settle whether the product wants that. It is written down, not decided.
   *
   * Mutation: delete `ON DELETE CASCADE` from `tasks.board_id` — the first count is 1, this reddens.
   */
  it(
    "takes a card, its history and its runs with the board instance",
    { timeout: 30_000 },
    async () => {
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );
      const card = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                    VALUES (${card}, ${board}, 'x', 'building', 1, 1)`,
      );
      await Effect.runPromise(
        scratchSql`INSERT INTO task_events (task_id, kind, actor, revision, payload)
                    VALUES (${card}, 'moved', 'test', 1, '{}'::jsonb)`,
      );
      await Effect.runPromise(
        scratchSql`INSERT INTO task_runs (id, task_id, session_id, "column")
                    VALUES (${runRowId()}, ${card}, ${sessionId()}, 'building')`,
      );

      await Effect.runPromise(
        scratchSql`DELETE FROM board_instances WHERE id = ${board}`,
      );

      const [counts] = await Effect.runPromise(
        scratchSql<{ tasks: number; events: number; runs: number }>`
          SELECT
            (SELECT count(*)::int FROM tasks WHERE id = ${card}) AS tasks,
            (SELECT count(*)::int FROM task_events WHERE task_id = ${card}) AS events,
            (SELECT count(*)::int FROM task_runs WHERE task_id = ${card}) AS runs
        `,
      );
      expect(counts?.tasks).toBe(0);
      expect(counts?.events).toBe(0);
      expect(counts?.runs).toBe(0);
    },
  );

  /**
   * `task_events` is **not** append-only in the database, and this is the case that says so.
   *
   * `Task.ts:186` says events are "never updated or deleted — the same rule `commits` enforces with
   * a trigger", and 0007:93 says "Append-only, like `commits`". Measured against a database this
   * migration created (`.verify/evidence/lob58-verifier/probe-enforcement.log`, §1): an `UPDATE` and
   * a `DELETE` on `task_events` both *succeed*, while the same two statements on `commits` are both
   * refused by `commits_append_only` (§2). `pg_trigger` holds exactly one user trigger in this
   * database and it is on `commits`.
   *
   * So the rule is a convention the future writer upholds, not something the database enforces, and
   * the two comments claim the stronger thing. Asserting the real behaviour here is what keeps the
   * comments honest: if a trigger is added later this case reddens, which is the moment the comments
   * become true rather than the moment they are quietly still wrong.
   *
   * Note the interaction with the cascade case above, which is why this is reported and not fixed
   * here: a `commits`-style `BEFORE DELETE` trigger on `task_events` would reject the cascade's own
   * `DELETE`, so deleting a board instance would fail (measured,
   * `.verify/evidence/lob58-verifier/probe-cascade-trigger-vs-cascade.log`). Adding the trigger and
   * keeping the cascade cannot both hold without a decision about which one gives.
   */
  it(
    "lets an event be rewritten and deleted, where commits refuses both",
    { timeout: 30_000 },
    async () => {
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );
      const card = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                    VALUES (${card}, ${board}, 'x', 'building', 1, 1)`,
      );
      await Effect.runPromise(
        scratchSql`INSERT INTO task_events (task_id, kind, actor, revision, payload)
                    VALUES (${card}, 'moved', 'test', 1, '{}'::jsonb)`,
      );

      // Both succeed. If either is ever refused, this case reddens and the comments can be fixed.
      await Effect.runPromise(
        scratchSql`UPDATE task_events SET actor = 'rewritten' WHERE task_id = ${card}`,
      );
      await Effect.runPromise(
        scratchSql`DELETE FROM task_events WHERE task_id = ${card}`,
      );
      const [left] = await Effect.runPromise(
        scratchSql<{ count: number }>`
          SELECT count(*)::int AS count FROM task_events WHERE task_id = ${card}
        `,
      );
      expect(left?.count).toBe(0);

      // The contrast the comments draw: on `commits` both are refused, by a trigger. That table is
      // `0002`'s, not 0007's, so it does not exist in this suite's scratch database — the contrast is
      // read against the configured one, where the whole migration history has run.
      const logId = nextLogId();
      await Effect.runPromise(
        sql`INSERT INTO commits (log_id, seq, writes) VALUES (${logId}, 1, '{}'::json)`,
      );
      expect(
        await refusedBy(
          sql`UPDATE commits SET seq = 2 WHERE log_id = ${logId}`,
        ),
      ).toBeDefined();
      expect(
        await refusedBy(sql`DELETE FROM commits WHERE log_id = ${logId}`),
      ).toBeDefined();
    },
  );

  /**
   * The database does not check the `columns` JSONB, so the migration header's "schema-valid by
   * construction" is a claim about the seed path alone.
   *
   * A column set `BoardColumn` flatly rejects — `kind: "sideways"`, a requirement key of
   * `"Not A Key"` — is written here with plain SQL and read back unchallenged. That is the honest
   * boundary of the claim: the encoder runs before the migration's own `INSERT`, so *that* value is
   * schema-valid; any other writer's value is whatever it put in the column.
   *
   * This is a case about the limit of an existing claim, not a demand for a change: adding a CHECK
   * over a JSONB array is the migration author's call, and B4's columns are data, not DDL.
   */
  it(
    "stores a column set the contract rejects, because the JSONB column is not checked",
    { timeout: 30_000 },
    async () => {
      await Effect.runPromise(
        scratchSql`INSERT INTO board_definitions (id, version, name, columns)
                    VALUES ('adversarial', 1, 'a column set BoardColumn refuses',
                            '[{"name":"x","kind":"sideways","skills":[],"requires":[{"key":"Not A Key","description":""}]}]'::jsonb)`,
      );
      const [stored] = await Effect.runPromise(
        scratchSql<{ columns: unknown }>`
          SELECT columns FROM board_definitions WHERE id = 'adversarial'
        `,
      );
      expect(stored?.columns).toEqual([
        {
          name: "x",
          kind: "sideways",
          skills: [],
          requires: [{ key: "Not A Key", description: "" }],
        },
      ]);
      // And the contract does refuse it, which is what makes the gap a gap rather than a rule.
      expect(() =>
        Schema.decodeUnknownSync(BoardDefinition)({
          id: "adversarial",
          version: 1,
          name: "a column set BoardColumn refuses",
          columns: stored?.columns,
        }),
      ).toThrow();
    },
  );

  /**
   * A card may pin a definition version its board is not on, and a column the definition does not
   * declare. Both are accepted, and both are claims the contract's comments make that the database
   * does not back.
   *
   * `Task.definitionVersion`'s comment says it is "the definition version this task started under
   * (B2)", and `Task.column`'s says it is "a *name*, not a position" under that version — but
   * `tasks.definition_version` has a `CHECK (>= 1)` and no foreign key, and `"column"` is
   * unconstrained `TEXT`. Measured (`.verify/evidence/lob58-verifier/probe-enforcement.log`, §11): a
   * card on a version-1 board pinning version 99 is accepted.
   *
   * Written as a case rather than left as prose because a reader of `docs/board.md` would otherwise
   * assume the pin is enforced. Whether the pin *should* be is a product question for the issue that
   * writes cards (LOB-59), not for this one; what is here is the fact.
   */
  it(
    "accepts a card pinning a version its board is not on, in a column the definition lacks",
    { timeout: 30_000 },
    async () => {
      const board = boardId();
      await Effect.runPromise(
        scratchSql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
                    VALUES (${board}, 'factory/test', 'default', 1)`,
      );
      const card = taskId();
      await Effect.runPromise(
        scratchSql`INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
                    VALUES (${card}, ${board}, 'x', 'no_such_column', 99, 1)`,
      );
      const [row] = await Effect.runPromise(
        scratchSql<{ column: string; definitionVersion: number }>`
          SELECT "column", definition_version FROM tasks WHERE id = ${card}
        `,
      );
      expect(row?.column).toBe("no_such_column");
      expect(row?.definitionVersion).toBe(99);
    },
  );
});

/**
 * The migrations directory as the migrator reads it: one file per id, ids running 1..N.
 *
 * `PgMigrator.fromFileSystem` keys each file by its leading number. Two files with one id make the
 * migrator fail at startup ("Found duplicate migration id's"), and `MigratedLive` is `Layer.orDie`,
 * so every `DatabaseLive` consumer dies. A gap is quieter and worse: the migrator skips every id at
 * or below the latest one a database recorded, so a lower-numbered file that lands after a higher
 * one never runs on any database already migrated past it. Both happen when two branches pick the
 * same next number and git merges the two files without a conflict (LOB-186 and LOB-201 both took
 * 0021); this names the collision before the migrator does.
 */
describe("the migrations directory", () => {
  it(
    "holds one file per id, numbered 1..N with no gap",
    { timeout: 30_000 },
    () => {
      const ids = readdirSync(new URL("./migrations", import.meta.url))
        .map((file) => /^(\d+)_[^.]+\.(?:js|ts)$/.exec(file))
        .flatMap((match) => (match === null ? [] : [Number(match[1])]))
        .sort((left, right) => left - right);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual(
        Array.from({ length: ids.length }, (_, at) => at + 1),
      );
    },
  );
});
