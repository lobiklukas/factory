import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type Cursor,
  type EntryId,
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import {
  createExpectAssertions,
  createStorageConformance,
  registerStorageConformance,
} from "@earendil-works/pi-durable/testing";
import { Clock, Effect, ManagedRuntime, Random, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "./index";
import { PostgresStorage, READER_PAGE_ROWS } from "./PostgresStorage";
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

beforeAll(async () => {
  try {
    sql = await runtime.runPromise(SqlClient);
  } catch (cause) {
    throw new Error(
      "Postgres is unreachable. Start it with `docker compose up -d --wait postgres` " +
        `(DATABASE_URL defaults to postgres://factory:factory@localhost:5442/factory). ${String(cause)}`,
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
 * `PostgresStorage.readers` (LOB-115): many logs in pages, where `reader` is one log at a time.
 *
 * Every case below compares against the single-log path rather than against a fixed expectation,
 * because the claim being made is that batching changed the cost and not the answer — a hand-written
 * expected transcript would only say the two implementations agree with each other's bug.
 */
describe("PostgresStorage.readers", () => {
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
   * Paged and reversed the way `readActiveEntries` pages and reverses (`ENTRY_PAGE` in
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

      const batched = await PostgresStorage.readers(sql, [
        a.logId,
        b.logId,
        c.logId,
      ]);
      expect([...batched.keys()].sort()).toEqual(
        [a.logId, b.logId, c.logId].sort(),
      );

      for (const { logId, ids } of [a, b, c]) {
        const reader = await PostgresStorage.reader(sql, logId);
        expect(await folded(batched.get(logId))).toEqual(await folded(reader));
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

      const batched = await PostgresStorage.readers(sql, [
        present.logId,
        absent,
      ]);
      expect(batched.has(absent)).toBe(true);

      // The comparison is the whole claim: a log with no commits has no conversation in it, so
      // `MemoryStorage` refuses to scan it — and it refuses the same way through both paths. What
      // would be new here is the *missing key*, which is what a `continue` in the caller would read.
      const reader = await PostgresStorage.reader(sql, absent);
      expect(await folded(batched.get(absent))).toEqual(await folded(reader));
      expect(
        await batched.get(absent)!.conversation(ROOT_CONVERSATION_ID, context),
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

      const batched = await PostgresStorage.readers(sql, [fat.logId]);
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
      const batched = await PostgresStorage.readers(sql, [
        fat.logId,
        thin.logId,
      ]);
      for (const { logId, ids } of [fat, thin]) {
        const reader = await PostgresStorage.reader(sql, logId);
        expect(await folded(batched.get(logId))).toEqual(await folded(reader));
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
      expect([...(await PostgresStorage.readers(sql, []))]).toEqual([]);
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
        PostgresStorage.readers(sql, [good.logId, broken]),
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
      await expect(PostgresStorage.readers(sql, [broken])).rejects.toThrow(
        `of log ${broken} is not a write array`,
      );
    },
  );
});

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
    "leaves one definition row when the migration runs a second time",
    { timeout: 30_000 },
    async () => {
      const migration = (await import("./migrations/0007_create_tasks"))
        .default;
      // Run directly, not through `MigratedLive`: the migrator records what it has applied, so a
      // second trip through the layer would skip 0007 and prove nothing about the seed.
      await Effect.runPromise(
        migration.pipe(Effect.provideService(SqlClient, sql)),
      );

      const rows = await Effect.runPromise(
        sql<{ id: string; version: number }>`
          SELECT id, version FROM board_definitions
        `,
      );
      expect(rows).toEqual([{ id: "default", version: 1 }]);
    },
  );

  it(
    "refuses a card that is blocked without the column it blocked from",
    { timeout: 30_000 },
    async () => {
      const [instance] = await Effect.runPromise(
        sql<{
          id: string;
        }>`SELECT id FROM board_instances LIMIT 1`,
      );
      // No instance exists until something creates one, so this case makes its own rather than
      // depending on a writer that does not exist yet.
      const boardId = instance?.id ?? "brd_test_board_instance";
      if (instance === undefined) {
        await Effect.runPromise(
          sql`INSERT INTO board_instances (id, repo, definition_id, definition_version)
              VALUES (${boardId}, 'factory/test', 'default', 1)`,
        );
      }

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
});
