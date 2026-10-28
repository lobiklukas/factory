/**
 * The deliveries the seam recorded, read back (T4).
 *
 * The seam is the real `TriggerServiceLive` over a real database, with a counting fake for the
 * session port, as `TriggerService.test.ts` has it: what is under test is the read — that every
 * outcome the seam writes (a processed delivery's session or card, a skip's reason, who sent it) comes
 * back from `listTriggerDeliveries` unchanged, filtered and paged — not whether work starts.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row this file writes carries a
 * per-run id and is deleted after the file, because the pagination case pins rows to a far-future
 * instant so it can walk them without the rest of the table in the way.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import {
  TriggerDeliveryError,
  type DeliveryRecord,
  type ListTriggerDeliveriesInput,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { TaskService, TaskServiceLive } from "./TaskService";
import { TriggerDeliveries, TriggerDeliveriesLive } from "./TriggerDeliveries";
import {
  NoWriteBack,
  TriggerCardsFromTaskService,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  type TriggerSessionsShape,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");
const sessionRepo = `acme/deliveries-${runId}` as RepoSlug;
const cardRepo = `acme/deliveries-cards-${runId}` as RepoSlug;
const unregisteredRepo = `acme/deliveries-unregistered-${runId}` as RepoSlug;

const rules: ReadonlyArray<TriggerRule> = [
  { label: "t4-session", repo: sessionRepo, prompt: "{{key}}" },
  { label: "t4-card", repo: cardRepo, prompt: "unused", mode: "card" },
  { label: "t4-unregistered", repo: unregisteredRepo, prompt: "{{key}}" },
];

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  source: "linear",
  key: `${runId}-issue`,
  action: "create",
  title: "Fix the widget",
  body: "It wobbles.",
  labels: ["t4-session"],
  ...over,
});

const opened: Array<SessionId> = [];
const sessions: TriggerSessionsShape = {
  create: () =>
    Effect.sync(() => {
      const id =
        `ses_${String(opened.length + 1).padStart(26, "0")}` as SessionId;
      opened.push(id);
      return { id };
    }),
  send: () => Effect.void,
};

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TriggerSessions, TriggerSessions.of(sessions)),
          NoWriteBack,
          TriggerCardsFromTaskService.pipe(Layer.provide(TaskServiceLive)),
        ),
      ),
    ),
    TaskServiceLive,
    TriggerDeliveriesLive,
  ).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

/** The ids this run's deliveries were made under, so the cleanup deletes only them. */
const mine = (suffix: string) => `${runId}-${suffix}`;

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM webhook_deliveries WHERE request_id LIKE ${`${runId}-%`}`;
    }),
  );
  await runtime.dispose();
});

const listed = (input: ListTriggerDeliveriesInput = {}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const deliveries = yield* TriggerDeliveries;
      return yield* deliveries.list(input);
    }),
  );

const deliver = (suffix: string, over: Partial<TriggerEvent> = {}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const trigger = yield* TriggerService;
      return yield* trigger.deliver({
        requestId: mine(suffix),
        event: event(over),
      });
    }),
  );

const recordOf = async (suffix: string): Promise<DeliveryRecord> => {
  const found = (await listed({ limit: 200 })).deliveries.find(
    (delivery) => delivery.deliveryId === mine(suffix),
  );
  if (found === undefined) throw new Error(`delivery ${suffix} was not listed`);
  return found;
};

describe("listTriggerDeliveries", () => {
  it("names the session a processed delivery opened, its source and its route", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO repos (slug) VALUES (${sessionRepo}) ON CONFLICT (slug) DO NOTHING`;
      }),
    );
    const outcome = await deliver("processed");
    expect(outcome.status).toBe("processed");

    const record = await recordOf("processed");
    expect(record).toMatchObject({
      deliveryId: mine("processed"),
      source: "linear",
      status: "processed",
      sessionId: outcome.sessionId,
    });
    expect(record.sessionId).toBeDefined();
    expect(record.taskId).toBeUndefined();
    expect(record.reason).toBe(outcome.reason);
    expect(record.reason).toContain(`mapped it to ${sessionRepo}`);
  }, 60_000);

  it("names the card a card rule filed, and no session", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO repos (slug) VALUES (${cardRepo}) ON CONFLICT (slug) DO NOTHING`;
        const tasks = yield* TaskService;
        yield* tasks.createBoard({
          repo: cardRepo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
      }),
    );
    const outcome = await deliver("card", {
      labels: ["t4-card"],
      key: mine("card-issue"),
      source: "generic",
    });
    expect(outcome.taskId).toBeDefined();

    const record = await recordOf("card");
    expect(record).toMatchObject({
      source: "generic",
      status: "processed",
      taskId: outcome.taskId,
    });
    expect(record.sessionId).toBeUndefined();
  }, 60_000);

  it("gives a skip's reason verbatim and names no work", async () => {
    const unlabelled = await deliver("no-rule", { labels: ["t4-nothing"] });
    const unregistered = await deliver("unregistered", {
      labels: ["t4-unregistered"],
    });
    const wrongAction = await deliver("action", { action: "update" });

    for (const [suffix, outcome] of [
      ["no-rule", unlabelled],
      ["unregistered", unregistered],
      ["action", wrongAction],
    ] as const) {
      const record = await recordOf(suffix);
      expect(record.status).toBe("skipped");
      expect(record.reason).toBe(outcome.reason);
      expect(record.sessionId).toBeUndefined();
      expect(record.taskId).toBeUndefined();
    }
    expect((await recordOf("unregistered")).reason).toBe(
      `repo ${unregisteredRepo} is not registered`,
    );
    expect((await recordOf("no-rule")).reason).toBe(
      "no rule matches labels [t4-nothing]",
    );
  }, 60_000);

  it("lists a row whose source or session this build cannot read, without those facts, and the rest of the page", async () => {
    const sql = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* SqlClient;
      }),
    );
    const odd = mine("odd-row");
    await runtime.runPromise(
      sql`INSERT INTO webhook_deliveries (request_id, status, skip_reason, source, session_id)
          VALUES (${odd}, 'processed', 'rule t4', 'fax-machine', 'ses_lws_not_a_session_id')`,
    );
    await deliver("odd-neighbour", { labels: ["t4-nothing"] });
    const record = await recordOf("odd-row");
    expect(record).toMatchObject({
      deliveryId: odd,
      status: "processed",
      reason: "rule t4",
    });
    expect(record.source).toBeUndefined();
    expect(record.sessionId).toBeUndefined();
    expect((await recordOf("odd-neighbour")).status).toBe("skipped");
  }, 60_000);

  it("filters by status and by source, and only by what it is asked", async () => {
    await deliver("generic-skip", { source: "generic", labels: ["t4-none"] });
    const skipped = await listed({ status: "skipped", limit: 200 });
    expect(skipped.deliveries.length).toBeGreaterThan(0);
    expect(skipped.deliveries.every((row) => row.status === "skipped")).toBe(
      true,
    );
    const ids = skipped.deliveries.map((row) => row.deliveryId);
    expect(ids).toContain(mine("unregistered"));
    expect(ids).not.toContain(mine("processed"));

    const generic = await listed({
      source: "generic",
      status: "skipped",
      limit: 200,
    });
    expect(generic.deliveries.every((row) => row.source === "generic")).toBe(
      true,
    );
    const genericIds = generic.deliveries.map((row) => row.deliveryId);
    expect(genericIds).toContain(mine("generic-skip"));
    // Linear's skip and a generic processed card are each excluded by one of the two filters.
    expect(genericIds).not.toContain(mine("unregistered"));
    expect(genericIds).not.toContain(mine("card"));
  }, 60_000);

  it("lists newest first and pages with a cursor that loses and repeats nothing, ties included", async () => {
    // Three rows at one instant (the id breaks the tie) and one a microsecond older, far enough in
    // the future (written in SQL: a bound parameter would round to the millisecond) that nothing else in the table is in the way of the walk.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const suffix of ["page-a", "page-b", "page-c"]) {
          yield* sql`INSERT INTO webhook_deliveries (request_id, status, source, received_at)
            VALUES (${mine(suffix)}, 'skipped', 'jira',
              timestamptz '2099-01-01 00:00:00+00' + interval '123456 microseconds')`;
        }
        yield* sql`INSERT INTO webhook_deliveries (request_id, status, source, received_at)
          VALUES (${mine("page-d")}, 'skipped', 'jira',
            timestamptz '2099-01-01 00:00:00+00' + interval '123455 microseconds')`;
      }),
    );
    const first = await listed({ source: "jira", limit: 3 });
    expect(first.deliveries.map((row) => row.deliveryId)).toEqual([
      mine("page-c"),
      mine("page-b"),
      mine("page-a"),
    ]);
    expect(first.nextCursor).toBeDefined();
    const second = await listed({
      source: "jira",
      limit: 3,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    expect(second.deliveries[0]?.deliveryId).toBe(mine("page-d"));
    expect(second.deliveries[0]?.receivedAt).toBe("2099-01-01T00:00:00.123Z");

    // A page that ends exactly at the last row mints no cursor.
    const all = await listed({ source: "jira", limit: 200 });
    const exact = await listed({
      source: "jira",
      limit: all.deliveries.length,
    });
    expect(exact.nextCursor).toBeUndefined();
  }, 60_000);

  it("refuses a cursor it did not mint, and clamps a page size", async () => {
    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const deliveries = yield* TriggerDeliveries;
        return yield* Effect.flip(deliveries.list({ cursor: "not-a-cursor" }));
      }),
    );
    expect(refused).toBeInstanceOf(TriggerDeliveryError);
    expect(refused).toMatchObject({ code: "invalid_input" });

    expect((await listed({ limit: 0 })).deliveries).toHaveLength(1);
    expect(
      (await listed({ limit: 100_000 })).deliveries.length,
    ).toBeLessThanOrEqual(200);
  }, 60_000);
});
