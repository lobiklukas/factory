/**
 * Outcome metrics (LOB-44): is the factory accelerating delivery? The definitions, and the one read
 * that derives them (`readOutcomes`), over the index tables and the board's card history — never a
 * fold of a log (R6), and never a read of GitHub or Linear: a merge is what the webhook recorded on
 * the session (`factory.merge` → `sessions.pr_merged_at`, `pr_reverted_at`).
 *
 * Every value carries its window `[since, until)` and its denominator (`@repo/domain/Outcomes`).
 * What each one is, exactly — the oracle in `outcomes.test.ts` is written from these sentences:
 *
 * **Lead time** (`lead_time`).
 * - `card.median`, `card.mean`: over the cards whose *first* move into `done` falls in the window,
 *   from the card's `created` event to that move (`task_events`). `canceled` is terminal but is not
 *   delivery, so a canceled card is in no denominator here.
 * - `card.factory_share`: of those cards' summed lead time, the share their runs were running — the
 *   union of each card's run intervals (`task_runs.started_at` to `finished_at`, the run's last
 *   idle; its session's last activity for a run with none), clipped to the card's lead time. A
 *   union, so two runs at once are not twice the time.
 * - `delegation.median`, `delegation.mean`: over the Linear issues whose delegation first reached a
 *   merged PR in the window, from the delegation to the first merge among its sessions and their
 *   re-runs (sessions forked from them, transitively). A session-mode rule's delegation is the
 *   session it opened (`request_id` `trigger:linear:<issue>:mapped`), from its creation; a card-mode
 *   rule's (LOB-254) is the card it filed (filed by `trigger:linear`, external ref
 *   `linear:<issue>`), from the card's creation, and its sessions are the card's runs.
 *
 * **Cycle time** (`cycle_time`): `card.median`, `card.mean` — the same cards as lead time, from the
 * card's first move (out of the column it was filed in, `intake` on the default pipeline) to its
 * first move into `done`. A card that never moved before `done` — its first move was the one into
 * `done` — has no cycle and is not counted here, though its lead time is.
 *
 * **Defect pressure** (`defect_pressure`), over the factory's merges in the window — distinct PRs a
 * session recorded (`pr_url`) whose merge (`pr_merged_at`) falls in it:
 * - `merges.reverted`: how many were reverted by `until` (`pr_reverted_at`: a later merged PR whose
 *   body said `Reverts owner/repo#N`, which the webhook recorded on the reverted PR's sessions).
 * - `merges.followed_up`: how many had a follow-up fix session — a session created after the merge
 *   and before `until` that is either forked from one of the PR's sessions or another run of the
 *   same card (`sessions.forked_from`, `task_runs.task_id`).
 * - `follow_up_sessions`: those follow-up sessions, counted once each.
 * - `rate`: the share of merges that were reverted or followed up.
 *
 * **Recovery** (`recovery`):
 * - `reruns.recovered`: of the re-runs created in the window (`forked_from` set), the share that
 *   reached a merged PR by `until`.
 * - `reruns.median_to_merge`: over those that did, from the re-run's creation to its merge.
 * - `approvals.approved_rate`, `approvals.denied_rate`: of the approval decisions taken in the
 *   window (`session_approvals.decided_at`), the share approved and the share denied — the denied
 *   share is the refusal rate a person applied to the factory's gated calls (LOB-9). A policy
 *   `block` (LOB-8) is a tool result in the log, indexed nowhere, so it is not in this read.
 *
 * **Adoption** (`adoption`), over the sessions created in the window:
 * - `sessions.<trigger>`: how many each trigger started, from `request_id` (`triggerOf`): a seam
 *   delivery's source (`linear`, `sentry`, `github`, `jira`, `slack`, `generic`), the docs trigger,
 *   the review trigger, any other delivery, a card's run (`board`), or a client asking directly
 *   (`direct`: the CLI, the dashboard, a fork or a replay). A run of a card a card-mode rule filed
 *   (LOB-254) counts under that rule's source — the card's `created` event names `trigger:<source>`
 *   as its actor — and a run of a card anybody else filed under `board`.
 * - `actors.repeat`: of the people who started a session in the window (`sessions.actor`, not a
 *   trigger's `trigger:<source>`), the share who started more than one.
 *
 * **Cost** (`cost`), over the same sessions: `total` and `per_session`, in the dollars
 * `session_activity.cost_total` holds (LOB-17) — the list's own number, so the two reconcile.
 *
 * A median of an even count is the mean of the middle two. Every duration is in seconds.
 *
 * Known limits: the read loads every session created before `until` (a merge, revert or follow-up
 * in the window can belong to one created long before it), so its cost grows with the deployment's
 * history rather than with the window; and `card.factory_share` reads `task_runs.finished_at`,
 * which no log backs (docs/metrics.md, docs/design.md D7).
 */
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type {
  OutcomeMetric,
  OutcomeReport,
  OutcomesInput,
  OutcomeUnit,
  OutcomeValue,
  OutcomeWindow,
} from "@repo/domain/Outcomes";
import { SessionError } from "@repo/domain/Session";
import { TriggerSource } from "@repo/domain/Trigger";
import { linearIssueOfExternalRef } from "./Linear";

