import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type EntryId,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import {
  createExpectAssertions,
  createStorageConformance,
  registerStorageConformance,
} from "@earendil-works/pi-durable/testing";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "./index";
import { PostgresStorage } from "./PostgresStorage";

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
  it("is identical for both backends", () => {
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

  it("folds the log on reopen and continues sequence and ids", async () => {
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
  });

  it("round-trips U+0000 and lone surrogates through the log", async () => {
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
  });

  it("keeps logs isolated by log id", async () => {
    const a = await PostgresStorage.open(sql, { logId: nextLogId() }, context);
    const b = await PostgresStorage.open(sql, { logId: nextLogId() }, context);
    await a.commit([root], context);
    expect(await b.conversation(ROOT_CONVERSATION_ID, context)).toBeUndefined();
    await a.close(context);
    await b.close(context);
  });

  it("reader sees commits appended after it opened, and cannot write", async () => {
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
  });

  it("fences a second owner: its append collides and poisons it", async () => {
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
  });

  it("does not poison on a rejected commit and writes nothing for it", async () => {
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
  });

  it("is append-only in the database", async () => {
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
