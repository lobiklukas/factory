/**
 * The outcome metrics (LOB-44), proven over a seeded fixture against a hand-computed oracle.
 *
 * The fixture is rows, not runs: cards with their `task_events`, runs in `task_runs`, sessions with
 * the triggers, lineage, merges and reverts the metrics read, their spend in `session_activity`, and
 * approval decisions — every timestamp written explicitly, in March 2021, in a repo of this run's
 * own, so the window and the `repo` filter isolate it from every other suite sharing the database.
 * The read is a read of those tables (`readOutcomes`), so seeding them is seeding its whole input.
 * How a merge gets into `sessions.pr_merged_at` in the first place is the webhook's, proven where the
 * webhook is (`apps/api/src/Api/GitHubWebhook.test.ts`).
 *
 * **The oracle is written from the fixture, by hand**: each expected value below is the arithmetic
 * on the hours in the fixture's comments, not anything the query returned. A wrong window bound, a
 * dropped repo filter, a lead time from the wrong event, a run interval double-counted, a canceled
 * card treated as delivered — each moves at least one of these numbers.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import type { OutcomeReport, OutcomeValue } from "@repo/domain/Outcomes";
import { RepoSlug } from "@repo/domain/Session";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  DEFAULT_OUTCOME_WINDOW_MS,
  OUTCOME_TRIGGERS,
  readOutcomes,
  triggerOf,
} from "./outcomes";

const runtime = ManagedRuntime.make(Layer.mergeAll(DatabaseLive));
afterAll(() => runtime.dispose());

const run = randomBytes(4).toString("hex");
const repo = RepoSlug.make(`acme/outcomes-${run}`);
const elsewhere = RepoSlug.make(`acme/outcomes-other-${run}`);

/** Hour zero of the window: every fixture time is an hour offset from here. */
const T0 = Date.parse("2021-03-01T00:00:00.000Z");
const HOUR = 3_600_000;
// oxlint-disable-next-line effecttsgo/global-date -- a fixture's fixed instants, written before any runtime exists.
const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString();
/** The window: March 2021, 744 hours. */
const since = at(0);
const until = at(744);

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** Twenty-six random characters of the id alphabet: the shape every minted id has after its prefix. */
const randomId = (): string =>
  Array.from(randomBytes(26), (byte) => ALPHABET.charAt(byte % 32)).join("");
const sessionIds = new Map<string, string>();
/** The session id a fixture name stands for, minted once per name. */
const sid = (name: string): string => {
  const existing = sessionIds.get(name);
  if (existing !== undefined) return existing;
  // A real session id's shape (`ses_`, ten time characters, sixteen random), random throughout:
  // two runs of this file must never mint the same ids.
  const minted = `ses_${randomId()}`;
  sessionIds.set(name, minted);
  return minted;
};
const pr = (number: number) => `https://github.com/${repo}/pull/${number}`;

type SessionFixture = {
  readonly name: string;
  readonly createdAt: number;
  readonly requestId?: string;
  readonly actor?: string;
  readonly forkedFrom?: string;
  readonly prUrl?: string;
  readonly mergedAt?: number;
  readonly revertedAt?: number;
  readonly cost: number;
  readonly lastActivityAt?: number;
  readonly repo?: string;
};

/**
 * The sessions. Every request id carries the run, because `sessions.request_id` is unique across
 * the database. In the window ([0h, 744h)) unless said otherwise; the trigger each is counted under
 * is in its comment, and so is its spend.
 */
