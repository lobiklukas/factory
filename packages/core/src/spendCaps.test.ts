/**
 * Aggregate spend caps' arithmetic (S-aggregate-spend-caps): how `SPEND_CAPS` parses, where a UTC
 * day and month start and end, what the ledger sums into each, and which cap a request hits first.
 *
 * The window cases run against the real ledger with rows at chosen instants and a chosen "now", so
 * a boundary that moved by a day, or a month that counted another year's, changes an answer. Every
 * repository is this run's own (a random tag); the rows are removed afterwards.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { randomBytes } from "node:crypto";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Exit, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkSpendCaps,
  firstSpendCapHit,
  parseSpendCaps,
  reachedCap,
  raiseSpendAlerts,
  rulesFor,
  spentBy,
  windowBounds,
  type SpendCaps,
} from "./spendCaps";

const parse = (raw: string): Promise<SpendCaps> =>
  Effect.runPromise(parseSpendCaps(raw));

const failure = async (raw: string): Promise<string> => {
  const exit = await Effect.runPromiseExit(parseSpendCaps(raw));
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  return String(exit.cause);
};

describe("parsing SPEND_CAPS", () => {
  it("reads repo and actor limits, and blank is no caps", async () => {
    const caps = await parse(
      '{"repos":{"acme/web":{"daily":20,"monthly":300}},"actors":{"alice":{"daily":5}}}',
    );
    expect(caps.repos.get("acme/web")).toEqual({ daily: 20, monthly: 300 });
    expect(caps.actors.get("alice")).toEqual({ daily: 5 });
    const none = await parse("  ");
    expect(none.repos.size + none.actors.size).toBe(0);
    expect((await parse("{}")).repos.size).toBe(0);
  });

  it("refuses what would silently cap nothing", async () => {
    // A misspelled key, a limit of zero or less, an entry with no limit, and text that is no JSON.
    expect(await failure('{"repos":{"a/b":{"dayly":5}}}')).toContain("dayly");
    expect(await failure('{"repo":{"a/b":{"daily":5}}}')).toContain("repo");
    expect(await failure('{"repos":{"a/b":{"daily":0}}}')).toContain(
      "SPEND_CAPS",
    );
    expect(await failure('{"repos":{"a/b":{"daily":-3}}}')).toContain(
      "SPEND_CAPS",
    );
    expect(await failure('{"repos":{"a/b":{}}}')).toContain(
      "daily or a monthly",
    );
    expect(await failure("20")).toContain("SPEND_CAPS");
    expect(await failure("{nope")).toContain("SPEND_CAPS");
  });
});

describe("the rules a request meets", () => {
  it("names the repository's day and month, then the actor's, with where each is configured", async () => {
    const caps = await parse(
      '{"repos":{"acme/web":{"daily":20,"monthly":300}},"actors":{"alice":{"monthly":50}}}',
    );
    expect(
      rulesFor(caps, { repo: "acme/web", actor: "alice" }).map((r) => [
        r.scope,
        r.window,
        r.limit,
        r.source,
      ]),
    ).toEqual([
      ["repo", "day", 20, 'SPEND_CAPS repos["acme/web"].daily'],
      ["repo", "month", 300, 'SPEND_CAPS repos["acme/web"].monthly'],
      ["actor", "month", 50, 'SPEND_CAPS actors["alice"].monthly'],
    ]);
    // Another repo and another actor meet none; a request naming neither meets none.
    expect(rulesFor(caps, { repo: "acme/api", actor: "bob" })).toEqual([]);
    expect(rulesFor(caps, { repo: undefined, actor: undefined })).toEqual([]);
  });
});

describe("the UTC windows", () => {
  it("a day runs midnight to midnight and a month first to first, across a year end", () => {
    const at = Date.parse("2026-12-31T23:59:59.999Z");
    expect(windowBounds("day", at).start).toBe("2026-12-31T00:00:00.000Z");
    expect(windowBounds("day", at).end).toBe("2027-01-01T00:00:00.000Z");
    expect(windowBounds("month", at).start).toBe("2026-12-01T00:00:00.000Z");
    expect(windowBounds("month", at).end).toBe("2027-01-01T00:00:00.000Z");
    // The first instant of a day belongs to that day, not the one before.
    const midnight = Date.parse("2026-03-01T00:00:00.000Z");
    expect(windowBounds("day", midnight).start).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(windowBounds("month", midnight).end).toBe(
      "2026-04-01T00:00:00.000Z",
    );
  });

  it("a cap is reached at its limit, with a tolerance for a cent's rounding", () => {
    expect(reachedCap(20, 20)).toBe(true);
    expect(reachedCap(19.99, 20)).toBe(false);
    // Ten cents added ten times is 0.09999999999999999, which is the dollar-tenth it is worth.
    expect(
      Array.from({ length: 10 }, () => 0.01).reduce((a, b) => a + b),
    ).toBeLessThan(0.1);
    expect(reachedCap(0.09999999999999999, 0.1)).toBe(true);
    expect(reachedCap(16, 20, 80)).toBe(true);
    expect(reachedCap(15.99, 20, 80)).toBe(false);
  });
});

const tag = randomBytes(4).toString("hex");
const runtime = ManagedRuntime.make(DatabaseLive);

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM spend_ledger WHERE repo LIKE ${`windows-${tag}/%`} OR actor LIKE ${`%-${tag}`}`;
      yield* sql`DELETE FROM spend_alerts WHERE subject LIKE ${`%${tag}%`}`;
    }),
  );
  await runtime.dispose();
});

const credit = (repo: string, actor: string, usd: number, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO spend_ledger (session_id, repo, actor, usd, at)
      VALUES (${`ses_${tag}`}, ${repo}, ${actor}, ${usd}, ${at}::timestamptz)
    `;
  });

describe("what the ledger sums into a window", () => {
  const repo = `windows-${tag}/web`;
  const alice = `alice-${tag}`;
  const bob = `bob-${tag}`;

  it("counts a day's and a month's spend by repo and by actor, at the boundaries", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        // Last month's final second, this month's first second, yesterday, and this afternoon.
        yield* credit(repo, alice, 1000, "2026-03-31T23:59:59Z");
        yield* credit(repo, alice, 7, "2026-04-01T00:00:01Z");
        yield* credit(repo, bob, 11, "2026-04-02T09:00:00Z");
        yield* credit(repo, alice, 13, "2026-04-02T15:00:00Z");
        // Another repo, which no cap on this one may count.
        yield* credit(`windows-${tag}/api`, alice, 500, "2026-04-02T15:00:00Z");
        const now = Date.parse("2026-04-02T18:00:00Z");

        const web = yield* spentBy("repo", repo, now);
        expect(web).toEqual({ day: 24, month: 31 });
        const amy = yield* spentBy("actor", alice, now);
        expect(amy).toEqual({ day: 513, month: 520 });
        // The next day's window is empty for the day, and still holds the month.
        expect(
          yield* spentBy("repo", repo, Date.parse("2026-04-03T00:00:00Z")),
        ).toEqual({
          day: 0,
          month: 31,
        });
        // And the month after is empty altogether.
        expect(
          yield* spentBy("repo", repo, Date.parse("2026-05-01T00:00:00Z")),
        ).toEqual({
          day: 0,
          month: 0,
        });
      }),
    );
  });

  it("refuses at the first cap reached — the repo before the actor, the day before the month — and lets an unaffected request through", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const caps = yield* parseSpendCaps(
          JSON.stringify({
            repos: { [repo]: { daily: 24, monthly: 1000 } },
            actors: { [alice]: { monthly: 100 } },
          }),
        ).pipe(Effect.orDie);
        const now = Date.parse("2026-04-02T18:00:00Z");
        const hit = yield* checkSpendCaps(caps, { repo, actor: alice }, now);
        expect(hit?.scope).toBe("repo");
        expect(hit?.window).toBe("day");
        expect(hit?.spent).toBe(24);
        expect(hit?.resetsAt).toBe("2026-04-03T00:00:00.000Z");
        // The same cap, a day later: only the actor's month (520 of 100) is over.
        const later = yield* checkSpendCaps(
          caps,
          { repo, actor: alice },
          Date.parse("2026-04-03T08:00:00Z"),
        );
        expect(later?.scope).toBe("actor");
        expect(later?.window).toBe("month");
        expect(later?.resetsAt).toBe("2026-05-01T00:00:00.000Z");
        // Bob has no cap and the repo's day is over: still refused, by the repo's.
        expect(
          (yield* checkSpendCaps(caps, { repo, actor: bob }, now))?.scope,
        ).toBe("repo");
        // Another repository, and nobody: nothing to refuse.
        expect(
          yield* checkSpendCaps(
            caps,
            { repo: `windows-${tag}/api`, actor: bob },
            now,
          ),
        ).toBeUndefined();
        expect(
          yield* checkSpendCaps(
            caps,
            { repo: undefined, actor: undefined },
            now,
          ),
        ).toBeUndefined();
        // A limit one cent above the spend lets the request through.
        const roomy = yield* parseSpendCaps(
          JSON.stringify({ repos: { [repo]: { daily: 24.01 } } }),
        ).pipe(Effect.orDie);
        expect(
          yield* checkSpendCaps(roomy, { repo, actor: bob }, now),
        ).toBeUndefined();
        expect(firstSpendCapHit([], new Map(), now)).toBeUndefined();
      }),
    );
  });

  it("writes each threshold's alert once per window, and again in the next window", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const alerts = `windows-${tag}/alerts`;
        const caps = yield* parseSpendCaps(
          JSON.stringify({ repos: { [alerts]: { daily: 10 } } }),
        ).pipe(Effect.orDie);
        const sql = yield* SqlClient;
        const who = { repo: alerts, actor: undefined };
        const day1 = Date.parse("2026-06-10T08:00:00Z");
        yield* credit(alerts, alice, 7, "2026-06-10T07:00:00Z");
        expect(yield* raiseSpendAlerts(caps, who, day1)).toEqual([]);
        yield* credit(alerts, alice, 1.5, "2026-06-10T07:30:00Z");
        // 8.5 of 10: 80% crossed. A second look at the same spend writes nothing.
        expect(
          (yield* raiseSpendAlerts(caps, who, day1)).map((a) => a.threshold),
        ).toEqual([80]);
        expect(yield* raiseSpendAlerts(caps, who, day1)).toEqual([]);
        yield* credit(alerts, alice, 2, "2026-06-10T07:45:00Z");
        expect(
          (yield* raiseSpendAlerts(caps, who, day1)).map((a) => a.threshold),
        ).toEqual([100]);
        expect(yield* raiseSpendAlerts(caps, who, day1)).toEqual([]);
        // The next day starts at nothing: no alert, and the next crossing is a new one.
        const day2 = Date.parse("2026-06-11T08:00:00Z");
        expect(yield* raiseSpendAlerts(caps, who, day2)).toEqual([]);
        yield* credit(alerts, alice, 9, "2026-06-11T07:00:00Z");
        expect(
          (yield* raiseSpendAlerts(caps, who, day2)).map((a) => a.threshold),
        ).toEqual([80]);
        const rows = yield* sql<{ n: number }>`
          SELECT count(*)::int AS n FROM spend_alerts WHERE subject = ${alerts}
        `;
        expect(rows[0]?.n).toBe(3);
      }),
    );
  });
});
