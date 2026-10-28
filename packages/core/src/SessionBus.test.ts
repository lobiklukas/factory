/**
 * The commit bus (LOB-18): migration 0034's trigger announces every commit as a cursor, and
 * `SessionBusPostgres` hands each follower the cursors of its own log.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. The commits are inserted as
 * rows rather than through a `Storage`, because what is under test is the table's trigger and the
 * listener — the same rows an owner's commit writes — and each case uses log ids of its own.
 */
import { BunServices } from "@effect/platform-bun";
import { randomBytes } from "node:crypto";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { parseCursor, SessionBus, SessionBusPostgres } from "./SessionBus";

const runtime = ManagedRuntime.make(
  SessionBusPostgres.pipe(
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);
afterAll(() => runtime.dispose());

const freshLog = () => `bus-${randomBytes(6).toString("hex")}`;

const commit = (logId: string, seq: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO commits (log_id, seq, writes) VALUES (${logId}, ${seq}, '[]')`;
  });

describe("the commit bus", () => {
  /**
   * Mutation: drop the trigger (or notify another channel) — nothing arrives and the case times out.
   * Mutation: drop the subscriber's `logId` filter — the other log's cursor arrives first.
   * Mutation: send the commit's `writes` instead of a cursor — `seq` is missing and nothing parses.
   */
  it("hands a follower the cursor of every commit to its log, and none of another log's", async () => {
    const received = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* SessionBus;
          const followed = freshLog();
          const other = freshLog();
          const cursors = yield* bus.subscribe(followed);
          yield* commit(other, 1);
          yield* commit(followed, 1);
          yield* commit(other, 2);
          yield* commit(followed, 2);
          return yield* cursors.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
            Effect.map((chunk) => ({ followed, cursors: [...chunk] })),
          );
        }),
      ),
    );
    expect(received.cursors).toEqual([
      { logId: received.followed, seq: 1 },
      { logId: received.followed, seq: 2 },
    ]);
  }, 30_000);

  /** Mutation: a parser that throws on a foreign payload — the listener stops on the first one. */
  it("ignores a payload that is not a cursor", () => {
    expect(parseCursor('{"log_id":"ses_x","seq":3}')).toEqual({
      logId: "ses_x",
      seq: 3,
    });
    expect(parseCursor("not json")).toBeUndefined();
    expect(parseCursor('{"log_id":7}')).toBeUndefined();
  });
});
