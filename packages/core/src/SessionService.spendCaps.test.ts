/**
 * Aggregate spend caps (S-aggregate-spend-caps) over real sessions on a priced faux model.
 *
 * A repository's daily cap that its runs have reached refuses the next create and send on it with
 * `budget_exceeded`, naming the cap and where it is configured, while another repository, and
 * another actor on the same one, are unaffected; the spend that crosses 80% of a cap writes one
 * attention item however many runs follow, and 100% another; the notifier tells a person of each
 * once. The oracle for "spent" is the ledger the test reads back, not the cap's own arithmetic.
 *
 * Every repository and actor is this run's own (a random tag), so the caps and the alerts these
 * cases write never touch another case's, nor anything a developer has on the same database.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepoSlug,
  type SessionError,
  type SessionId,
} from "@repo/domain/Session";
import { createFauxModelAccess, usageCostTotal } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Clock, Effect, Layer, ManagedRuntime, Metric } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { mintBoardId } from "./ids";
import { Refusals } from "./metrics";
import { makeNotifier, type Notification } from "./Notifier";
import { SessionService, SessionServiceLive } from "./SessionService";
import { parseSpendCaps, type SpendCaps } from "./spendCaps";
import { TaskService, TaskServiceLive } from "./TaskService";

/**
 * What one request costs on the faux model, and what a run of "go" costs: the model calls a tool and
 * then answers, so two requests (`SessionService.budget.test.ts` relies on the same two). The first
 * case reads a run's real spend back and fails if this is not it, so the caps below, which are
 * multiples of a run, mean what their names say.
 */
const COST = 0.01;
const RUN = 2 * COST;
const root = mkdtempSync(join(tmpdir(), "factory-core-spendcaps-"));
const tag = randomBytes(4).toString("hex");
const repoOf = (name: string) => RepoSlug.make(`caps-${tag}/${name}`);
const actorOf = (name: string) => `${name}-${tag}`;

const capsOf = (config: unknown): Effect.Effect<SpendCaps> =>
  parseSpendCaps(JSON.stringify(config)).pipe(Effect.orDie);

const runtimeOver = (caps: SpendCaps, fauxCommand?: string) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      SessionServiceLive({
        model: createFauxModelAccess({
          fauxCost: COST,
          ...(fauxCommand === undefined ? {} : { fauxCommand }),
        }).access,
        sessionRoot: root,
        spendCaps: caps,
      }),
      TaskServiceLive,
    ).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
  );

/** The ledger's dollars for these sessions: what they spent, as the cap counts it. */
const ledgerOf = (ids: ReadonlyArray<SessionId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ usd: number }>`
      SELECT COALESCE(sum(usd), 0)::float8 AS usd FROM spend_ledger
      WHERE session_id IN ${sql.in(ids)}
    `;
    return rows[0]?.usd ?? 0;
  });

/** A run on a fresh session of `repo` by `actor`, awaited until its spend is in the ledger. */
const runOn = (repo: RepoSlug, actor: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const sql = yield* SqlClient;
    const created = yield* sessions.create({ repo, actor });
    yield* sessions.send({ sessionId: created.id, content: "go" });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = yield* sessions.get(created.id);
      const rows = yield* sql<{ costTotal: number }>`
        SELECT cost_total::float8 AS cost_total FROM session_activity
        WHERE session_id = ${created.id}
      `;
      const spent = yield* ledgerOf([created.id]);
      // Settled: answered, idle, and both the activity row and the ledger hold what the log's
      // usage does — the whole run's cost, not the first request's.
      if (
        !snapshot.live.busy &&
        snapshot.entries.some(
          (entry) => entry.kind === "assistant" && entry.text !== "",
        ) &&
        rows[0]?.costTotal === usageCostTotal(snapshot.usage) &&
        Math.abs(spent - usageCostTotal(snapshot.usage)) < 1e-9
      ) {
        return created.id;
      }
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`the run on ${repo} did not settle`));
  });

