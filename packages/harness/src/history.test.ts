/**
 * A historical read costs what it shows (LOB-243, design R6).
 *
 * Every case counts what the read touched — entries a storage scan handed back, through a counting
 * `Storage` — rather than timing it, and compares what it answered with the full fold of the same
 * log (`readSessionLog`): the claim is that the bound changed the cost and not the answer. Needs the
 * Postgres the rest of the package's suites use.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineEntry,
  Harness as HarnessRuntime,
  createRegistry,
  type Storage,
} from "@earendil-works/pi-durable";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelAccess } from "./models";
import {
  ApprovalRequestedEntry,
  closeHarness,
  forkSession,
  HISTORY_WINDOW,
  openSession,
  readHistoricalSnapshot,
  readSessionLog,
  readTranscriptPage,
  writeApprovalDecided,
  writeApprovalRequested,
  type SessionRef,
} from "./session";
import type { Conversation } from "@earendil-works/pi-durable";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");
const workdir = mkdtempSync(join(tmpdir(), "factory-history-"));
const prefix = `harness-history-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
let logs = 0;
const nextLogId = () => `${prefix}-${(logs += 1)}`;

const ref: SessionRef = {
  id: SessionIdSchema.make(`ses_${"2".repeat(26)}`),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path: workdir, commands: {}, commandsSource: "none" },
};

let sql: SqlClient;

beforeAll(async () => {
  try {
    sql = await runtime.runPromise(SqlClient);
  } catch (cause) {
    throw new Error(
      "Postgres is unreachable. Start it with `docker compose up -d --wait postgres`. " +
        String(cause),
      { cause },
    );
  }
}, 60_000);

afterAll(async () => {
  await runtime.dispose();
});

const owner = (logId: string) =>
  PostgresStorage.open(sql, { logId, mode: "owner" }, context);
const reader = (logId: string) =>
  PostgresStorage.open(sql, { logId, mode: "reader" }, context);

/** A note the transcript projects as `other`: an entry with no model content, cheap to write. */
const Note = defineEntry<{ readonly text: string }>("test.note");

/** Append `count` notes to `root`, `perCommit` to a commit. */
const writeNotes = (root: Conversation, count: number, perCommit = 50) =>
  Effect.promise(async () => {
    for (let at = 0; at < count; at += perCommit) {
      await root.commit(async (tx) => {
        for (let n = at; n < Math.min(count, at + perCommit); n += 1)
          await tx.appendEntry(Note, root.id, { data: { text: `note ${n}` } });
      }, context);
    }
  });

/**
 * `storage`, counting the entries its scans hand back and its single-entry reads — every way a
 * reader of the transcript touches an entry. Everything else is forwarded untouched.
 */
const counting = (storage: Storage) => {
  const touched = { entries: 0 };
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "scanEntries")
        return (...args: Parameters<Storage["scanEntries"]>) =>
          target.scanEntries(...args).then((page) => {
            touched.entries += page.items.length;
            return page;
          });
      if (property === "entry")
        return (...args: unknown[]) =>
          Reflect.apply(value, target, args).then((found: unknown) => {
            if (found !== undefined) touched.entries += 1;
            return found;
          });
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  });
  return { storage: proxy, touched };
};

/** Write a session of a request, `notes` notes, and a reply; return its log id. */
const seedSession = (notes: number) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const logId = nextLogId();
      const storage = yield* Effect.promise(() => owner(logId));
      const { harness, root } = yield* openSession({
        storage,
        model,
        cwd: workdir,
      });
      // Pending from the very start of the log: far outside any window a read serves.
      yield* writeApprovalRequested(root, {
        requestId: "apr-old",
        action: "push refs/heads/main",
        detail: "asked first, never answered",
        requestedAt: "2026-01-01T00:00:01.000Z",
      });
      yield* writeApprovalRequested(root, {
        requestId: "apr-settled",
        action: "tag v1",
        detail: "",
        requestedAt: "2026-01-01T00:00:02.000Z",
      });
      yield* writeApprovalDecided(root, {
        requestId: "apr-settled",
        decision: "approved",
        actor: "lukas@laptop",
        decidedAt: "2026-01-01T00:00:03.000Z",
      });
      yield* writeNotes(root, notes);
      yield* closeHarness(harness);
      yield* Effect.promise(() => storage.dispose());
      return logId;
    }),
  );

/** One historical read of `logId` through a fresh reader, with what it touched. */
const historicalRead = (logId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const opened = yield* Effect.promise(() => reader(logId));
      const { storage, touched } = counting(opened);
      const snapshot = yield* readHistoricalSnapshot(storage, ref);
      const commitsRead = opened.opened.commitsRead;
      yield* Effect.promise(() => opened.dispose());
      return { snapshot, touched: touched.entries, commitsRead };
    }),
  );

const fullFold = (logId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const opened = yield* Effect.promise(() => reader(logId));
      const log = yield* readSessionLog(opened);
      yield* Effect.promise(() => opened.dispose());
      return log;
    }),
  );

