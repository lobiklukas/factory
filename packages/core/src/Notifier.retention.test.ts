/**
 * The retention sweep (F22): over a real ledger and real `run_failures`, a delivered notification and
 * a recorded failure older than the window are deleted, and nothing else is — not an undelivered row,
 * not a recent one, not a delivered row whose event is still open, nothing inside the failure
 * lookback — and a removed row's event is not announced again.
 *
 * "Old" is made by writing the timestamp: the sweep compares `delivered_at` and `failed_at` with
 * `now()`, and these cases set them to ten days ago. The sweep deletes by age across the whole
 * database, so the cases run on a scratch database of this file's own (`scratchDatabase`), never a
 * developer's `factory` one.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  makeNotifier,
  NOTIFICATION_KINDS,
  type NotificationSink,
} from "./Notifier";
import {
  actor,
  BASE,
  cleanup,
  fakeSink,
  scratchDatabase,
  seed,
  type Seeded,
} from "./notifier.test-fake";

/** The window these cases sweep with, and how old their "old" rows are: ten days against five. */
const WINDOW_MS = 5 * 86_400_000;
const OLD_DAYS = 10;

const scratch = await scratchDatabase("retention");
const runtime = scratch.runtime;

afterAll(async () => {
  await runtime.runPromise(cleanup);
  await scratch.drop();
});

const notifierOver = (
  sink: NotificationSink,
  over: {
    readonly retentionMs?: number;
    readonly sweepEveryMs?: number;
    readonly failureLookbackMs?: number;
  } = {},
) =>
  makeNotifier({
    sinks: [sink],
    kinds: new Set(NOTIFICATION_KINDS),
    linkBase: BASE,
    retentionMs: WINDOW_MS,
    ...over,
  });

/** A ledger row for `sink`, as if it was recorded `ageDays` ago and delivered (or not) then. */
const ledgerRow = (
  sink: string,
  eventId: string,
  ageDays: number,
  delivered: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const secs = ageDays * 86_400;
    yield* sql`
      INSERT INTO notification_deliveries
        (event_id, sink, kind, title, body, link, created_at, attempts, delivered_at)
      VALUES (
        ${eventId}, ${sink}, 'failed', 't', 'b', 'http://dash.test/',
        now() - make_interval(secs => ${secs}), 1,
        ${delivered ? sql`now() - make_interval(secs => ${secs})` : sql`NULL`}
      )
    `;
  });

const ageLedger = (sink: string, eventId: string, ageDays: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const secs = ageDays * 86_400;
    yield* sql`
      UPDATE notification_deliveries
      SET delivered_at = now() - make_interval(secs => ${secs}),
          created_at = now() - make_interval(secs => ${secs})
      WHERE sink = ${sink} AND event_id = ${eventId}
    `;
  });

/**
 * The sink's rows for the events a case cares about: the notifier reads every board, so other files'
 * leftovers can reach a fake sink too, and a case reads only its own.
 */
const rowsOf = (
  sink: string,
  seeded: Seeded,
  extra: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const mine = new Set([...mineIds(seeded), ...extra]);
    const rows = yield* sql<{
      readonly eventId: string;
      readonly delivered: boolean;
    }>`
      SELECT event_id, delivered_at IS NOT NULL AS delivered
      FROM notification_deliveries WHERE sink = ${sink} ORDER BY event_id
    `;
    return rows
      .filter((row) => mine.has(row.eventId))
      .map((row) => `${row.eventId}${row.delivered ? "" : " (undelivered)"}`);
  });

const mineIds = (seeded: Seeded): ReadonlyArray<string> => [
  seeded.approval,
  seeded.failed,
  seeded.gate,
  seeded.question,
];