const SESSIONS: ReadonlyArray<SessionFixture> = [
  // Card A's runs (board): a1 4–6h, a2 5–9h and opened PR 1, merged at 20h; a3 is a run on card A
  // after that merge (30h) — a follow-up fix.
  { name: "a1", createdAt: 4, actor: "amy", cost: 0.1 },
  { name: "a2", createdAt: 5, prUrl: pr(1), mergedAt: 20, cost: 0.2 },
  // a3 and b2 were started by a scheduled automation: a board run, and no person.
  { name: "a3", createdAt: 30, actor: "automation:aut_nightly", cost: 0.1 },
  // Card B's runs (board): b1 from 20h with no finished_at, its last activity at 30h; b2 60–70h, after
  // B reached done at 50h.
  { name: "b1", createdAt: 20, actor: "carol", cost: 0.05, lastActivityAt: 30 },
  { name: "b2", createdAt: 60, actor: "automation:aut_nightly", cost: 0.05 },
  // Linear delegations. ISS-0 was delegated before the window (-50h) and merged in it (5h): 55h.
  {
    name: "l0",
    createdAt: -50,
    requestId: `trigger:linear:ISS-0-${run}:mapped`,
    actor: "trigger:linear",
    prUrl: pr(10),
    mergedAt: 5,
    cost: 9,
  },
  // ISS-1: 40h → merged 52h, 12h. Reverted at 900h, after the window: not a revert in it.
  {
    name: "l1",
    createdAt: 40,
    requestId: `trigger:linear:ISS-1-${run}:mapped`,
    actor: "trigger:linear",
    prUrl: pr(2),
    mergedAt: 52,
    revertedAt: 900,
    cost: 0.3,
  },
  // ISS-2: delegated at 60h, its own PR never merged; its re-run l2r (direct, amy) at 70h merged at
  // 82h — the issue's lead time is 60h → 82h, 22h, and the re-run recovered in 12h.
  {
    name: "l2",
    createdAt: 60,
    requestId: `trigger:linear:ISS-2-${run}:mapped`,
    actor: "trigger:linear",
    prUrl: pr(3),
    cost: 0.4,
  },
  {
    name: "l2r",
    createdAt: 70,
    forkedFrom: "l2",
    actor: "amy",
    prUrl: pr(4),
    mergedAt: 82,
    cost: 0.25,
  },
  // ISS-3: merged at 750h, after the window, so in no lead time of it.
  {
    name: "l3",
    createdAt: 90,
    requestId: `trigger:linear:ISS-3-${run}:mapped`,
    actor: "trigger:linear",
    prUrl: pr(3_3),
    mergedAt: 750,
    cost: 0.05,
  },
  // Sentry: s1 at 100h opened PR 5, merged 110h, reverted 130h; s1f (direct, bob) is a re-run of it
  // at 120h — a follow-up fix of that merge, and a re-run whose PR merged only after the window
  // (800h), so it did not recover in it.
  {
    name: "s1",
    createdAt: 100,
    requestId: `trigger:sentry:event:${run}`,
    actor: "trigger:sentry",
    prUrl: pr(5),
    mergedAt: 110,
    revertedAt: 130,
    cost: 0.5,
  },
  {
    name: "s1f",
    createdAt: 120,
    forkedFrom: "s1",
    actor: "bob",
    prUrl: pr(6),
    mergedAt: 800,
    cost: 0.2,
  },
  // Direct: a client's own request id is not a trigger.
  {
    name: "c1",
    createdAt: 150,
    requestId: `client-retry-key-${run}`,
    actor: "amy",
    cost: 0.25,
  },
  { name: "c2", createdAt: 160, actor: "amy", cost: 0.15 },
  // c3's PR merged after the window: not one of its merges.
  {
    name: "c3",
    createdAt: 170,
    actor: "bob",
    prUrl: pr(30),
    mergedAt: 760,
    cost: 0.1,
  },
  // A GitHub issue, a docs push and a review, one each.
  {
    name: "g1",
    createdAt: 200,
    requestId: `trigger:github:acme/widgets#5-${run}:mapped`,
    actor: "trigger:github",
    cost: 0.05,
  },
  {
    name: "d1",
    createdAt: 210,
    requestId: `trigger:push-acme-widgets-${run}`,
    cost: 0.05,
  },
  {
    name: "rv1",
    createdAt: 220,
    requestId: `trigger:review-acme-widgets-7-${run}`,
    cost: 0.2,
  },
  // A card-mode Linear rule's card (LOB-254), G: its one run g4 at 305h has no trigger key of its own
  // — it counts under linear, the source that filed the card — and opened PR 40, merged at 335h.
  { name: "g4", createdAt: 305, prUrl: pr(40), mergedAt: 335, cost: 0.1 },
  // Outside: merged before the window, created after it, and another repo's session in it.
  { name: "x", createdAt: -300, prUrl: pr(20), mergedAt: -250, cost: 3 },
  { name: "c4", createdAt: 800, actor: "dave", cost: 7 },
  {
    name: "z1",
    createdAt: 100,
    actor: "zed",
    prUrl: `https://github.com/${elsewhere}/pull/1`,
    mergedAt: 101,
    cost: 5,
    repo: elsewhere,
  },
];

