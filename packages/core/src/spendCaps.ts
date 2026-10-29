/**
 * Aggregate spend caps (S-aggregate-spend-caps): how many dollars one repository, or one actor,
 * may spend in a UTC day or month before a new run on them is refused, and the alerts on the way.
 *
 * A session's own cap (`SESSION_BUDGET`, C23) stops one run; this one is a ceiling over many
 * sessions, set by the deployment (`SPEND_CAPS`, read by `apps/api`) because a cap a repository
 * declares for itself is one anybody who can push to it can raise.
 *
 * **Spend** is what `spend_ledger` holds: one row per increase of a session's `cost_total`, written
 * by `SessionService` in the statement that moves it, attributed to the repository and actor the
 * session carries (`sessions.repo`, `sessions.actor`). Its windows are the current UTC calendar day
 * and month, so every process and every verify drive agree on where one ends, whatever its locale.
 * A repository's spend is every actor's on it; an actor's is every repository's they ran on.
 * A session with no repository is counted for its actor only, and one with no actor for its
 * repository only.
 *
 * **Refusal.** `SessionService` asks `checkSpendCaps` where a run would start (`create`) and where
 * a message would start one (`send`), before anything is written or any model is called: the first
 * cap whose window's spend has reached its limit is `budget_exceeded` (`./admission`), repository
 * before actor and the day before the month. A run already under way is not stopped by it — it has
 * its own budget — so a cap is reached by a run that crosses it and held against the next one,
 * the way every vendor's spend limit works. Runs on other repositories, and by other actors, count
 * their own spend and are unaffected.
 *
 * **Alerts.** `raiseSpendAlerts` runs after spend is recorded and when a request is refused: each
 * threshold of each cap (80% and 100%) the window's spend has reached gets one `spend_alerts` row,
 * written once by `ON CONFLICT DO NOTHING`, so crossing 80% is one attention item however many
 * requests follow it. The limit is part of the alert's key: a cap an operator raises mid-window
 * alerts afresh at its own 80% and 100%. The attention view lists the highest threshold of each cap
 * and window, while that cap and limit are the configured ones (`syncSpendCapLimits`) and until the
 * window ends, and the notifier tells a person of each one (`spend` kind).
 */
import { DateTime, Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { SqlClient } from "effect/sql/SqlClient";
import {
  RepoSlug,
  type SpendCap,
  type SpendCapScope,
  type SpendCapWindow,
} from "@repo/domain/Session";

/** The configuration key the caps are read from (`apps/api`). */
export const SPEND_CAPS = "SPEND_CAPS";

/** The thresholds, in percent of a cap, an alert is raised at. */
export const SPEND_ALERT_THRESHOLDS: ReadonlyArray<number> = [80, 100];

/**
 * Whether `spent` has reached `percent` of `limit`. Spend is a sum of fractions of a cent, so ten
 * runs of a cent each can add up to a hair under the dollar-tenth they are worth: a tolerance of a
 * billionth of a dollar keeps a cap from being missed by rounding, and is far under any real spend.
 */
export const reachedCap = (
  spent: number,
  limit: number,
  percent = 100,
): boolean => spent * 100 + 1e-7 >= limit * percent;

const Dollars = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)));

/** One subject's limits, in US dollars; at least one of the two. */
const SpendLimits = Schema.Struct({
  daily: Schema.optional(Dollars),
  monthly: Schema.optional(Dollars),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (limits) =>
        limits.daily !== undefined || limits.monthly !== undefined
          ? undefined
          : "an entry needs a daily or a monthly limit",
      { title: "SpendLimits" },
    ),
  ),
);
export type SpendLimits = typeof SpendLimits.Type;

/**
 * The shape of `SPEND_CAPS`: JSON, `{"repos": {"acme/web": {"daily": 20, "monthly": 300}},
 * "actors": {"alice": {"daily": 5}}}`. A key it does not know is refused, not ignored: a `"dayly"`
 * that silently capped nothing is a spend nobody limited. So is a repository that is not a
 * `RepoSlug` (lowercase `owner/name`, as `sessions.repo` holds it): `"Acme/Web"` would never match
 * a session and so would cap nothing.
 */
const SpendCapsConfig = Schema.Struct({
  repos: Schema.optional(Schema.Record(RepoSlug, SpendLimits)),
  actors: Schema.optional(Schema.Record(Schema.String, SpendLimits)),
});

/** The caps a deployment configured, by repository slug and by actor. */
export type SpendCaps = {
  readonly repos: ReadonlyMap<string, SpendLimits>;
  readonly actors: ReadonlyMap<string, SpendLimits>;
};

/** No caps: what a deployment that never sets `SPEND_CAPS` runs under. */
export const NO_SPEND_CAPS: SpendCaps = { repos: new Map(), actors: new Map() };