/** The window when the caller names none: the thirty days before `until`. */
export const DEFAULT_OUTCOME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How a session came to exist, for adoption: the triggers, in the order the report lists them. */
export const OUTCOME_TRIGGERS = [
  "linear",
  "sentry",
  "github",
  "jira",
  "slack",
  "generic",
  "docs",
  "review",
  "other",
  "board",
  "direct",
] as const;
export type OutcomeTrigger = (typeof OUTCOME_TRIGGERS)[number];

const isTriggerSource = Schema.is(TriggerSource);

/** The trigger source an actor names, when it is a trigger's (`trigger:<source>`, LOB-162). */
const sourceOfActor = (actor: string | null): TriggerSource | undefined => {
  const source =
    actor?.startsWith("trigger:") === true
      ? actor.slice("trigger:".length)
      : undefined;
  return source !== undefined && isTriggerSource(source) ? source : undefined;
};

/**
 * The trigger a session came from, by its `request_id`, whether it is a card's run, and who filed
 * that card.
 *
 * A seam delivery's session is `trigger:<delivery id>` (`sessionRequestIdOf`), and a delivery id
 * starts with its source (`linear:<issue>:mapped`, `sentry:event:<id>`, …); the docs trigger's are
 * `push-…` and `schedule-…`, the review trigger's `review-…`. A session with no `trigger:` key is a
 * card's run when one is recorded for it — counted under the source whose card-mode rule filed the
 * card (`cardFiledBy` is `trigger:<source>`, LOB-254), and otherwise under `board` — and otherwise
 * a client's own call.
 */
export const triggerOf = (
  requestId: string | null,
  cardRun: boolean,
  cardFiledBy: string | null = null,
): OutcomeTrigger => {
  if (requestId?.startsWith("trigger:") === true) {
    const delivery = requestId.slice("trigger:".length);
    const source = delivery.split(":", 1)[0] ?? "";
    if (delivery.includes(":") && isTriggerSource(source)) return source;
    if (delivery.startsWith("push-") || delivery.startsWith("schedule-"))
      return "docs";
    if (delivery.startsWith("review-")) return "review";
    return "other";
  }
  if (!cardRun) return "direct";
  return sourceOfActor(cardFiledBy) ?? "board";
};

/** The Linear issue a delegated session was opened for, from its seam key. */
const LINEAR_DELEGATION = /^trigger:linear:(.+):mapped$/;

/** One card that first reached `done` in the window, in epoch milliseconds. */
export type OutcomeCard = {
  readonly id: string;
  readonly createdMs: number;
  readonly firstMovedMs: number | null;
  readonly doneMs: number;
  /** Its runs, each from its start to its end (`finished_at`, else its session's last activity). */
  readonly runs: ReadonlyArray<{
    readonly startedMs: number;
    readonly endedMs: number | null;
  }>;
};