/** A failure of `sessionId` recorded `ageDays` ago, under `entry`. */
const failureRow = (sessionId: string, entry: string, ageDays: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO run_failures (session_id, entry_id, reason, detail, failed_at)
      VALUES (
        ${sessionId}, ${entry}, 'model_error', 'a model request failed',
        now() - make_interval(secs => ${ageDays * 86_400})
      )
    `;
  });

const failureEntries = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ readonly entryId: string }>`
      SELECT entry_id FROM run_failures WHERE session_id = ${sessionId} ORDER BY entry_id
    `;
    return rows.map((row) => row.entryId);
  });

/** The seeded failure's session, from its event id. */
const failedSession = (seeded: Seeded): string =>
  seeded.failed.replace(/^failed:/, "").split(":")[0] ?? "";

describe("the retention sweep", () => {
  it("deletes delivered rows and failures older than the window, and nothing else", async () => {
    const fake = fakeSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(actor("owner"));
        const session = failedSession(seeded);
        const notifier = yield* notifierOver(fake.sink, { sweepEveryMs: 0 });
        yield* notifier.pass;
        // History: ten days of ledger and failures behind the four live events.
        yield* ledgerRow(fake.sink.id, "failed:old:delivered", OLD_DAYS, true);
        yield* ledgerRow(
          fake.sink.id,
          "failed:old:undelivered",
          OLD_DAYS,
          false,
        );
        yield* ledgerRow(fake.sink.id, "failed:recent:delivered", 2, true);
        yield* failureRow(session, "old", OLD_DAYS);
        yield* failureRow(session, "recent", 2);
        const swept = yield* notifier.sweep;
        return {
          swept,
          rows: yield* rowsOf(fake.sink.id, seeded, [
            "failed:old:delivered",
            "failed:old:undelivered",
            "failed:recent:delivered",
          ]),
          failures: yield* failureEntries(session),
          seeded,
        };
      }),
    );
    expect(result.rows).toEqual(
      [
        result.seeded.approval,
        result.seeded.failed,
        result.seeded.gate,
        result.seeded.question,
        "failed:old:undelivered (undelivered)",
        "failed:recent:delivered",
      ].sort(),
    );
    // The two the sweep removed are counted, and only this file's failure row of the two is the old one.
    expect(result.swept.deliveries).toBeGreaterThanOrEqual(1);
    expect(result.swept.failures).toBeGreaterThanOrEqual(1);
    expect(result.failures).toEqual(["9", "recent"]);
  }, 60_000);

  it("does not announce a removed row's event again", async () => {
    const fake = fakeSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(actor("owner"));
        const session = failedSession(seeded);
        // A failure ten days old whose delivery was recorded ten days ago.
        yield* failureRow(session, "ancient", OLD_DAYS);
        yield* ledgerRow(
          fake.sink.id,
          `failed:${session}:ancient`,
          OLD_DAYS,
          true,
        );
        const notifier = yield* notifierOver(fake.sink, { sweepEveryMs: 0 });
        yield* notifier.pass;
        yield* notifier.pass;
        return {
          seeded,
          session,
          rows: yield* rowsOf(fake.sink.id, seeded, [
            `failed:${session}:ancient`,
          ]),
        };
      }),
    );
    expect(result.rows).not.toContain(`failed:${result.session}:ancient`);
    expect(fake.sent.map((n) => n.eventId)).not.toContain(
      `failed:${result.session}:ancient`,
    );
    // The four live events were sent once each across both passes.
    expect(
      fake.sent
        .map((n) => n.eventId)
        .filter((id) => mineIds(result.seeded).includes(id))
        .sort(),
    ).toEqual([...mineIds(result.seeded)].sort());
  }, 60_000);

  it("deletes an undelivered row that can never be sent — out of attempts, or to a sink nothing sends to — and keeps a pending one", async () => {
    const fake = fakeSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const seeded = yield* seed(actor("owner"));
        const notifier = yield* notifierOver(fake.sink, { sweepEveryMs: 0 });
        yield* notifier.pass;
        const old = (eventId: string, sink: string, attempts: number) =>
          sql`
            INSERT INTO notification_deliveries
              (event_id, sink, kind, title, body, link, created_at, attempts)
            VALUES (
              ${eventId}, ${sink}, 'failed', 't', 'b', 'http://dash.test/',
              now() - make_interval(secs => ${OLD_DAYS * 86_400}), ${attempts}
            )
          `;
        const orphan = `push:orphan-${fake.sink.id.slice(5)}`;
        yield* old("failed:old:spent", fake.sink.id, 5);
        yield* old("failed:old:pending", fake.sink.id, 1);
        yield* old("failed:old:orphaned", orphan, 1);
        // An old row for an event that is still open is kept even when nothing sends to its sink:
        // deleting it would let the event be recorded again.
        yield* old(seeded.approval, orphan, 1);
        yield* notifier.sweep;
        const rows = yield* sql<{ readonly eventId: string }>`
          SELECT event_id FROM notification_deliveries
          WHERE (sink = ${fake.sink.id} AND event_id LIKE 'failed:old:%')
             OR sink = ${orphan}
        `;
        return {
          approval: seeded.approval,
          rows: rows.map((row) => row.eventId).sort(),
        };
      }),
    );
    expect(result.rows).toEqual([result.approval, "failed:old:pending"].sort());
  }, 60_000);

  it("keeps a delivered row whose event is still open, so the event is not sent a second time", async () => {
    const fake = fakeSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(actor("owner"));
        const notifier = yield* notifierOver(fake.sink, { sweepEveryMs: 0 });
        yield* notifier.pass;
        // The card has been parked on its question for ten days, and its row is as old.
        yield* ageLedger(fake.sink.id, seeded.question, OLD_DAYS);
        yield* ageLedger(fake.sink.id, seeded.approval, OLD_DAYS);
        yield* notifier.pass;
        yield* notifier.pass;
        return { seeded, rows: yield* rowsOf(fake.sink.id, seeded) };
      }),
    );
    expect(result.rows).toContain(result.seeded.question);
    expect(result.rows).toContain(result.seeded.approval);
    const sent = fake.sent.map((n) => n.eventId);
    expect(sent.filter((id) => id === result.seeded.question)).toHaveLength(1);
    expect(sent.filter((id) => id === result.seeded.approval)).toHaveLength(1);
  }, 60_000);

  it("never prunes inside the failure lookback, however short the retention", async () => {
    const fake = fakeSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(actor("owner"));
        const session = failedSession(seeded);
        // A failure two hours old: news (a day's lookback), delivered, and past a one-second retention.
        yield* failureRow(session, "recent", 2 / 24);
        const notifier = yield* notifierOver(fake.sink, {
          retentionMs: 1_000,
          sweepEveryMs: 0,
        });
        yield* notifier.pass;
        yield* ageLedger(fake.sink.id, `failed:${session}:recent`, 2 / 24);
        yield* notifier.pass;
        yield* notifier.pass;
        return {
          session,
          rows: yield* rowsOf(fake.sink.id, seeded, [
            `failed:${session}:recent`,
          ]),
          failures: yield* failureEntries(session),
        };
      }),
    );
    expect(result.failures).toEqual(["9", "recent"]);
    expect(result.rows).toContain(`failed:${result.session}:recent`);
    expect(
      fake.sent.filter((n) => n.eventId === `failed:${result.session}:recent`),
    ).toHaveLength(1);
  }, 60_000);

  it("runs on the poll at most once per interval, and the first pass sweeps", async () => {
    const fake = fakeSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(actor("owner"));
        const old = ["failed:first:old", "failed:second:old"];
        const notifier = yield* notifierOver(fake.sink, {
          sweepEveryMs: 60 * 60 * 1000,
        });
        yield* ledgerRow(fake.sink.id, "failed:first:old", OLD_DAYS, true);
        yield* notifier.pass;
        const afterFirst = yield* rowsOf(fake.sink.id, seeded, old);
        yield* ledgerRow(fake.sink.id, "failed:second:old", OLD_DAYS, true);
        yield* notifier.pass;
        const afterSecond = yield* rowsOf(fake.sink.id, seeded, old);
        yield* notifier.sweep;
        const afterForced = yield* rowsOf(fake.sink.id, seeded, old);
        return { afterFirst, afterSecond, afterForced };
      }),
    );
    expect(result.afterFirst).not.toContain("failed:first:old");
    expect(result.afterSecond).toContain("failed:second:old");
    expect(result.afterForced).not.toContain("failed:second:old");
  }, 60_000);

  it("sweeps even when nobody is configured to be told", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const seeded = yield* seed(actor("owner"));
        const session = failedSession(seeded);
        yield* failureRow(session, "old", OLD_DAYS);
        const notifier = yield* makeNotifier({
          sinks: [],
          kinds: new Set(NOTIFICATION_KINDS),
          linkBase: BASE,
          retentionMs: WINDOW_MS,
          sweepEveryMs: 0,
        });
        const pass = yield* notifier.pass;
        const left = yield* sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM run_failures WHERE session_id = ${session} AND entry_id = 'old'
        `;
        return { pass, left: left[0]?.n };
      }),
    );
    expect(result.pass).toEqual({ recorded: 0, delivered: 0, failed: 0 });
    expect(result.left).toBe(0);
  }, 60_000);
});