/** `SPEND_CAPS` that does not read: the message says what was wrong with it. */
export class SpendCapsConfigError extends Schema.TaggedError<SpendCapsConfigError>()(
  "SpendCapsConfigError",
  { message: Schema.String },
) {}

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SpendCapsConfig),
  { onExcessProperty: "error" },
);

/** Parse `SPEND_CAPS`. Blank is no caps; anything else that is not the shape above is refused. */
export const parseSpendCaps = (
  raw: string,
): Effect.Effect<SpendCaps, SpendCapsConfigError> =>
  raw.trim() === ""
    ? Effect.succeed(NO_SPEND_CAPS)
    : decodeConfig(raw).pipe(
        Effect.map((config) => ({
          repos: new Map(Object.entries(config.repos ?? {})),
          actors: new Map(Object.entries(config.actors ?? {})),
        })),
        Effect.mapError(
          (cause) =>
            new SpendCapsConfigError({
              message: `${SPEND_CAPS} is not valid: ${String(cause)}`,
            }),
        ),
      );

/** Whether any cap is configured. */
export const hasSpendCaps = (caps: SpendCaps): boolean =>
  caps.repos.size > 0 || caps.actors.size > 0;

/** One limit that applies to a request, with where it is configured. */
export type SpendRule = {
  readonly scope: SpendCapScope;
  readonly subject: string;
  readonly window: SpendCapWindow;
  readonly limit: number;
  readonly source: string;
};

/**
 * The limits that apply to a request on `repo` by `actor`, in the order a refusal names them:
 * the repository's day, its month, then the actor's day and month.
 */
export const rulesFor = (
  caps: SpendCaps,
  who: {
    readonly repo: string | undefined;
    readonly actor: string | undefined;
  },
): ReadonlyArray<SpendRule> => {
  const rules: SpendRule[] = [];
  const add = (
    scope: SpendCapScope,
    subject: string | undefined,
    table: ReadonlyMap<string, SpendLimits>,
  ) => {
    const limits = subject === undefined ? undefined : table.get(subject);
    if (subject === undefined || limits === undefined) return;
    const key = scope === "repo" ? "repos" : "actors";
    const entry = `${SPEND_CAPS} ${key}[${JSON.stringify(subject)}]`;
    if (limits.daily !== undefined)
      rules.push({
        scope,
        subject,
        window: "day",
        limit: limits.daily,
        source: `${entry}.daily`,
      });
    if (limits.monthly !== undefined)
      rules.push({
        scope,
        subject,
        window: "month",
        limit: limits.monthly,
        source: `${entry}.monthly`,
      });
  };
  add("repo", who.repo, caps.repos);
  add("actor", who.actor, caps.actors);
  return rules;
};

/** Every limit configured, in the order a refusal names them. */
const allRules = (caps: SpendCaps): ReadonlyArray<SpendRule> => [
  ...[...caps.repos.keys()].flatMap((repo) =>
    rulesFor(caps, { repo, actor: undefined }),
  ),
  ...[...caps.actors.keys()].flatMap((actor) =>
    rulesFor(caps, { repo: undefined, actor }),
  ),
];

/**
 * Record the caps this process runs under in `spend_cap_limits`, replacing what was there. The
 * attention view lists an alert only while its cap and limit are in that table, so one whose cap
 * was raised, lowered or removed (and the process restarted) stops standing for a refusal that no
 * longer holds, and one raised again after a change is a new alert, not a stale row's.
 */