type CardFixture = {
  readonly name: string;
  readonly createdAt: number;
  /** The moves, in order: `[hour, to]`, from the column it was filed in (`intake`). */
  readonly moves: ReadonlyArray<readonly [number, string]>;
  /** The card's runs: the session, its start, and its finish (absent: not written). */
  readonly runs: ReadonlyArray<readonly [string, number, number | undefined]>;
  /** Who filed it (its `created` event's actor; a person when absent), and its external ref. */
  readonly filedBy?: string;
  readonly externalRef?: string;
};

const PIPELINE = [
  "intake",
  "specifying",
  "planning",
  "building",
  "review",
  "done",
];

const CARDS: ReadonlyArray<CardFixture> = [
  // A: created 1h, left intake at 3h, done at 25h. Lead 24h, cycle 22h; runs a1 4–6h and a2 5–9h
  // overlap, so the factory ran 4–9h = 5h of it (a3 at 30–31h is after done, so none).
  {
    name: "A",
    createdAt: 1,
    moves: [
      [3, "specifying"],
      [5, "planning"],
      [7, "building"],
      [10, "review"],
      [25, "done"],
    ],
    runs: [
      ["a1", 4, 6],
      ["a2", 5, 9],
      ["a3", 30, 31],
    ],
  },
  // B: created 10h, left intake at 12h, done at 50h. Lead 40h, cycle 38h; b1 has no finished_at and
  // its session was last active at 30h, so 20–30h = 10h; b2 (60–70h) is after done.
  {
    name: "B",
    createdAt: 10,
    moves: [
      [12, "specifying"],
      [14, "planning"],
      [16, "building"],
      [40, "review"],
      [50, "done"],
    ],
    runs: [
      ["b1", 20, undefined],
      ["b2", 60, 70],
    ],
  },
  // C: created before the window (-100h), left intake at -90h, done at 100h. Lead 200h, cycle 190h;
  // no runs.
  {
    name: "C",
    createdAt: -100,
    moves: [
      [-90, "specifying"],
      [-80, "planning"],
      [-70, "building"],
      [-60, "review"],
      [100, "done"],
    ],
    runs: [],
  },
  // G: filed at 300h by a card-mode Linear rule for ISS-4, and moved from intake straight to done at
  // 340h. Lead 40h, but no cycle: it never moved before done. Its run g4 305–315h is 10h of factory
  // time; and ISS-4's delegation runs from the card's filing (300h) to PR 40's merge (335h), 35h.
  {
    name: "G",
    createdAt: 300,
    moves: [[340, "done"]],
    runs: [["g4", 305, 315]],
    filedBy: "trigger:linear",
    externalRef: `linear:ISS-4-${run}`,
  },
  // D: done before the window. E: canceled in it, not delivered. F: done after it.
  {
    name: "D",
    createdAt: -200,
    moves: [
      [-190, "specifying"],
      [-180, "planning"],
      [-170, "building"],
      [-160, "review"],
      [-10, "done"],
    ],
    runs: [],
  },
  {
    name: "E",
    createdAt: 30,
    moves: [
      [31, "specifying"],
      [40, "canceled"],
    ],
    runs: [],
  },
  {
    name: "F",
    createdAt: 700,
    moves: [
      [701, "specifying"],
      [702, "planning"],
      [703, "building"],
      [704, "review"],
      [800, "done"],
    ],
    runs: [],
  },
];

