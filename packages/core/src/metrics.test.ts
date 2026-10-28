/**
 * The documented metric set (LOB-69, `docs/metrics.md`), moved by the session-service paths that
 * own each metric and read back from effect's metric registry.
 *
 * This is the producing half. Whether the numbers leave the process and reach a collector is
 * `apps/api/src/observability/OtlpMetrics.test.ts`, against an in-process OTLP/HTTP receiver.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. The registry is per test file
 * (vitest isolates a file's modules), but cases in this file share it, so every assertion is a
 * difference between a reading before and one after.
 */
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionId } from "@repo/domain/Session";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Exit, Layer, ManagedRuntime, Metric, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  Refusals,
  type RefusalReason,
  RunDuration,
  SessionCreates,
  type SessionOrigin,
  SessionsActive,
} from "./metrics";
import { mintBoardId, mintTaskId } from "./ids";
import {
  MAX_MESSAGE_CHARS,
  SessionService,
  SessionServiceLive,
  type SessionServiceShape,
} from "./SessionService";

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);

/** A model that naps before each step, so a run is busy long enough to be timed and refused into. */
const SLEEP_MS = 400;
const sleepingRoot = mkdtempSync(join(tmpdir(), "factory-metrics-"));
const sleeping = ManagedRuntime.make(
  SessionServiceLive({
    model: createFauxModelAccess({ fauxSleepMs: SLEEP_MS }).access,
    sessionRoot: sleepingRoot,
  }).pipe(Layer.provideMerge(DatabaseLayer)),
);

/** A priced model, so a budget can be reached at all (as `SessionService.test.ts`'s budget cases). */
const COST = 0.01;
const pricedRoot = mkdtempSync(join(tmpdir(), "factory-metrics-priced-"));
const priced = ManagedRuntime.make(
  SessionServiceLive({
    model: createFauxModelAccess({ fauxCost: COST }).access,
    sessionRoot: pricedRoot,
  }).pipe(Layer.provideMerge(DatabaseLayer)),
);

afterAll(async () => {
  await sleeping.dispose();
  await priced.dispose();
});

const creates = (origin: SessionOrigin) =>
  Metric.value(Metric.withAttributes(SessionCreates, { origin })).pipe(
    Effect.map((state) => state.count),
  );
const refusals = (reason: RefusalReason) =>
  Metric.value(Metric.withAttributes(Refusals, { reason })).pipe(
    Effect.map((state) => state.count),
  );
const active = Metric.value(SessionsActive).pipe(
  Effect.map((state) => state.value),
);
const runs = Metric.value(RunDuration);

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** The run that took `text` has settled: idle, and the transcript ends in an answer to it. */
const settledAfter = (
  sessions: SessionServiceShape,
  sessionId: SessionId,
  text: string,
) =>
  waitUntil(
    sessions
      .get(sessionId)
      .pipe(
        Effect.map(
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some(
              (entry) => entry.kind === "user" && entry.text === text,
            ) &&
            snapshot.entries.at(-1)?.kind === "assistant",
        ),
      ),
    `the run that took "${text}" to settle`,
  );

describe("factory.session.creates", () => {
  /**
   * Mutation: drop `countSessionCreate("create")` — the create delta is 0.
   * Mutation: count before the request-id dedupe returns — the retried create counts twice.
   * Mutation: count a fork as `create` — the fork delta is 0 and the create delta is 2.
   */
  it("counts a create once, not the request-id retry, and a fork under its own origin", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const before = {
          create: yield* creates("create"),
          fork: yield* creates("fork"),
        };
        const requestId = `metrics-${randomBytes(6).toString("hex")}`;
        const created = yield* sessions.create({ title: "counted", requestId });
        const retried = yield* sessions.create({
          title: "counted",
          requestId,
        });
        const forked = yield* sessions.fork({ sessionId: created.id });
        return {
          same: retried.id === created.id,
          forkedFrom: forked.forkedFrom,
          createdId: created.id,
          create: (yield* creates("create")) - before.create,
          fork: (yield* creates("fork")) - before.fork,
        };
      }),
    );
    expect(outcome.same).toBe(true);
    expect(outcome.forkedFrom).toBe(outcome.createdId);
    expect(outcome.create).toBe(1);
    expect(outcome.fork).toBe(1);
  }, 60_000);
});