/** One session the index holds, created before `until`. */
export type OutcomeSession = {
  readonly id: string;
  readonly requestId: string | null;
  readonly actor: string | null;
  readonly forkedFrom: string | null;
  readonly prUrl: string | null;
  readonly taskId: string | null;
  /** The card's filer (its `created` event's actor) and external ref, for a card's run. */
  readonly cardFiledBy: string | null;
  readonly cardRef: string | null;
  /** When the card was filed, for a card's run. */
  readonly cardCreatedMs: number | null;
  readonly createdMs: number;
  readonly mergedMs: number | null;
  readonly revertedMs: number | null;
  readonly costTotal: number;
};

/** What `deriveOutcomes` computes from: the rows the read loaded, nothing else. */
export type OutcomeFacts = {
  readonly window: { readonly sinceMs: number; readonly untilMs: number };
  readonly cards: ReadonlyArray<OutcomeCard>;
  readonly sessions: ReadonlyArray<OutcomeSession>;
  /** The approval decisions taken in the window. */
  readonly decisions: ReadonlyArray<"approved" | "denied">;
};

/** Epoch milliseconds as the ISO-8601 UTC instant a window is written in. */
const iso = (millis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1
    ? upper
    : ((sorted[middle - 1] ?? 0) + upper) / 2;
};

const mean = (values: ReadonlyArray<number>): number | null =>
  values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;

const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

const seconds = (millis: number | null): number | null =>
  millis === null ? null : millis / 1000;

