/**
 * What a historical read of a long session costs, bounded and as it was (LOB-243, design R6).
 *
 *   DATABASE_URL=… bun run packages/harness/scripts/bench-historical-read.ts [sizes] [runs]
 *
 * The shape of LOB-186's `bench-open.ts`, one layer up. For each size in `sizes` (comma-separated
 * entry counts, default `2500,10250`) it seeds one session log through `openSession` — a pending
 * approval first, then that many ~800-character notes, one entry per commit, so the owner
 * checkpoints at the default interval — and then reads it `runs` times (default 7) two ways, each
 * through a fresh reader-mode `PostgresStorage`:
 *
 * - `bounded`: `readHistoricalSnapshot`, what `SessionService.get` serves for a session nobody owns.
 * - `fullFold`: `readSessionLog`, the read the historical snapshot made before LOB-243 — every
 *   entry of the restored fold, paged and projected.
 *
 * Each read is counted as well as timed, and its time split into the storage open (`openMedianMs`:
 * the checkpoint restored and the tail folded) and the read over it (`projectMedianMs`):
 * `commitsRead` is the storage open's own report (the commits
 * after the checkpoint it folded), and `entriesTouched` the entries the read's storage scans handed
 * back, through a counting `Storage`. The claim being measured is that `entriesTouched` for the
 * bounded read does not move with the log's length. `readersMs` is the board's run evidence path
 * (`PostgresStorage.readers`) on the same log, from its checkpoint and from the first commit.
 *
 * Prints JSON, one object per size. The logs are left in place under unique ids; nothing else is
 * touched.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineEntry, type Storage } from "@earendil-works/pi-durable";
import { SessionId, type SessionError } from "@repo/domain/Session";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { BunRuntime } from "@effect/platform-bun";
import { Clock, Console, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { createModelAccess } from "../src/models";
import {
  closeHarness,
  HISTORY_WINDOW,
  openSession,
  readHistoricalSnapshot,
  readSessionLog,
  writeApprovalRequested,
  type SessionRef,
} from "../src/session";

const sizes = (process.argv[2] ?? "2500,10250").split(",").map(Number);
const runs = Number(process.argv[3] ?? 7);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");
// No turn runs, so nothing executes in it: the working directory is only the session's workspace path.
const cwd = process.cwd();

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const round = (ms: number) => Math.round(ms * 10) / 10;

/** Milliseconds `effect` took, beside its value. */
const time = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const value = yield* effect;
    const end = yield* Clock.currentTimeNanos;
    return { ms: Number(end - start) / 1e6, value };
  });

const summary = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? Number.NaN),
    minMs: round(sorted[0] ?? Number.NaN),
    maxMs: round(sorted.at(-1) ?? Number.NaN),
  };
};