/** Approval decisions: two approvals and a denial in the window, and three that must not count. */
const APPROVALS: ReadonlyArray<
  readonly [
    session: string,
    requested: number,
    decision: "approved" | "denied" | undefined,
    decided: number | undefined,
  ]
> = [
  ["c1", 150.5, "approved", 151],
  ["c1", 151.5, "denied", 152],
  ["s1", 104, "approved", 105],
  // Decided before the window, still pending, and another repo's.
  ["c1", -6, "approved", -5],
  ["c2", 161, undefined, undefined],
  ["z1", 100.5, "denied", 102],
];

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const session of SESSIONS) {
    yield* sql`
      INSERT INTO sessions (id, title, repo, request_id, actor, forked_from, pr_url, pr_merged_at, pr_reverted_at, created_at)
      VALUES (
        ${sid(session.name)},
        ${`outcomes fixture ${session.name}`},
        ${session.repo ?? repo},
        ${session.requestId ?? null},
        ${session.actor ?? null},
        ${session.forkedFrom === undefined ? null : sid(session.forkedFrom)},
        ${session.prUrl ?? null},
        ${session.mergedAt === undefined ? null : at(session.mergedAt)}::timestamptz,
        ${session.revertedAt === undefined ? null : at(session.revertedAt)}::timestamptz,
        ${at(session.createdAt)}::timestamptz
      )
    `;
    yield* sql`
      INSERT INTO session_activity (session_id, status, cost_total, last_activity_at)
      VALUES (
        ${sid(session.name)},
        'idle',
        ${session.cost},
        ${at(session.lastActivityAt ?? session.createdAt + 1)}::timestamptz
      )
    `;
  }
  // Ids of the real shape (`brd_`/`tsk_` and 26 characters), as every board reader decodes them.
  const boardId = `brd_${randomId()}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${repo}, 'default', 1)
  `;
  for (const card of CARDS) {
    const taskId = `tsk_${randomId()}`;
    yield* sql`
      INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, external_ref, created_at, updated_at)
      VALUES (
        ${taskId}, ${boardId}, ${`card ${card.name}`}, ${card.moves.at(-1)?.[1] ?? "intake"},
        1, ${card.moves.length + 1}, ${card.externalRef ?? null},
        ${at(card.createdAt)}::timestamptz, ${at(card.createdAt)}::timestamptz
      )
    `;
    const filedBy = card.filedBy ?? "person:lukas";
    yield* sql`
      INSERT INTO task_events (task_id, kind, actor, revision, payload, created_at)
      VALUES (
        ${taskId}, 'created', ${filedBy}, 1,
        ${JSON.stringify({ taskId, boardId, title: `card ${card.name}`, column: "intake", actor: filedBy, revision: 1 })}::jsonb,
        ${at(card.createdAt)}::timestamptz
      )
    `;
    let from = PIPELINE[0] ?? "intake";
    for (const [index, [hour, to]] of card.moves.entries()) {
      yield* sql`
        INSERT INTO task_events (task_id, kind, actor, revision, payload, created_at)
        VALUES (
          ${taskId}, 'moved', 'person:lukas', ${index + 1},
          ${JSON.stringify({ taskId, from, to, actor: "person:lukas", revision: index + 1 })}::jsonb,
          ${at(hour)}::timestamptz
        )
      `;
      from = to;
    }
    for (const [session, started, finished] of card.runs) {
      yield* sql`
        INSERT INTO task_runs (id, task_id, session_id, "column", started_at, finished_at)
        VALUES (
          ${sid(session)}, ${taskId}, ${sid(session)}, 'building',
          ${at(started)}::timestamptz,
          ${finished === undefined ? null : at(finished)}::timestamptz
        )
      `;
    }
  }
  for (const [
    index,
    [session, requested, decision, decided],
  ] of APPROVALS.entries()) {
    yield* sql`
      INSERT INTO session_approvals (session_id, request_id, action, detail, requested_at, decision, actor, decided_at)
      VALUES (
        ${sid(session)}, ${`approval-${index}`}, 'git push', 'a gated push',
        ${at(requested)}::timestamptz,
        ${decision ?? null},
        ${decision === undefined ? null : "person:lukas"},
        ${decided === undefined ? null : at(decided)}::timestamptz
      )
    `;
  }
});