const alertsOf = (subject: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ threshold: number; span: string }>`
      SELECT threshold, span FROM spend_alerts WHERE subject = ${subject}
      ORDER BY span, threshold
    `;
  });

/**
 * The alerts once at least `count` exist. A run's spend is in the ledger a statement before the
 * alerts its crossing raises, so a read made the instant a run settles can beat them: wait for the
 * ones the case expects, then assert on the full set (a row it should not have is still there).
 */
const alertsOnceThereAre = (subject: string, count: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = yield* alertsOf(subject);
      if (rows.length >= count) return rows;
      yield* Effect.sleep(25);
    }
    return yield* Effect.die(new Error(`no ${count} alerts for ${subject}`));
  });

const spendItems = (subject: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return (yield* tasks.attention(undefined)).filter(
      (item) => item.reason._tag === "spend" && item.reason.subject === subject,
    );
  });

afterAll(async () => {
  // The alerts these cases wrote would otherwise stay in every attention view on the database.
  const runtime = ManagedRuntime.make(DatabaseLive);
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`DELETE FROM spend_alerts WHERE subject LIKE ${`%${tag}%`}`;
        yield* sql`DELETE FROM spend_cap_limits WHERE subject LIKE ${`%${tag}%`}`;
        yield* sql`DELETE FROM board_instances WHERE repo = ${`caps-${tag}/board`}`;
        yield* sql`DELETE FROM spend_ledger WHERE repo LIKE ${`caps-${tag}/%`} OR actor LIKE ${`%-${tag}`}`;
        // By sink, as `Notifier.test.ts` does: this test's notifier also delivers every other spend
        // alert on the database to its sink, whose subjects are not this run's.
        yield* sql`DELETE FROM notification_deliveries WHERE sink = ${`test:spend-${tag}`}`;
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

const refusals = Metric.value(
  Metric.withAttributes(Refusals, { reason: "budget_exceeded" }),
).pipe(Effect.map((state) => state.count));

const refusal = <A>(effect: Effect.Effect<A, SessionError, SessionService>) =>
  Effect.flip(effect);

describe("a repository's daily cap", () => {
  it("refuses a new run on a repo once its runs reached the cap, and leaves other repos and actors alone", async () => {
    const web = repoOf("web");
    const docs = repoOf("docs");
    const amy = actorOf("amy-repo");
    const runtime = runtimeOver(
      await Effect.runPromise(
        capsOf({ repos: { [web]: { daily: 1.5 * RUN } } }),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const first = yield* runOn(web, amy);
          expect(yield* ledgerOf([first])).toBeCloseTo(RUN, 10);
          // Below the cap: another run is let through, and takes the repo past it.
          const second = yield* runOn(web, amy);
          const spent = yield* ledgerOf([first, second]);
          expect(spent).toBeCloseTo(2 * RUN, 10);

          const counted = yield* refusals;
          const refused = yield* refusal(
            sessions.create({ repo: web, actor: amy, requestId: `cap-${tag}` }),
          );
          // Counted as a refusal, once (`factory.refusals{reason="budget_exceeded"}`).
          expect((yield* refusals) - counted).toBe(1);
          expect(refused.code).toBe("budget_exceeded");
          expect(refused.cap).toBeUndefined();
          expect(refused.spendCap?.scope).toBe("repo");
          expect(refused.spendCap?.subject).toBe(web);
          expect(refused.spendCap?.window).toBe("day");
          expect(refused.spendCap?.limit).toBeCloseTo(1.5 * RUN, 10);
          expect(refused.spendCap?.spent).toBeCloseTo(spent, 10);
          expect(refused.spendCap?.source).toBe(
            `SPEND_CAPS repos[${JSON.stringify(web)}].daily`,
          );
          expect(Date.parse(refused.spendCap?.resetsAt ?? "")).toBeGreaterThan(
            yield* Clock.currentTimeMillis,
          );
          expect(refused.message).toContain(web);
          expect(refused.message).toContain("SPEND_CAPS");

          // A send to a session of the repo is a run too, and refused the same way.
          const sent = yield* refusal(
            sessions.send({ sessionId: first, content: "more" }),
          );
          expect(sent.code).toBe("budget_exceeded");
          // A replay is a run: it pays for its source's task again.
          const replayed = yield* refusal(
            sessions.replay({ sessionId: first, actor: amy }),
          );
          expect(replayed.code).toBe("budget_exceeded");

          // Nothing was written for the refused create: its request id is still free.
          const sql = yield* SqlClient;
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM sessions WHERE request_id = ${`cap-${tag}`}
          `;
          expect(rows).toHaveLength(0);

          // Another repository, and the same actor on it, are not the repo's cap's business.
          const other = yield* runOn(docs, amy);
          expect(yield* ledgerOf([other])).toBeGreaterThan(0);
          const scratch = yield* sessions.create({ actor: amy });
          expect(scratch.id).toBeDefined();
          // The cap is a refusal, not an outage: reading is unaffected.
          expect((yield* sessions.get(first)).session.id).toBe(first);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 90_000);
});

describe("an actor's cap", () => {
  it("refuses that actor on every repo, and not another actor on the same repo", async () => {
    const web = repoOf("a-web");
    const api = repoOf("a-api");
    const amy = actorOf("amy-actor");
    const bob = actorOf("bob-actor");
    const runtime = runtimeOver(
      await Effect.runPromise(
        capsOf({ actors: { [amy]: { daily: 0.5 * RUN } } }),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          yield* runOn(web, amy);
          // Amy's spend counts across repos: she is refused on the repo she never ran on.
          const refused = yield* refusal(
            sessions.create({ repo: api, actor: amy }),
          );
          expect(refused.code).toBe("budget_exceeded");
          expect(refused.spendCap?.scope).toBe("actor");
          expect(refused.spendCap?.subject).toBe(amy);
          expect(refused.spendCap?.source).toBe(
            `SPEND_CAPS actors[${JSON.stringify(amy)}].daily`,
          );
          // Bob, on the repo Amy spent on, has no cap and spent nothing.
          const bobRun = yield* runOn(web, bob);
          expect(yield* ledgerOf([bobRun])).toBeGreaterThan(0);
          // A create with no actor named is nobody's, so no actor's cap holds it.
          expect((yield* sessions.create({ repo: api })).id).toBeDefined();
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 90_000);
});

describe("the alerts", () => {
  it("crossing 80% writes one attention item and one notification, 100% replaces it with the next, and neither repeats", async () => {
    const web = repoOf("alert");
    const amy = actorOf("amy-alert");
    // Two runs cost 2 * RUN = 90.9% of the cap and three cost 136%: the second crosses 80% and the
    // third reaches the cap. (A run is two requests, so a threshold can also be crossed inside one.)
    const limit = 2.2 * RUN;
    const runtime = runtimeOver(
      await Effect.runPromise(capsOf({ repos: { [web]: { daily: limit } } })),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          // One run: 45% of the cap, and nothing to say; two: 90.9%, and 80% is crossed, once —
          // the one row, and none for 100%, which the same evaluation would have written.
          yield* runOn(web, amy);
          yield* runOn(web, amy);
          expect(yield* alertsOnceThereAre(web, 1)).toEqual([
            { threshold: 80, span: "day" },
          ]);
          const warned = yield* spendItems(web);
          expect(warned).toHaveLength(1);
          const warning = warned[0]?.reason;
          if (warning?._tag !== "spend") throw new Error("not a spend item");
          expect(warning.threshold).toBe(80);
          expect(warning.scope).toBe("repo");
          expect(warning.window).toBe("day");
          expect(warning.limit).toBeCloseTo(limit, 10);
          expect(warning.spent).toBeGreaterThanOrEqual(0.8 * limit);
          expect(warning.spent).toBeLessThan(limit);

          // The notifier tells a person once, however many passes there are.
          const delivered: Notification[] = [];
          const sink = {
            id: `test:spend-${tag}`,
            label: "test",
            send: (n: Notification) =>
              Effect.sync(() => void delivered.push(n)),
          };
          const notifier = yield* makeNotifier({
            sinks: [sink],
            kinds: new Set(["spend"] as const),
            linkBase: "http://dash.test",
          });
          yield* notifier.pass;
          yield* notifier.pass;
          const first = delivered.filter((n) => n.eventId.includes(web));
          expect(first).toHaveLength(1);
          expect(first[0]?.kind).toBe("spend");
          expect(first[0]?.title).toContain("80%");
          expect(first[0]?.title).toContain(web);
          expect(first[0]?.link).toBe("http://dash.test/spend");

          // A third run is let through (90.9% < 100%) and reaches the cap: the 100% alert replaces
          // the 80% one in the view, and is told as its own event.
          yield* runOn(web, amy);
          expect(yield* alertsOnceThereAre(web, 2)).toEqual([
            { threshold: 80, span: "day" },
            { threshold: 100, span: "day" },
          ]);
          const reached = yield* spendItems(web);
          expect(reached).toHaveLength(1);
          const top = reached[0]?.reason;
          if (top?._tag !== "spend") throw new Error("not a spend item");
          expect(top.threshold).toBe(100);
          // A refused create writes no second 100% row, and the view still shows one item.
          const refused = yield* refusal(
            sessions.create({ repo: web, actor: amy }),
          );
          expect(refused.code).toBe("budget_exceeded");
          expect(yield* alertsOf(web)).toHaveLength(2);
          expect(yield* spendItems(web)).toHaveLength(1);
          yield* notifier.pass;
          const all = delivered.filter((n) => n.eventId.includes(web));
          expect(all.map((n) => n.title.includes("reached"))).toEqual([
            false,
            true,
          ]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("raises the alerts of spend recorded before a cap was configured when a request is refused", async () => {
    const web = repoOf("late");
    const amy = actorOf("amy-late");
    const uncapped = runtimeOver(await Effect.runPromise(capsOf({})));
    let spent = 0;
    try {
      spent = await uncapped.runPromise(
        Effect.gen(function* () {
          return yield* ledgerOf([yield* runOn(web, amy)]);
        }),
      );
    } finally {
      await uncapped.dispose();
    }
    const capped = runtimeOver(
      await Effect.runPromise(
        capsOf({ repos: { [web]: { daily: spent / 2 } } }),
      ),
    );
    try {
      await capped.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          expect(yield* alertsOf(web)).toEqual([]);
          const refused = yield* refusal(
            sessions.create({ repo: web, actor: amy }),
          );
          expect(refused.code).toBe("budget_exceeded");
          expect(yield* alertsOf(web)).toEqual([
            { threshold: 80, span: "day" },
            { threshold: 100, span: "day" },
          ]);
          expect(yield* spendItems(web)).toHaveLength(1);
        }),
      );
    } finally {
      await capped.dispose();
    }
  }, 90_000);

  it("lists the highest threshold of each cap in its current window, only on the every-board view, and drops it when the window ends", async () => {
    const web = repoOf("view");
    const actor = actorOf("view");
    // The caps the rows below were raised for: an alert is listed while its cap and limit stand.
    const runtime = runtimeOver(
      await Effect.runPromise(
        capsOf({
          repos: { [web]: { daily: 10, monthly: 10 } },
          actors: { [actor]: { daily: 10 } },
        }),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const tasks = yield* TaskService;
          const boardId = yield* mintBoardId;
          yield* sql`
            INSERT INTO board_instances (id, repo, definition_id, definition_version)
            VALUES (${boardId}, ${`caps-${tag}/board`}, 'default', 1)
          `;
          const alert = (
            scope: string,
            subject: string,
            span: string,
            threshold: number,
            startOffset: string,
            endOffset: string,
          ) => sql`
            INSERT INTO spend_alerts
              (scope, subject, span, period_start, period_end, threshold, limit_usd, spent_usd)
            VALUES (${scope}, ${subject}, ${span},
                    now() + ${startOffset}::interval, now() + ${endOffset}::interval,
                    ${threshold}, 10, ${threshold / 10})
          `;
          // The repo's day: 80 then 100 in the current window; its month: only 80; last month's
          // 100 (ended); the actor's day, current.
          yield* alert("repo", web, "day", 80, "-1 hour", "1 hour");
          yield* alert("repo", web, "day", 100, "-1 hour", "1 hour");
          yield* alert("repo", web, "month", 80, "-1 day", "1 day");
          yield* alert("repo", web, "month", 100, "-40 days", "-10 days");
          yield* alert("actor", actor, "day", 80, "-1 hour", "1 hour");

          const rows = (yield* tasks.attention(undefined))
            .map((item) => item.reason)
            .flatMap((reason) =>
              reason._tag === "spend" &&
              (reason.subject === web || reason.subject === actor)
                ? [`${reason.scope} ${reason.window} ${reason.threshold}`]
                : [],
            )
            .sort();
          // One row per cap and window, at its highest current threshold; the ended 100 is gone.
          expect(rows).toEqual([
            "actor day 80",
            "repo day 100",
            "repo month 80",
          ]);
          // Not a board's: a board's own view lists the board's cards.
          const board = yield* tasks.attention(boardId);
          expect(board.filter((item) => item.reason._tag === "spend")).toEqual(
            [],
          );
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});

/** A session that has answered, is idle, and whose spend has reached at least `usd` in the ledger. */
const settledWithSpend = (sessionId: SessionId, usd: number) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = yield* sessions.get(sessionId);
      const spent = yield* ledgerOf([sessionId]);
      if (
        !snapshot.live.busy &&
        spent >= usd - 1e-9 &&
        snapshot.entries.some(
          (entry) => entry.kind === "assistant" && entry.text !== "",
        )
      )
        return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`${sessionId} did not settle`));
  });

describe("what a cap refuses, and what it lets through", () => {
  it("refuses a mission start, and answers a retried send from the log instead of refusing it", async () => {
    const web = repoOf("mission");
    const amy = actorOf("amy-mission");
    const runtime = runtimeOver(
      await Effect.runPromise(
        capsOf({ repos: { [web]: { daily: 0.5 * RUN } } }),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          // Nothing spent yet: the session opens and its first message starts a run, whose own
          // spend crosses the cap.
          const created = yield* sessions.create({ repo: web, actor: amy });
          const requestId = `retry-${tag}`;
          const first = yield* sessions.send({
            sessionId: created.id,
            content: "go",
            requestId,
          });
          yield* settledWithSpend(created.id, RUN);

          // The client timed out and sends again with the same request id: Pi Durable answers it
          // with the submission it already holds, as it would have before the cap was reached.
          const retried = yield* sessions.send({
            sessionId: created.id,
            content: "go",
            requestId,
          });
          expect(retried.submissionId).toBe(first.submissionId);
          // A message that is new is a run, and refused.
          const fresh = yield* refusal(
            sessions.send({
              sessionId: created.id,
              content: "more",
              requestId: `fresh-${tag}`,
            }),
          );
          expect(fresh.code).toBe("budget_exceeded");
          // A mission is the dearest run there is, and is refused its start.
          const mission = yield* refusal(
            sessions.startMission({
              sessionId: created.id,
              feature: "a mission on a capped repo",
            }),
          );
          expect(mission.code).toBe("budget_exceeded");
          expect(mission.spendCap?.subject).toBe(web);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 90_000);

  it("does not refuse a steer into a run that is already going", async () => {
    const web = repoOf("steer");
    const amy = actorOf("amy-steer");
    // A turn that sleeps, so the run is still going after its first request has paid the cap.
    const runtime = runtimeOver(
      await Effect.runPromise(
        capsOf({ repos: { [web]: { daily: 0.5 * RUN } } }),
      ),
      "sleep 3 && echo faux-ok",
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({ repo: web, actor: amy });
          yield* sessions.send({ sessionId: created.id, content: "go" });
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const snapshot = yield* sessions.get(created.id);
            if (snapshot.live.busy && (yield* ledgerOf([created.id])) >= COST)
              break;
            yield* Effect.sleep(25);
          }
          expect((yield* sessions.get(created.id)).live.busy).toBe(true);
          expect(yield* ledgerOf([created.id])).toBeGreaterThanOrEqual(COST);
          // The cap is reached and the run is going: a person can still steer it.
          const steered = yield* sessions.send({
            sessionId: created.id,
            content: "wrap up",
            whenBusy: "steer",
          });
          expect(steered.placement).toBe("steer");
          // A new run is refused all the same.
          const other = yield* refusal(
            sessions.create({ repo: web, actor: amy }),
          );
          expect(other.code).toBe("budget_exceeded");
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 90_000);
});

describe("a cap an operator changes", () => {
  it("alerts afresh at the new limit's thresholds, hides the old limit's alert, and hides every alert of a cap that is removed", async () => {
    const web = repoOf("raise");
    const amy = actorOf("amy-raise");
    const limitsOf = () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ threshold: number; limitUsd: number }>`
          SELECT threshold, limit_usd FROM spend_alerts WHERE subject = ${web}
          ORDER BY limit_usd, threshold
        `;
      });
    const itemOf = () =>
      Effect.gen(function* () {
        const items = (yield* spendItems(web)).map((item) => item.reason);
        return items.flatMap((reason) =>
          reason._tag === "spend"
            ? [{ threshold: reason.threshold, limit: reason.limit }]
            : [],
        );
      });

    // One run's spend, recorded before any cap.
    const uncapped = runtimeOver(await Effect.runPromise(capsOf({})));
    let spent = 0;
    try {
      spent = await uncapped.runPromise(
        Effect.gen(function* () {
          return yield* ledgerOf([yield* runOn(web, amy)]);
        }),
      );
    } finally {
      await uncapped.dispose();
    }

    // A cap under it: the refusal raises its 80% and 100%, and the view lists the 100%.
    const low = spent / 2;
    const capped = runtimeOver(
      await Effect.runPromise(capsOf({ repos: { [web]: { daily: low } } })),
    );
    try {
      await capped.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const refused = yield* refusal(
            sessions.create({ repo: web, actor: amy }),
          );
          expect(refused.code).toBe("budget_exceeded");
          expect((yield* limitsOf()).map((row) => row.threshold)).toEqual([
            80, 100,
          ]);
          expect(yield* itemOf()).toEqual([
            { threshold: 100, limit: expect.closeTo(low, 10) },
          ]);
        }),
      );
    } finally {
      await capped.dispose();
    }

    // The operator raises it to unblock work and restarts: runs are admitted, and the old alert
    // ("reached its cap") no longer stands in the view.
    const high = 1.5 * spent;
    const raised = runtimeOver(
      await Effect.runPromise(capsOf({ repos: { [web]: { daily: high } } })),
    );
    try {
      await raised.runPromise(
        Effect.gen(function* () {
          expect(yield* itemOf()).toEqual([]);
          // Admitted, and the run crosses the new cap: its own 80% and 100% are alerts, though the
          // old limit's rows for the same window and thresholds are still there.
          yield* runOn(web, amy);
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if ((yield* limitsOf()).length >= 4) break;
            yield* Effect.sleep(25);
          }
          const rows = yield* limitsOf();
          expect(rows.map((row) => row.threshold)).toEqual([80, 100, 80, 100]);
          expect(rows[2]?.limitUsd).toBeCloseTo(high, 10);
          expect(yield* itemOf()).toEqual([
            { threshold: 100, limit: expect.closeTo(high, 10) },
          ]);
        }),
      );
    } finally {
      await raised.dispose();
    }

    // The cap is taken out of SPEND_CAPS: nothing of it stands in the view.
    const removed = runtimeOver(await Effect.runPromise(capsOf({})));
    try {
      await removed.runPromise(
        Effect.gen(function* () {
          expect(yield* itemOf()).toEqual([]);
        }),
      );
    } finally {
      await removed.dispose();
    }
  }, 120_000);
});
