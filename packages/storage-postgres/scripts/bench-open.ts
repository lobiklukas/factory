/**
 * What opening a long log costs, with and without its checkpoint (LOB-186).
 *
 *   DATABASE_URL=… bun run packages/storage-postgres/scripts/bench-open.ts [commits] [runs]
 *
 * Seeds one log of `commits` commits (default 10 250) through an owner that checkpoints at the
 * default interval, then opens it as a reader `runs` times (default 7) from its checkpoint, deletes
 * the checkpoint row, and opens it `runs` times through the full fold. Each commit is one entry of
 * ~800 characters, and every fifth also changes a session document by a delta, which is roughly the
 * shape of a session log: messages, and live state beside them.
 *
 * Prints JSON: the median and spread of each open in milliseconds, the commits each open read (from
 * the storage's own report, which is what the test suite asserts), the checkpoint's seq and its
 * stored (compressed) size beside the encoded fold's, and, for an owner open that starts writing
 * one, what the open costs its caller and what the checkpoint write took after it resolved.
 * The log is left in place under a unique id; nothing else is touched.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type DocumentId,
  type EntryId,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { BunRuntime } from "@effect/platform-bun";
import { Clock, Console, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  CHECKPOINT_EVERY,
  DatabaseLive,
  PostgresStorage,
  type OpenReport,
} from "../src";

const commits = Number(process.argv[2] ?? 10_250);
const runs = Number(process.argv[3] ?? 7);
const context = BACKGROUND_CONTEXT;

/** Milliseconds `effect` took, beside its value. */
const time = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const value = yield* effect;
    const end = yield* Clock.currentTimeNanos;
    return { ms: Number(end - start) / 1e6, value };
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const round = (ms: number) => Math.round(ms * 10) / 10;

const summary = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? Number.NaN),
    minMs: round(sorted[0] ?? Number.NaN),
    maxMs: round(sorted.at(-1) ?? Number.NaN),
  };
};

/**
 * ~800 characters of deterministic pseudo-prose: words from a 512-word vocabulary with a hex id
 * every eighth word, so the text compresses about as well as a transcript does rather than as well
 * as one repeated phrase (which would flatter the compressed checkpoint).
 */
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

const program = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const logId = `bench-open-${process.pid}-${yield* Clock.currentTimeMillis}`;

  const seed = Effect.gen(function* () {
    const owner = yield* Effect.promise(() =>
      PostgresStorage.open(sql, { logId }, context),
    );
    const documentId = yield* Effect.promise(() => owner.mintId<DocumentId>());
    yield* Effect.promise(() =>
      owner.commit(
        [
          { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "bench.live",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: { turns: 0 } },
          },
        ],
        context,
      ),
    );
    for (let at = 2; at <= commits; at += 1) {
      const id = yield* Effect.promise(() => owner.mintId<EntryId>());
      const writes: StorageWrite[] = [
        {
          type: "entry",
          value: {
            id,
            conversationId: ROOT_CONVERSATION_ID,
            kind: at % 2 === 0 ? "user" : "assistant",
            data: { text: text(at) },
          },
        },
      ];
      if (at % 5 === 0) {
        writes.push({
          type: "document.change",
          id: documentId,
          content: { kind: "delta", version: 1, ops: [["s", ["turns"], at]] },
        });
      }
      yield* Effect.promise(() => owner.commit(writes, context));
    }
    yield* Effect.promise(() => owner.close(context));
  });

  const openReader = Effect.gen(function* () {
    const { ms, value } = yield* time(
      Effect.promise(() =>
        PostgresStorage.open(sql, { logId, mode: "reader" }, context),
      ),
    );
    const report = value.opened;
    yield* Effect.promise(() => value.close(context));
    return { ms, report };
  });

  const opens = Effect.gen(function* () {
    const samples: number[] = [];
    let report: OpenReport | undefined;
    for (let run = 0; run < runs; run += 1) {
      const open = yield* openReader;
      samples.push(open.ms);
      report = open.report;
    }
    return { ...summary(samples), runs, ...report };
  });

  const seeded = yield* time(seed);
  const rows = yield* sql<{ seq: number; bytes: number }>`
    SELECT seq::int AS seq, octet_length(fold)::int AS bytes
    FROM log_checkpoints WHERE log_id = ${logId}
  `;

  // Warm the connection pool and the plan cache once, so neither open pays for them.
  yield* openReader;
  const fromCheckpoint = yield* opens;
  yield* sql`DELETE FROM log_checkpoints WHERE log_id = ${logId}`;
  const fullFold = yield* opens;

  // An owner opening a log with no checkpoint folds it and starts writing one. The open resolves
  // before the write lands, so the write is timed on its own: `ownerOpenMs` is what the caller
  // waits for, `checkpointWriteMs` what the background write took after it.
  const ownerOpen = yield* time(
    Effect.promise(() => PostgresStorage.open(sql, { logId }, context)),
  );
  const checkpointWrite = yield* time(
    Effect.promise(() => ownerOpen.value.checkpointsWritten()),
  );
  const foldBytes = new TextEncoder().encode(
    ownerOpen.value.encodedFold() ?? "",
  ).length;
  yield* Effect.promise(() => ownerOpen.value.close(context));

  yield* Console.log(
    encodeJson({
      logId,
      commits,
      checkpointEvery: CHECKPOINT_EVERY,
      seedMs: Math.round(seeded.ms),
      checkpoint: { ...rows[0], foldBytes },
      open: { fromCheckpoint, fullFold },
      speedup: round(fullFold.medianMs / fromCheckpoint.medianMs),
      ownerOpenMs: Math.round(ownerOpen.ms),
      checkpointWriteMs: Math.round(checkpointWrite.ms),
    }),
  );
}).pipe(Effect.provide(DatabaseLive));

BunRuntime.runMain(program);