/** The ids of the 18 sessions created in the window in this repo, for the reconciliation below. */
const inWindow = SESSIONS.filter(
  (session) =>
    session.repo === undefined &&
    session.createdAt >= 0 &&
    session.createdAt < 744,
).map((session) => sid(session.name));

class Rollback {
  constructor(
    readonly report: OutcomeReport,
    readonly costColumn: number,
  ) {}
}

/**
 * Seed, read, and read LOB-17's column for the same sessions, all in one transaction that is rolled
 * back. These sessions have no commits, and a concurrent `rebuildIndexes` (SessionService.test.ts
 * shares this database) deletes the index rows of a session with none — but it cannot see rows this
 * transaction has not committed, and the rows never outlive the file.
 */
const { report, costColumn } = await runtime.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* seed;
          const read = yield* readOutcomes({ since, until, repo });
          const rows = yield* sql<{ readonly total: number }>`
            SELECT sum(cost_total)::double precision AS total
            FROM session_activity WHERE session_id = ANY(${inWindow}::text[])
          `;
          return yield* Effect.fail(
            new Rollback(read, rows[0]?.total ?? Number.NaN),
          );
        }),
      )
      .pipe(
        Effect.catchIf(
          (failure): failure is Rollback => failure instanceof Rollback,
          (rollback) =>
            Effect.succeed({
              report: rollback.report,
              costColumn: rollback.costColumn,
            }),
        ),
      );
  }),
);

const valueOf = (
  from: OutcomeReport,
  metric: string,
  name: string,
): OutcomeValue => {
  const found = from.values.find(
    (value) => value.metric === metric && value.name === name,
  );
  if (found === undefined)
    throw new Error(`no ${metric} ${name} in the report`);
  return found;
};

/** One value as the oracle states it: the number (in its unit) and the denominator's count. */
const expectValue = (
  metric: string,
  name: string,
  value: number | null,
  denominator: number,
) => {
  const reported = valueOf(report, metric, name);
  if (value === null) expect(reported.value).toBeNull();
  else expect(reported.value).toBeCloseTo(value, 9);
  expect(reported.denominator.count).toBe(denominator);
};

const hours = (count: number) => count * 3600;