describe("factory.session.active", () => {
  /**
   * Mutation: drop the `shiftSessionsActive(1)` on an owner's open — the gauge does not rise.
   * Mutation: drop the `-1` in `releaseOwner` — closing the owners leaves the gauge raised.
   * Mutation: count a re-acquisition of an open owner — the second read is 3 above, not 2.
   */
  it("rises with each owner this process opens and falls when they are released", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        // Whatever an earlier case left open is closed first, so the baseline is this case's.
        yield* sessions.close;
        const baseline = yield* active;
        const first = yield* sessions.create({ title: "owned one" });
        yield* sessions.create({ title: "owned two" });
        // Reading an owned session reuses its owner rather than opening another.
        yield* sessions.get(first.id);
        const open = (yield* active) - baseline;
        yield* sessions.close;
        const closed = (yield* active) - baseline;
        return { open, closed };
      }),
    );
    expect(outcome.open).toBe(2);
    expect(outcome.closed).toBe(0);
  }, 60_000);
});

describe("factory.run.duration", () => {
  /**
   * Mutation: drop `observeRun` from the status case — no run is recorded.
   * Mutation: record milliseconds as seconds — the sum is a thousand times too large.
   */
  it("records one run from busy to idle, in seconds", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const before = yield* runs;
        const created = yield* sessions.create({ title: "timed" });
        yield* sessions.send({ sessionId: created.id, content: "time me" });
        yield* settledAfter(sessions, created.id, "time me");
        // The projection records the idle status after the snapshot reports it.
        yield* waitUntil(
          runs.pipe(Effect.map((state) => state.count > before.count)),
          "the run's duration to be recorded",
        );
        const after = yield* runs;
        return {
          count: after.count - before.count,
          seconds: after.sum - before.sum,
        };
      }),
    );
    expect(outcome.count).toBe(1);
    // The faux naps before each of a turn's two steps (a tool call, then the answer).
    expect(outcome.seconds).toBeGreaterThanOrEqual((2 * SLEEP_MS) / 1000);
    expect(outcome.seconds).toBeLessThan(60);
  }, 60_000);
});

describe("task_runs.finished_at (LOB-44)", () => {
  /**
   * The outcome metrics' factory time is a card's runs from `started_at` to `finished_at`, which the
   * same busy-to-idle observation that times a run writes.
   *
   * Mutation: drop the `finished_at` write — the column stays `NULL`.
   * Mutation: write it when the run turns busy — it is not two faux naps after the row was written.
   */
  it("ends a card's run where its session goes idle", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const created = yield* sessions.create({ title: "a card's run" });
        // Ids of the real shape: other suites list every board in this database and decode each.
        const board = yield* mintBoardId;
        const task = yield* mintTaskId;
        yield* sql`
          INSERT INTO board_instances (id, repo, definition_id, definition_version)
          VALUES (${board}, ${`acme/metrics-${randomBytes(6).toString("hex")}`}, 'default', 1)
        `;
        yield* sql`
          INSERT INTO tasks (id, board_id, "column", definition_version, revision)
          VALUES (${task}, ${board}, 'building', 1, 1)
        `;
        yield* sql`
          INSERT INTO task_runs (id, task_id, session_id, "column")
          VALUES (${created.id}, ${task}, ${created.id}, 'building')
        `;
        const before = yield* runs;
        yield* sessions.send({ sessionId: created.id, content: "finish me" });
        yield* settledAfter(sessions, created.id, "finish me");
        yield* waitUntil(
          runs.pipe(Effect.map((state) => state.count > before.count)),
          "the run's duration to be recorded",
        );
        const finished = () =>
          sql<{ readonly ran: number | null }>`
            SELECT
              (extract(epoch FROM tr.finished_at - tr.started_at))::double precision AS ran
            FROM task_runs tr WHERE tr.session_id = ${created.id}
          `;
        yield* waitUntil(
          finished().pipe(Effect.map((rows) => rows[0]?.ran != null)),
          "the run's finished_at to be written",
        );
        const ran = (yield* finished())[0];
        // The card goes with its board (and its run with the card), so no other suite reads it.
        yield* sql`DELETE FROM board_instances WHERE id = ${board}`;
        return ran;
      }),
    );
    // The faux naps before each of a turn's two steps, so the run ended at least that long after the
    // row was written — which a write at the run's start would not.
    expect(outcome?.ran).toBeGreaterThanOrEqual((2 * SLEEP_MS) / 1000);
    expect(outcome?.ran).toBeLessThan(60);
  }, 60_000);
});

