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
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import {
  Clock,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseConfig, DatabaseLive } from "./index";
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
/** A `task_runs.id`, unique per call so two rows on one card never collide on the primary key. */
let runCounter = 0;
const nextRunId = () => `run-${runId}-${runCounter++}`;

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
   * between the two leaks its database — empty, seconds old, and swept by nothing here;
   * `packages/core/src/SessionService.test.ts` carries the sweep and the argument for one.
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
   * The three indexes the migration creates, by name — B9's ordering clause (`board_id, priority,
   * created_at`) is the one a reader of a lane would use, and it is named here because dropping it
   * is invisible everywhere else (A5).
   *
   * Asserted as *containment* rather than equality: Postgres names the primary keys and the unique
   * constraint too, and a case that listed all of them would be asserting the key declarations as
   * well as the three `CREATE INDEX` lines, which the other cases already cover.
   *
   * Mutation: delete the `tasks_by_board` line from 0007 — the first assertion goes.
   */
  it(
    "indexes the three reads a board makes, by name",
    { timeout: 30_000 },
    async () => {
      const names = await indexNames();
      expect(names).toContain("tasks_by_board");
      expect(names).toContain("task_events_by_task");
      expect(names).toContain("task_runs_by_task");
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