/** The length of the union of `intervals`, each clipped to `[from, to]`. */
const unionWithin = (
  intervals: ReadonlyArray<readonly [number, number]>,
  from: number,
  to: number,
): number => {
  const clipped = intervals
    .map(([start, end]) => [Math.max(start, from), Math.min(end, to)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let open: number | undefined;
  let close = 0;
  for (const [start, end] of clipped) {
    if (open === undefined || start > close) {
      if (open !== undefined) total += close - open;
      open = start;
      close = end;
    } else {
      close = Math.max(close, end);
    }
  }
  if (open !== undefined) total += close - open;
  return total;
};

const SOURCES = {
  card: "task_events (created, moved) on the board's cards",
  share:
    "task_events, task_runs (started_at, finished_at), session_activity.last_activity_at",
  delegation:
    "sessions.request_id (trigger:linear:<issue>:mapped), a card-mode card's task_events created actor and tasks.external_ref (linear:<issue>), sessions.forked_from, sessions.pr_merged_at (factory.merge)",
  merges:
    "sessions.pr_url, sessions.pr_merged_at and pr_reverted_at (factory.merge, from the GitHub webhook)",
  followUps:
    "sessions.pr_merged_at, sessions.forked_from, task_runs.task_id, sessions.created_at",
  reruns: "sessions.forked_from, sessions.created_at, sessions.pr_merged_at",
  approvals: "session_approvals.decision, decided_at",
  adoption:
    "sessions.request_id, task_runs, the card's task_events created actor, sessions.created_at",
  actors: "sessions.actor, sessions.created_at",
  cost: "session_activity.cost_total (LOB-17), sessions.created_at",
} as const;

/**
 * Every outcome value, from the facts the read loaded. Pure, so the definitions above are this
 * function and nothing else; `readOutcomes` only loads the rows.
 */
export const deriveOutcomes = (
  facts: OutcomeFacts,
): ReadonlyArray<OutcomeValue> => {
  const { sinceMs, untilMs } = facts.window;
  const window: OutcomeWindow = {
    since: iso(sinceMs),
    until: iso(untilMs),
  };
  const inWindow = (at: number | null): at is number =>
    at !== null && at >= sinceMs && at < untilMs;
  const values: OutcomeValue[] = [];
  const add = (
    metric: OutcomeMetric,
    name: string,
    value: number | null,
    unit: OutcomeUnit,
    denominator: { readonly count: number; readonly of: string },
    source: string,
  ) => values.push({ metric, name, value, unit, window, denominator, source });

  // Lead and cycle time over the cards that first reached `done` in the window.
  const cards = facts.cards.filter((card) => inWindow(card.doneMs));
  const doneCards = {
    count: cards.length,
    of: "cards that first reached done in the window",
  };
  const leads = cards.map((card) => card.doneMs - card.createdMs);
  add(
    "lead_time",
    "card.median",
    seconds(median(leads)),
    "seconds",
    doneCards,
    SOURCES.card,
  );
  add(
    "lead_time",
    "card.mean",
    seconds(mean(leads)),
    "seconds",
    doneCards,
    SOURCES.card,
  );
  const factoryTime = cards.reduce(
    (total, card) =>
      total +
      unionWithin(
        card.runs.flatMap((run) =>
          run.endedMs === null ? [] : [[run.startedMs, run.endedMs] as const],
        ),
        card.createdMs,
        card.doneMs,
      ),
    0,
  );
  const leadTotal = leads.reduce((total, lead) => total + lead, 0);
  add(
    "lead_time",
    "card.factory_share",
    ratio(factoryTime, leadTotal),
    "ratio",
    {
      count: cards.length,
      of: "cards that first reached done in the window (time-weighted)",
    },
    SOURCES.share,
  );

  // Delegation to merge, per Linear issue: its delegated sessions and every re-run forked from them.
  const children = new Map<string, OutcomeSession[]>();
  for (const session of facts.sessions) {
    if (session.forkedFrom === null) continue;
    const siblings = children.get(session.forkedFrom) ?? [];
    siblings.push(session);
    children.set(session.forkedFrom, siblings);
  }
  const lineage = (roots: ReadonlyArray<OutcomeSession>): OutcomeSession[] => {
    const seen = new Set<string>();
    const queue = [...roots];
    const all: OutcomeSession[] = [];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next.id)) continue;
      seen.add(next.id);
      all.push(next);
      queue.push(...(children.get(next.id) ?? []));
    }
    return all;
  };
  // A session-mode delegation is the session the issue's delivery opened; a card-mode one is the
  // card a Linear rule filed, delegated when it was filed, whose runs are its sessions.
  const issues = new Map<string, { roots: OutcomeSession[]; start: number }>();
  for (const session of facts.sessions) {
    const delegated = LINEAR_DELEGATION.exec(session.requestId ?? "")?.[1];
    const carded =
      delegated === undefined && sourceOfActor(session.cardFiledBy) === "linear"
        ? linearIssueOfExternalRef(session.cardRef)
        : undefined;
    const issue = delegated ?? carded;
    if (issue === undefined) continue;
    const at =
      carded === undefined
        ? session.createdMs
        : (session.cardCreatedMs ?? session.createdMs);
    const known = issues.get(issue);
    if (known === undefined) issues.set(issue, { roots: [session], start: at });
    else {
      known.roots.push(session);
      known.start = Math.min(known.start, at);
    }
  }
  const delegations: number[] = [];
  for (const { roots, start } of issues.values()) {
    const merges = lineage(roots).flatMap((session) =>
      session.mergedMs === null ? [] : [session.mergedMs],
    );
    if (merges.length === 0) continue;
    const merged = Math.min(...merges);
    if (inWindow(merged)) delegations.push(merged - start);
  }
  const delegated = {
    count: delegations.length,
    of: "Linear issues whose delegation first reached a merged PR in the window",
  };
  add(
    "lead_time",
    "delegation.median",
    seconds(median(delegations)),
    "seconds",
    delegated,
    SOURCES.delegation,
  );
  add(
    "lead_time",
    "delegation.mean",
    seconds(mean(delegations)),
    "seconds",
    delegated,
    SOURCES.delegation,
  );

  // A card whose first move was the move into `done` never left its column before it: no cycle.
  const cycles = cards.flatMap((card) =>
    card.firstMovedMs === null || card.firstMovedMs >= card.doneMs
      ? []
      : [card.doneMs - card.firstMovedMs],
  );
  const cycled = {
    count: cycles.length,
    of: "cards that first reached done in the window after leaving the column they were filed in",
  };
  add(
    "cycle_time",
    "card.median",
    seconds(median(cycles)),
    "seconds",
    cycled,
    SOURCES.card,
  );
  add(
    "cycle_time",
    "card.mean",
    seconds(mean(cycles)),
    "seconds",
    cycled,
    SOURCES.card,
  );

  // Defect pressure over the factory's merges in the window, one per PR.
  const byPr = new Map<string, OutcomeSession[]>();
  for (const session of facts.sessions) {
    if (session.prUrl === null || session.mergedMs === null) continue;
    const own = byPr.get(session.prUrl);
    if (own === undefined) byPr.set(session.prUrl, [session]);
    else own.push(session);
  }
  // The candidates for a merge's follow-ups, by what makes one: its parent, and its card.
  const runsOfCard = new Map<string, OutcomeSession[]>();
  for (const session of facts.sessions) {
    if (session.taskId === null) continue;
    const runs = runsOfCard.get(session.taskId);
    if (runs === undefined) runsOfCard.set(session.taskId, [session]);
    else runs.push(session);
  }
  const merges = [...byPr.values()]
    .map((sessions) => ({
      sessions,
      mergedMs: Math.min(
        ...sessions.map((session) => session.mergedMs ?? Infinity),
      ),
    }))
    .filter((merge) => inWindow(merge.mergedMs));
  const followUpSessions = new Set<string>();
  let reverted = 0;
  let followedUp = 0;
  let pressured = 0;
  for (const merge of merges) {
    const own = new Set(merge.sessions.map((session) => session.id));
    const cardsOf = new Set(
      merge.sessions.flatMap((session) =>
        session.taskId === null ? [] : [session.taskId],
      ),
    );
    const isReverted = merge.sessions.some(
      (session) => session.revertedMs !== null && session.revertedMs < untilMs,
    );
    const candidates = new Map<string, OutcomeSession>();
    for (const session of merge.sessions)
      for (const child of children.get(session.id) ?? [])
        candidates.set(child.id, child);
    for (const taskId of cardsOf)
      for (const sibling of runsOfCard.get(taskId) ?? [])
        candidates.set(sibling.id, sibling);
    const followUps = [...candidates.values()].filter(
      (session) =>
        !own.has(session.id) &&
        session.createdMs > merge.mergedMs &&
        session.createdMs < untilMs,
    );
    for (const session of followUps) followUpSessions.add(session.id);
    if (isReverted) reverted += 1;
    if (followUps.length > 0) followedUp += 1;
    if (isReverted || followUps.length > 0) pressured += 1;
  }
  const merged = {
    count: merges.length,
    of: "PRs the factory opened that merged in the window",
  };
  add(
    "defect_pressure",
    "merges.reverted",
    reverted,
    "count",
    merged,
    SOURCES.merges,
  );
  add(
    "defect_pressure",
    "merges.followed_up",
    followedUp,
    "count",
    merged,
    SOURCES.followUps,
  );
  add(
    "defect_pressure",
    "follow_up_sessions",
    followUpSessions.size,
    "count",
    merged,
    SOURCES.followUps,
  );
  add(
    "defect_pressure",
    "rate",
    ratio(pressured, merges.length),
    "ratio",
    merged,
    `${SOURCES.merges}; ${SOURCES.followUps}`,
  );

  // Recovery: re-runs back to a merged PR, and the decisions a person took on gated calls.
  const reruns = facts.sessions.filter(
    (session) => session.forkedFrom !== null && inWindow(session.createdMs),
  );
  const recovered = reruns.flatMap((session) =>
    session.mergedMs !== null && session.mergedMs < untilMs
      ? [session.mergedMs - session.createdMs]
      : [],
  );
  add(
    "recovery",
    "reruns.recovered",
    ratio(recovered.length, reruns.length),
    "ratio",
    {
      count: reruns.length,
      of: "re-runs (forked sessions) created in the window",
    },
    SOURCES.reruns,
  );
  add(
    "recovery",
    "reruns.median_to_merge",
    seconds(median(recovered)),
    "seconds",
    {
      count: recovered.length,
      of: "re-runs created in the window that reached a merged PR by its end",
    },
    SOURCES.reruns,
  );
  const decided = {
    count: facts.decisions.length,
    of: "approval decisions taken in the window",
  };
  const approved = facts.decisions.filter(
    (decision) => decision === "approved",
  ).length;
  add(
    "recovery",
    "approvals.approved_rate",
    ratio(approved, decided.count),
    "ratio",
    decided,
    SOURCES.approvals,
  );
  add(
    "recovery",
    "approvals.denied_rate",
    ratio(decided.count - approved, decided.count),
    "ratio",
    decided,
    SOURCES.approvals,
  );

  // Adoption and cost over the sessions created in the window.
  const created = facts.sessions.filter((session) =>
    inWindow(session.createdMs),
  );
  const createdIn = {
    count: created.length,
    of: "sessions created in the window",
  };
  const byTrigger = new Map<OutcomeTrigger, number>();
  for (const session of created) {
    const trigger = triggerOf(
      session.requestId,
      session.taskId !== null,
      session.cardFiledBy,
    );
    byTrigger.set(trigger, (byTrigger.get(trigger) ?? 0) + 1);
  }
  for (const trigger of OUTCOME_TRIGGERS) {
    add(
      "adoption",
      `sessions.${trigger}`,
      byTrigger.get(trigger) ?? 0,
      "count",
      createdIn,
      SOURCES.adoption,
    );
  }
  const perPerson = new Map<string, number>();
  for (const session of created) {
    if (session.actor === null || session.actor.startsWith("trigger:"))
      continue;
    perPerson.set(session.actor, (perPerson.get(session.actor) ?? 0) + 1);
  }
  const repeat = [...perPerson.values()].filter((count) => count > 1).length;
  add(
    "adoption",
    "actors.repeat",
    ratio(repeat, perPerson.size),
    "ratio",
    { count: perPerson.size, of: "people who started a session in the window" },
    SOURCES.actors,
  );
  const cost = created.reduce((total, session) => total + session.costTotal, 0);
  add(
    "cost",
    "total",
    created.length === 0 ? null : cost,
    "usd",
    createdIn,
    SOURCES.cost,
  );
  add(
    "cost",
    "per_session",
    ratio(cost, created.length),
    "usd",
    createdIn,
    SOURCES.cost,
  );
  return values;
};