describe("readOutcomes over the seeded fixture (LOB-44)", () => {
  it("states every value's window and denominator, and names its source", () => {
    expect(report.window).toEqual({ since, until });
    expect(report.repo).toBe(repo);
    expect(report.values.length).toBeGreaterThan(0);
    for (const value of report.values) {
      expect(value.window).toEqual({ since, until });
      expect(value.denominator.of).not.toBe("");
      expect(value.source).not.toBe("");
    }
    // The metric set the issue names, every one present.
    expect([...new Set(report.values.map((value) => value.metric))]).toEqual([
      "lead_time",
      "cycle_time",
      "defect_pressure",
      "recovery",
      "adoption",
      "cost",
    ]);
  });

  it("reports lead time per card and per delegated issue, and the factory's share of it", () => {
    // Cards A (24h), B (40h), C (200h) and G (40h) first reached done in the window; D before it, F
    // after it, and E was canceled.
    expectValue("lead_time", "card.median", hours(40), 4);
    expectValue("lead_time", "card.mean", hours((24 + 40 + 200 + 40) / 4), 4);
    // Run time inside each lead time: A 4–9h (5h, the overlap counted once), B 20–30h (10h), C none,
    // G 305–315h (10h).
    expectValue(
      "lead_time",
      "card.factory_share",
      (5 + 10 + 0 + 10) / (24 + 40 + 200 + 40),
      4,
    );
    // ISS-0 55h, ISS-1 12h, ISS-2 22h (through its re-run), ISS-4 35h (a card-mode delegation, from
    // the card's filing); ISS-3 merged after the window.
    expectValue("lead_time", "delegation.median", hours((22 + 35) / 2), 4);
    expectValue(
      "lead_time",
      "delegation.mean",
      hours((55 + 12 + 22 + 35) / 4),
      4,
    );
  });

  it("reports cycle time from the first move out of intake to done", () => {
    // A 3h → 25h (22h), B 12h → 50h (38h), C -90h → 100h (190h). G went from intake straight to
    // done, so it has no cycle: not a cycle of 0, and not in the denominator.
    expectValue("cycle_time", "card.median", hours(38), 3);
    expectValue("cycle_time", "card.mean", hours((22 + 38 + 190) / 3), 3);
  });

  it("reports defect pressure over the factory's merges in the window", () => {
    // Merged in the window: PR 1 (a2, 20h), PR 10 (l0, 5h), PR 2 (l1, 52h), PR 4 (l2r, 82h), PR 5
    // (s1, 110h) and PR 40 (g4, 335h). PR 20 merged before it, PRs 6, 30 and 33 after it; z1's PR is
    // another repo's. Reverted by the window's end: PR 5 (130h). PR 2's revert is at 900h, after it.
    expectValue("defect_pressure", "merges.reverted", 1, 6);
    // Followed up: PR 1 by a3 (card A's run at 30h) and PR 5 by s1f (its re-run at 120h).
    expectValue("defect_pressure", "merges.followed_up", 2, 6);
    expectValue("defect_pressure", "follow_up_sessions", 2, 6);
    // Reverted or followed up: PR 1 and PR 5.
    expectValue("defect_pressure", "rate", 2 / 6, 6);
  });

  it("reports recovery from re-runs, and the approval and refusal rates of the decisions", () => {
    // Re-runs created in the window: l2r (merged 12h later) and s1f (merged only after the window).
    expectValue("recovery", "reruns.recovered", 1 / 2, 2);
    expectValue("recovery", "reruns.median_to_merge", hours(12), 1);
    // Decided in the window, this repo: approved at 151h and 105h, denied at 152h.
    expectValue("recovery", "approvals.approved_rate", 2 / 3, 3);
    expectValue("recovery", "approvals.denied_rate", 1 / 3, 3);
  });

  it("reports adoption by trigger and repeat use by person", () => {
    // Created in the window, this repo: 18 sessions (l0, x and c4 are outside it; z1 is elsewhere).
    const byTrigger: Record<string, number> = {
      linear: 4, // l1, l2, l3, and g4: a run of the card a Linear card-mode rule filed
      sentry: 1, // s1
      github: 1, // g1
      jira: 0,
      slack: 0,
      generic: 0,
      docs: 1, // d1
      review: 1, // rv1
      other: 0,
      board: 5, // a1, a2, a3, b1, b2
      direct: 5, // l2r, s1f, c1, c2, c3
    };
    for (const trigger of OUTCOME_TRIGGERS) {
      expectValue(
        "adoption",
        `sessions.${trigger}`,
        byTrigger[trigger] ?? -1,
        18,
      );
    }
    // People: amy (a1, l2r, c1, c2), bob (s1f, c3), carol (b1) — two of the three came back. The
    // automation that started a3 and b2 is no person.
    expectValue("adoption", "actors.repeat", 2 / 3, 3);
  });

  it("reports cost that reconciles with session_activity.cost_total for the same sessions", () => {
    // The fixture's spend for the 18 sessions in the window, added by hand.
    const total =
      0.1 +
      0.2 +
      0.1 +
      0.05 +
      0.05 +
      0.3 +
      0.4 +
      0.25 +
      0.05 +
      0.5 +
      0.2 +
      0.25 +
      0.15 +
      0.1 +
      0.05 +
      0.05 +
      0.2 +
      0.1;
    expect(total).toBeCloseTo(3.1, 9);
    expectValue("cost", "total", 3.1, 18);
    expectValue("cost", "per_session", 3.1 / 18, 18);
    // And the same number LOB-17's column holds for those sessions, read in the seed's transaction
    // independently of the read.
    expect(inWindow).toHaveLength(18);
    expect(valueOf(report, "cost", "total").value).toBeCloseTo(costColumn, 9);
    expect(valueOf(report, "cost", "per_session").value).toBeCloseTo(
      costColumn / 18,
      9,
    );
  });
});