describe("factory.refusals", () => {
  /**
   * Mutation: drop the count before the length check's refusal — `message_too_long` stays 0.
   * Mutation: drop the `tapError` on the submission — `busy` stays 0.
   * Mutation: count every submission error as `busy` — a refused oversize would count there too.
   */
  it("counts an oversized message and a reject-when-busy message, each under its reason", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const before = {
          long: yield* refusals("message_too_long"),
          busy: yield* refusals("busy"),
        };
        const created = yield* sessions.create({ title: "refused twice" });
        const long = yield* Effect.exit(
          sessions.send({
            sessionId: created.id,
            content: "x".repeat(MAX_MESSAGE_CHARS + 1),
          }),
        );
        yield* sessions.send({ sessionId: created.id, content: "busy now" });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.live.busy)),
          "the run to start",
        );
        const busy = yield* Effect.exit(
          sessions.send({
            sessionId: created.id,
            content: "only if idle",
            whenBusy: "reject",
          }),
        );
        yield* settledAfter(sessions, created.id, "busy now");
        return {
          long: Exit.isFailure(long),
          busyCode: Option.map(Exit.findErrorOption(busy), (e) => e.code),
          longDelta: (yield* refusals("message_too_long")) - before.long,
          busyDelta: (yield* refusals("busy")) - before.busy,
        };
      }),
    );
    expect(outcome.long).toBe(true);
    expect(outcome.busyCode).toEqual(Option.some("busy"));
    expect(outcome.longDelta).toBe(1);
    expect(outcome.busyDelta).toBe(1);
  }, 60_000);

  /** Mutation: drop the count before `releasedError` under the gate — `released` stays 0. */
  it("counts a start on a released session as released", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const before = yield* refusals("released");
        const created = yield* sessions.create({ title: "released" });
        yield* sessions.releaseWorkspace({
          sessionId: created.id,
          reason: "discarded",
        });
        const sent = yield* Effect.exit(
          sessions.send({ sessionId: created.id, content: "too late" }),
        );
        return {
          refused: Exit.isFailure(sent),
          delta: (yield* refusals("released")) - before,
        };
      }),
    );
    expect(outcome.refused).toBe(true);
    expect(outcome.delta).toBe(1);
  }, 60_000);

  /** Mutation: drop the count beside the budget stop's log line — `budget` stays 0. */
  it("counts a model request the session's budget stopped as budget", async () => {
    const outcome = await priced.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const before = yield* refusals("budget");
        const created = yield* sessions.create({ budget: COST });
        yield* sessions.send({ sessionId: created.id, content: "go" });
        yield* waitUntil(
          refusals("budget").pipe(Effect.map((count) => count > before)),
          "the budget stop to be counted",
        );
        const snapshot = yield* sessions.get(created.id);
        return {
          stopped: snapshot.budget?.stopped !== undefined,
          delta: (yield* refusals("budget")) - before,
        };
      }),
    );
    expect(outcome.stopped).toBe(true);
    expect(outcome.delta).toBe(1);
  }, 60_000);
});