export const syncSpendCapLimits = (
  caps: SpendCaps,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM spend_cap_limits`;
        for (const rule of allRules(caps))
          yield* sql`
            INSERT INTO spend_cap_limits (scope, subject, span, limit_usd)
            VALUES (${rule.scope}, ${rule.subject}, ${rule.window}, ${rule.limit})
            ON CONFLICT (scope, subject, span) DO UPDATE SET limit_usd = EXCLUDED.limit_usd
          `;
      }),
    );
  });

/** The current UTC day or month: where it starts and where the next one does, as ISO instants. */
export const windowBounds = (
  window: SpendCapWindow,
  nowMs: number,
): { readonly start: string; readonly end: string } => {
  const start = DateTime.startOf(DateTime.makeUnsafe(nowMs), window);
  const end = DateTime.add(
    start,
    window === "day" ? { days: 1 } : { months: 1 },
  );
  return { start: DateTime.formatIso(start), end: DateTime.formatIso(end) };
};

/** What one subject has spent so far in the current day and month. */
export type WindowSpend = {
  readonly day: number;
  readonly month: number;
};

/** The ledger's sum for one subject over the current UTC day and month. */
export const spentBy = (
  scope: SpendCapScope,
  subject: string,
  nowMs: number,
): Effect.Effect<WindowSpend, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const day = windowBounds("day", nowMs).start;
    const month = windowBounds("month", nowMs).start;
    const rows = yield* sql<{ day: number; month: number }>`
      SELECT
        COALESCE(sum(usd) FILTER (WHERE at >= ${day}::timestamptz), 0)::double precision AS day,
        COALESCE(sum(usd), 0)::double precision AS month
      FROM spend_ledger
      WHERE ${scope === "repo" ? sql`repo` : sql`actor`} = ${subject}
        AND at >= ${month}::timestamptz
    `;
    return { day: rows[0]?.day ?? 0, month: rows[0]?.month ?? 0 };
  });

/** The spend of every subject a request names, read once per subject. */
const spendOf = (
  rules: ReadonlyArray<SpendRule>,
  nowMs: number,
): Effect.Effect<ReadonlyMap<string, WindowSpend>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const spend = new Map<string, WindowSpend>();
    for (const rule of rules) {
      const key = `${rule.scope}\u0000${rule.subject}`;
      if (spend.has(key)) continue;
      spend.set(key, yield* spentBy(rule.scope, rule.subject, nowMs));
    }
    return spend;
  });

const spentFor = (
  spend: ReadonlyMap<string, WindowSpend>,
  rule: SpendRule,
): number =>
  spend.get(`${rule.scope}\u0000${rule.subject}`)?.[rule.window] ?? 0;

/**
 * The first cap the request would exceed, or `undefined` to go ahead: a cap is reached when its
 * window's spend is at its limit, so a limit of $20 refuses the first run started once $20 has been
 * spent, not the run that spends the last of it.
 */
export const firstSpendCapHit = (
  rules: ReadonlyArray<SpendRule>,
  spend: ReadonlyMap<string, WindowSpend>,
  nowMs: number,
): SpendCap | undefined => {
  for (const rule of rules) {
    const spent = spentFor(spend, rule);
    if (!reachedCap(spent, rule.limit)) continue;
    const resetsAt = windowBounds(rule.window, nowMs).end;
    return {
      scope: rule.scope,
      subject: rule.subject,
      window: rule.window,
      limit: rule.limit,
      spent,
      source: rule.source,
      resetsAt,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((Date.parse(resetsAt) - nowMs) / 1000),
      ),
    };
  }
  return undefined;
};

/** The cap a request on `repo` by `actor` would exceed right now, or `undefined`. */
export const checkSpendCaps = (
  caps: SpendCaps,
  who: {
    readonly repo: string | undefined;
    readonly actor: string | undefined;
  },
  nowMs: number,
): Effect.Effect<SpendCap | undefined, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const rules = rulesFor(caps, who);
    if (rules.length === 0) return undefined;
    return firstSpendCapHit(rules, yield* spendOf(rules, nowMs), nowMs);
  });

/** An alert a crossing wrote, as the log line and the tests name it. */
export type SpendAlert = {
  readonly scope: SpendCapScope;
  readonly subject: string;
  readonly window: SpendCapWindow;
  readonly threshold: number;
};

/**
 * Write the alert of every threshold the spend on `repo` / `actor` has reached, once: the rows that
 * already exist are left alone, so the answer is only the crossings this call made.
 */
export const raiseSpendAlerts = (
  caps: SpendCaps,
  who: {
    readonly repo: string | undefined;
    readonly actor: string | undefined;
  },
  nowMs: number,
): Effect.Effect<ReadonlyArray<SpendAlert>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const rules = rulesFor(caps, who);
    if (rules.length === 0) return [];
    const sql = yield* SqlClient;
    const spend = yield* spendOf(rules, nowMs);
    const raised: SpendAlert[] = [];
    for (const rule of rules) {
      const spent = spentFor(spend, rule);
      const bounds = windowBounds(rule.window, nowMs);
      for (const threshold of SPEND_ALERT_THRESHOLDS) {
        if (!reachedCap(spent, rule.limit, threshold)) continue;
        const inserted = yield* sql<{ threshold: number }>`
          INSERT INTO spend_alerts
            (scope, subject, span, period_start, period_end, threshold, limit_usd, spent_usd)
          VALUES (${rule.scope}, ${rule.subject}, ${rule.window},
                  ${bounds.start}::timestamptz, ${bounds.end}::timestamptz,
                  ${threshold}, ${rule.limit}, ${spent})
          ON CONFLICT DO NOTHING
          RETURNING threshold
        `;
        if (inserted.length > 0)
          raised.push({
            scope: rule.scope,
            subject: rule.subject,
            window: rule.window,
            threshold,
          });
      }
    }
    return raised;
  });