describe("readOutcomes' window", () => {
  it("is the thirty days before now when the caller names none, and empty values are null, not 0", async () => {
    // A repo nobody seeded: every denominator is 0, and every median, mean and share is `null`.
    const empty = await runtime.runPromise(
      readOutcomes({ repo: RepoSlug.make(`acme/outcomes-empty-${run}`) }),
    );
    const span =
      Date.parse(empty.window.until) - Date.parse(empty.window.since);
    expect(span).toBe(DEFAULT_OUTCOME_WINDOW_MS);
    // oxlint-disable-next-line effecttsgo/global-date -- the read's default is the real clock's now.
    expect(Math.abs(Date.parse(empty.window.until) - Date.now())).toBeLessThan(
      60_000,
    );
    expect(valueOf(empty, "lead_time", "card.median").value).toBeNull();
    expect(valueOf(empty, "defect_pressure", "rate").value).toBeNull();
    expect(valueOf(empty, "adoption", "actors.repeat").value).toBeNull();
    expect(valueOf(empty, "cost", "per_session").value).toBeNull();
    // A count of nothing is a count: zero, with its denominator.
    expect(valueOf(empty, "adoption", "sessions.linear").value).toBe(0);
  }, 30_000);

  it("refuses a window that is not one, naming it", async () => {
    const backwards = await runtime.runPromiseExit(
      readOutcomes({ since: until, until: since, repo }),
    );
    expect(JSON.stringify(backwards)).toContain("invalid_input");
    const garbled = await runtime.runPromiseExit(
      readOutcomes({ since: "last tuesday", repo }),
    );
    expect(JSON.stringify(garbled)).toContain(
      "since is not an ISO-8601 instant",
    );
  }, 30_000);
});

describe("triggerOf", () => {
  it("reads the trigger from a session's request id, and a card's run as the board", () => {
    expect(triggerOf("trigger:linear:abc:mapped", false)).toBe("linear");
    expect(triggerOf("trigger:sentry:event:e1", false)).toBe("sentry");
    expect(triggerOf("trigger:jira:created:WID-1:1700", false)).toBe("jira");
    expect(triggerOf("trigger:slack:C1:1.2:1.3", false)).toBe("slack");
    expect(triggerOf("trigger:generic:t-1", false)).toBe("generic");
    expect(triggerOf("trigger:github:acme/w#1:mapped", false)).toBe("github");
    expect(triggerOf("trigger:push-acme-w-0123", false)).toBe("docs");
    expect(triggerOf("trigger:schedule-acme-w-1700", false)).toBe("docs");
    expect(triggerOf("trigger:review-acme-w-7-abc", false)).toBe("review");
    // A source the seam does not know, and a delivery id with no source at all.
    expect(triggerOf("trigger:pagerduty:x", false)).toBe("other");
    expect(triggerOf("trigger:linear", false)).toBe("other");
    // A trigger key wins over the card: a review run is a card's run the review trigger started.
    expect(triggerOf("trigger:review-acme-w-7-abc", true)).toBe("review");
    expect(triggerOf(null, true)).toBe("board");
    expect(triggerOf("client-key", true)).toBe("board");
    // A card a card-mode rule filed counts its runs under that rule's source (LOB-254); a card a
    // person filed, or an actor that names no known source, is the board's.
    expect(triggerOf(null, true, "trigger:linear")).toBe("linear");
    expect(triggerOf(null, true, "trigger:sentry")).toBe("sentry");
    expect(triggerOf(null, true, "person:lukas")).toBe("board");
    expect(triggerOf(null, true, "trigger:pagerduty")).toBe("board");
    expect(triggerOf(null, false, "trigger:linear")).toBe("direct");
    expect(triggerOf(null, false)).toBe("direct");
    expect(triggerOf("client-key", false)).toBe("direct");
  });
});