describe("a historical read of a long session", () => {
  it("serves the newest window, and touches as many entries at 5x the length", async () => {
    const short = await seedSession(HISTORY_WINDOW * 2);
    const long = await seedSession(HISTORY_WINDOW * 10);

    const reads = [await historicalRead(short), await historicalRead(long)];
    for (const [read, logId] of [
      [reads[0], short],
      [reads[1], long],
    ] as const) {
      if (read === undefined) throw new Error("no read");
      const log = await fullFold(logId);
      // The newest window of the same transcript the full fold projects, and where it starts.
      expect(read.snapshot.entries).toEqual(log.entries.slice(-HISTORY_WINDOW));
      expect(read.snapshot.earlier).toBe(read.snapshot.entries[0]?.id);
      // The pending approval was asked before every entry the window holds; it is still reported,
      // exactly as the full fold reports it.
      expect(read.snapshot.approvals).toEqual([
        {
          sessionId: ref.id,
          requestId: "apr-old",
          action: "push refs/heads/main",
          detail: "asked first, never answered",
          requestedAt: "2026-01-01T00:00:01.000Z",
        },
      ]);
      expect(
        log.approvals.filter((record) => record.decision === undefined),
      ).toHaveLength(1);
      // The whole cost in entries: the window, and not one more — no transcript walk for the
      // approvals, none for anything else.
      expect(read.touched).toBe(HISTORY_WINDOW);
    }
    expect(reads[1]?.touched).toBe(reads[0]?.touched);
  }, 120_000);

  it("pages back to the first entry on request, and the pages are the transcript", async () => {
    const logId = await seedSession(HISTORY_WINDOW + 130);
    const log = await fullFold(logId);
    const pages = await runtime.runPromise(
      Effect.gen(function* () {
        const opened = yield* Effect.promise(() => reader(logId));
        const { storage, touched } = counting(opened);
        const snapshot = yield* readHistoricalSnapshot(storage, ref);
        const collected = [...snapshot.entries];
        const sizes: number[] = [];
        let before = snapshot.earlier;
        while (before !== undefined) {
          const counted = touched.entries;
          const page = yield* readTranscriptPage(storage, {
            before,
            limit: 100,
          });
          sizes.push(touched.entries - counted);
          collected.unshift(...page.entries);
          before = page.earlier;
        }
        const refused = yield* readTranscriptPage(storage, {
          before: "not-an-id",
        }).pipe(Effect.flip);
        yield* Effect.promise(() => opened.dispose());
        return { collected, sizes, refused };
      }),
    );
    expect(pages.collected).toEqual(log.entries);
    // Each page touched its own length, so paging back is as bounded as the first read.
    expect(pages.sizes.every((size) => size <= 100)).toBe(true);
    expect(pages.sizes.reduce((sum, size) => sum + size, 0)).toBe(
      log.entries.length - HISTORY_WINDOW,
    );
    expect(pages.refused.code).toBe("invalid_input");
  }, 120_000);

  it("carries the whole transcript and no `earlier` when it fits the window", async () => {
    const logId = await seedSession(3);
    const read = await historicalRead(logId);
    const log = await fullFold(logId);
    expect(read.snapshot.entries).toEqual(log.entries);
    expect(read.snapshot.earlier).toBeUndefined();
  }, 120_000);
});

describe("the approval ledger", () => {
  it("is seeded from a log written before it existed, the first time the log is opened", async () => {
    const logId = nextLogId();
    // A log as the control plane wrote it before LOB-243: an approval entry and no ledger, written
    // through a harness that never ran `openSession`.
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => owner(logId));
        const harness = yield* Effect.promise(() =>
          HarnessRuntime.open(
            storage,
            { models: model.models, registry: createRegistry() },
            context,
          ),
        );
        const root = yield* Effect.promise(() => harness.root(context));
        yield* Effect.promise(() =>
          root.commit(
            (tx) =>
              tx.appendEntry(ApprovalRequestedEntry, root.id, {
                data: {
                  requestId: "apr-legacy",
                  action: "push refs/heads/main",
                  detail: "",
                  requestedAt: "2026-01-01T00:00:01.000Z",
                },
              }),
            context,
          ),
        );
        yield* writeNotes(root, HISTORY_WINDOW + 10);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
      }),
    );
    const pending = [
      {
        sessionId: ref.id,
        requestId: "apr-legacy",
        action: "push refs/heads/main",
        detail: "",
        requestedAt: "2026-01-01T00:00:01.000Z",
      },
    ];

    // No ledger: the read cannot trust one, so it folds the transcript for the approvals — the
    // answer the full fold gives, at the full fold's cost.
    const legacy = await historicalRead(logId);
    const log = await fullFold(logId);
    expect(legacy.snapshot.approvals).toEqual(pending);
    expect(legacy.touched).toBe(HISTORY_WINDOW + log.entries.length);

    // One open seeds the ledger with the entry already in the log; from then on the read is bounded.
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => owner(logId));
        const { harness } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
      }),
    );
    const seeded = await historicalRead(logId);
    expect(seeded.snapshot.approvals).toEqual(pending);
    expect(seeded.touched).toBe(HISTORY_WINDOW);
  }, 120_000);

  it("carries a parent's approvals into a fork, as the fork's transcript does", async () => {
    const parentLog = await seedSession(5);
    const childLog = nextLogId();
    await runtime.runPromise(
      Effect.gen(function* () {
        const child = yield* Effect.promise(() => owner(childLog));
        const opened = yield* forkSession({
          parent: yield* Effect.promise(() => reader(parentLog)),
          child,
          lineage: parentLog,
          model,
          cwd: workdir,
        });
        yield* closeHarness(opened.harness);
        yield* Effect.promise(() => child.dispose());
      }),
    );
    const log = await fullFold(childLog);
    const read = await historicalRead(childLog);
    // The copied request is pending in the fork's transcript, and the ledger says so too — without
    // the transcript walk a missing copy would have forced.
    expect(read.snapshot.approvals.map((request) => request.requestId)).toEqual(
      log.approvals
        .filter((record) => record.decision === undefined)
        .map((record) => record.requestId),
    );
    expect(read.snapshot.approvals.map((request) => request.requestId)).toEqual(
      ["apr-old"],
    );
    expect(read.touched).toBe(log.entries.length);
  }, 120_000);
});