/** ~800 characters of deterministic pseudo-prose, as `bench-open.ts` writes. */
let random = 0x2545f491;
const nextRandom = () => {
  random = (Math.imul(random, 1_103_515_245) + 12_345) >>> 0;
  return random;
};
const vocabulary = Array.from({ length: 512 }, () =>
  Array.from({ length: 3 + (nextRandom() % 7) }, () =>
    String.fromCharCode(97 + (nextRandom() % 26)),
  ).join(""),
);
const text = (at: number) => {
  const words = [`message ${at}:`];
  let length = words[0]?.length ?? 0;
  while (length < 800) {
    const word =
      words.length % 8 === 0
        ? nextRandom().toString(16).padStart(8, "0")
        : (vocabulary[nextRandom() % vocabulary.length] ?? "");
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ").slice(0, 800);
};

const Note = defineEntry<{ readonly text: string }>("bench.note");

/** `storage`, counting the entries its scans hand back and its single-entry reads. */
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

const program = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const results: unknown[] = [];
  for (const size of sizes) {
    const logId = `bench-history-${process.pid}-${yield* Clock.currentTimeMillis}-${size}`;
    const ref: SessionRef = {
      id: SessionId.make(`ses_${"0".repeat(26)}`),
      title: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspace: { path: cwd, commands: {}, commandsSource: "none" },
    };

    const seeded = yield* time(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          PostgresStorage.owner(sql, logId),
        );
        const { harness, root } = yield* openSession({ storage, model, cwd });
        yield* writeApprovalRequested(root, {
          requestId: "apr-bench",
          action: "push refs/heads/main",
          detail: "asked before every entry the window holds",
          requestedAt: "2026-01-01T00:00:00.000Z",
        });
        for (let at = 0; at < size; at += 1) {
          yield* Effect.promise(() =>
            root.commit(
              (tx) =>
                tx.appendEntry(Note, root.id, { data: { text: text(at) } }),
              context,
            ),
          );
        }
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.checkpointsWritten());
        yield* Effect.promise(() => storage.dispose());
      }),
    );
    const checkpoint = yield* sql<{ seq: number; bytes: number }>`
      SELECT seq::int AS seq, octet_length(fold)::int AS bytes
      FROM log_checkpoints WHERE log_id = ${logId}
    `;
    const commits = yield* sql<{ count: number }>`
      SELECT count(*)::int AS count FROM commits WHERE log_id = ${logId}
    `;

    /** One read through a fresh reader: its time, what the open folded, what it touched. */
    const read = (
      through: (
        storage: Storage,
      ) => Effect.Effect<{ readonly entries: number }, SessionError>,
    ) =>
      Effect.gen(function* () {
        const open = yield* time(
          Effect.promise(() => PostgresStorage.reader(sql, logId)),
        );
        const opened = open.value;
        const { storage, touched } = counting(opened);
        const projected = yield* time(through(storage));
        const report = opened.opened;
        yield* Effect.promise(() => opened.dispose());
        return {
          ms: open.ms + projected.ms,
          openMs: open.ms,
          projectMs: projected.ms,
          commitsRead: report.commitsRead,
          checkpoint: report.checkpoint,
          entriesTouched: touched.entries,
          entriesShown: projected.value.entries,
        };
      });

    const measure = (
      through: (
        storage: Storage,
      ) => Effect.Effect<{ readonly entries: number }, SessionError>,
    ) =>
      Effect.gen(function* () {
        // Warm the pool and the plan cache once, so no sample pays for them.
        yield* read(through);
        const samples: number[] = [];
        const opens: number[] = [];
        const projections: number[] = [];
        let last:
          | Omit<
              Effect.Success<ReturnType<typeof read>>,
              "ms" | "openMs" | "projectMs"
            >
          | undefined;
        for (let run = 0; run < runs; run += 1) {
          const { ms, openMs, projectMs, ...rest } = yield* read(through);
          samples.push(ms);
          opens.push(openMs);
          projections.push(projectMs);
          last = rest;
        }
        return {
          ...summary(samples),
          openMedianMs: summary(opens).medianMs,
          projectMedianMs: summary(projections).medianMs,
          runs,
          ...last,
        };
      });

    const bounded = yield* measure((storage) =>
      Effect.map(readHistoricalSnapshot(storage, ref), (snapshot) => ({
        entries: snapshot.entries.length,
      })),
    );
    const fullFold = yield* measure((storage) =>
      Effect.map(readSessionLog(storage), (log) => ({
        entries: log.entries.length,
      })),
    );
    const readers = (checkpoints: boolean) =>
      Effect.gen(function* () {
        const samples: number[] = [];
        for (let run = 0; run <= runs; run += 1) {
          const { ms } = yield* time(
            Effect.promise(() =>
              PostgresStorage.readers(sql, [logId], { checkpoints }),
            ),
          );
          // The first is the warm-up.
          if (run > 0) samples.push(ms);
        }
        return summary(samples);
      });

    results.push({
      logId,
      entries: size,
      commits: commits[0]?.count,
      historyWindow: HISTORY_WINDOW,
      seedMs: Math.round(seeded.ms),
      checkpoint: checkpoint[0],
      read: { bounded, fullFold },
      speedup: round(fullFold.medianMs / bounded.medianMs),
      readersMs: {
        fromCheckpoint: yield* readers(true),
        fromStart: yield* readers(false),
      },
    });
  }
  yield* Console.log(encodeJson(results));
}).pipe(Effect.provide(DatabaseLive));

BunRuntime.runMain(program);