type CardRow = {
  readonly id: string;
  readonly createdMs: number;
  readonly firstMovedMs: number | null;
  readonly doneMs: number;
};
type RunRow = {
  readonly taskId: string;
  readonly startedMs: number;
  readonly endedMs: number | null;
};
type SessionRow = OutcomeSession;

const invalid = (message: string): SessionError =>
  new SessionError({ code: "invalid_input", message });

/** An ISO-8601 instant as epoch milliseconds, or the refusal naming the field. */
const instant = (
  field: string,
  value: string,
): Effect.Effect<number, SessionError> =>
  Option.match(DateTime.make(value), {
    onNone: () =>
      Effect.fail(invalid(`${field} is not an ISO-8601 instant: "${value}"`)),
    onSome: (instant) => Effect.succeed(DateTime.toEpochMillis(instant)),
  });

/** A timestamp column as epoch milliseconds, in SQL: what every row below is read in. */
const EPOCH_MS = (column: string) =>
  `(extract(epoch FROM ${column}) * 1000)::double precision`;

/**
 * The outcome metrics over one window (module comment): four reads of the index tables and the
 * card history, then `deriveOutcomes`. A window that is not one — an unparseable instant, or
 * `since` not before `until` — is `invalid_input`, and nothing is read.
 */
export const readOutcomes = (
  input: OutcomesInput,
): Effect.Effect<OutcomeReport, SessionError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const untilMs =
      input.until === undefined
        ? yield* Clock.currentTimeMillis
        : yield* instant("until", input.until);
    const sinceMs =
      input.since === undefined
        ? untilMs - DEFAULT_OUTCOME_WINDOW_MS
        : yield* instant("since", input.since);
    if (sinceMs >= untilMs) {
      return yield* invalid(
        `the window is empty: since (${iso(sinceMs)}) is not before until (${iso(untilMs)})`,
      );
    }
    const since = iso(sinceMs);
    const until = iso(untilMs);
    const repo = input.repo ?? null;

    const cards = yield* sql<CardRow>`
      SELECT
        t.id,
        ${sql.literal(EPOCH_MS("COALESCE(c.created_at, t.created_at)"))} AS created_ms,
        ${sql.literal(EPOCH_MS("m.first_moved"))} AS first_moved_ms,
        ${sql.literal(EPOCH_MS("m.done"))} AS done_ms
      FROM tasks t
      JOIN board_instances b ON b.id = t.board_id
      LEFT JOIN LATERAL (
        SELECT min(e.created_at) AS created_at FROM task_events e
        WHERE e.task_id = t.id AND e.kind = 'created'
      ) c ON true
      JOIN LATERAL (
        SELECT
          min(e.created_at) AS first_moved,
          min(e.created_at) FILTER (WHERE e.payload->>'to' = 'done') AS done
        FROM task_events e
        WHERE e.task_id = t.id AND e.kind = 'moved'
      ) m ON true
      WHERE m.done >= ${since}::timestamptz AND m.done < ${until}::timestamptz
        AND (${repo}::text IS NULL OR COALESCE(t.repo, b.repo) = ${repo})
      ORDER BY t.id
    `;
    const runs =
      cards.length === 0
        ? []
        : yield* sql<RunRow>`
            SELECT
              tr.task_id,
              ${sql.literal(EPOCH_MS("tr.started_at"))} AS started_ms,
              ${sql.literal(EPOCH_MS("COALESCE(tr.finished_at, a.last_activity_at)"))} AS ended_ms
            FROM task_runs tr
            LEFT JOIN session_activity a ON a.session_id = tr.session_id
            WHERE tr.task_id = ANY(${cards.map((card) => card.id)}::text[])
          `;
    // Every session created before `until`, not only in the window: a merge, a revert or a
    // follow-up in the window can belong to a session created before it.
    const sessions = yield* sql<SessionRow>`
      SELECT
        s.id,
        s.request_id,
        s.actor,
        s.forked_from,
        s.pr_url,
        tr.task_id,
        filed.actor AS card_filed_by,
        t.external_ref AS card_ref,
        ${sql.literal(EPOCH_MS("COALESCE(filed.created_at, t.created_at)"))} AS card_created_ms,
        ${sql.literal(EPOCH_MS("s.created_at"))} AS created_ms,
        ${sql.literal(EPOCH_MS("s.pr_merged_at"))} AS merged_ms,
        ${sql.literal(EPOCH_MS("s.pr_reverted_at"))} AS reverted_ms,
        COALESCE(a.cost_total, 0)::double precision AS cost_total
      FROM sessions s
      LEFT JOIN session_activity a ON a.session_id = s.id
      LEFT JOIN task_runs tr ON tr.session_id = s.id
      LEFT JOIN tasks t ON t.id = tr.task_id
      LEFT JOIN LATERAL (
        SELECT e.actor, e.created_at FROM task_events e
        WHERE e.task_id = tr.task_id AND e.kind = 'created'
        ORDER BY e.id LIMIT 1
      ) filed ON true
      WHERE s.created_at < ${until}::timestamptz
        AND (${repo}::text IS NULL OR s.repo = ${repo})
      ORDER BY s.id
    `;
    const decisions = yield* sql<{ readonly decision: string }>`
      SELECT sa.decision
      FROM session_approvals sa
      JOIN sessions s ON s.id = sa.session_id
      WHERE sa.decided_at >= ${since}::timestamptz AND sa.decided_at < ${until}::timestamptz
        AND sa.decision IS NOT NULL
        AND (${repo}::text IS NULL OR s.repo = ${repo})
    `;

    const runsOf = new Map<string, OutcomeCard["runs"][number][]>();
    for (const run of runs) {
      const interval = { startedMs: run.startedMs, endedMs: run.endedMs };
      const known = runsOf.get(run.taskId);
      if (known === undefined) runsOf.set(run.taskId, [interval]);
      else known.push(interval);
    }
    const values = deriveOutcomes({
      window: { sinceMs, untilMs },
      cards: cards.map((card) => ({
        ...card,
        runs: runsOf.get(card.id) ?? [],
      })),
      sessions,
      decisions: decisions.flatMap((row) =>
        row.decision === "approved" || row.decision === "denied"
          ? [row.decision]
          : [],
      ),
    });
    return {
      window: { since, until },
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      values,
    };
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new SessionError({
          code: "storage",
          message: `read the outcome metrics: ${String(cause)}`,
        }),
      ),
    ),
  );
