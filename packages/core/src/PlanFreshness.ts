/**
 * The plan-freshness cadence (LOB-45): a merged factory PR reads the plan again.
 *
 * `POST /webhooks/github` hands every signed `pull_request` delivery here. With the cadence `off` —
 * the default — nothing is read and nothing is called. With it `merged`, a merge of a PR the factory
 * opened (`sessions.pr_url`, as the Linear mirror and the workspace release match it) runs one
 * plan-freshness pass (`SessionService.refreshPlan`) against the spec of record: the card's newest
 * `specified` event's session for a run on a card, or the PR's own session otherwise. The pass files
 * its proposals on that session and writes to no tracker; a person approves them.
 *
 * **The pass is not the request's.** A pass makes a model call that can outlast the 10 s GitHub waits
 * for an answer, and a closed connection interrupts the request. So the route hands each claimed pass
 * to `PlanFreshnessPasses` — a fiber set the API process owns, whose scope closes at shutdown — and
 * answers `accepted` once the claim is taken; the pass runs to its outcome whatever the connection
 * does. Within the pass, only the wait on the provider is interruptible (`refreshPlan`): a billed
 * call is charged, and a paid-for answer filed, even when a shutdown lands mid-pass.
 *
 * **One merge, one revision.** The dedupe is the webhook seam's own row: each pass claims
 * `webhook_deliveries` for `plan-freshness:<spec session>:<pr url>` with the seam's claim
 * (`claimDeliveryRow`, `TriggerService`), so two deliveries of one merge — a
 * redelivery from GitHub's log, or two at once — cannot both run a pass, across processes. The
 * claim is `processed` once a revision is filed, `skipped` with the reason when the pass was refused
 * (a refusal before the call costs nothing, and a refused answer was already paid for, so neither is
 * repeated by a redelivery), and given back on a storage failure, a defect, an interrupt, a busy
 * spec session or a tracker that failed to answer, so a redelivery can finish what never ran. A claim a killed process left `received` is taken again after
 * `TRIGGER_RECLAIM_AFTER`, as the seam's is. The spec's session also files the revision under the
 * merge's key, and `refreshPlan` answers a held key without a call — a second guard should the
 * dedupe row ever be lost.
 */
import {
  Context,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Result,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { planRevisionKey } from "@repo/domain/PlanFreshness";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import { githubPullRequestLifecycle, refuseGitHubDelivery } from "./LinearSync";
import { SessionService } from "./SessionService";
import {
  claimDeliveryRow,
  releaseDeliveryClaim,
  settleDeliveryClaim,
  TRIGGER_RECLAIM_AFTER,
} from "./TriggerService";

/** When a pass runs: never (the default), or on every merged factory PR. */
export const PLAN_FRESHNESS_CADENCES = ["off", "merged"] as const;
export type PlanFreshnessCadence = (typeof PLAN_FRESHNESS_CADENCES)[number];

/** The bound on one pass's worst-case cost, in US dollars, when none is configured. */
export const DEFAULT_PLAN_FRESHNESS_MAX_COST = 0.25;

export type PlanFreshnessConfig = {
  readonly cadence: PlanFreshnessCadence;
  /** The most one pass may cost, in US dollars: a pass whose worst case is over it is never made. */
  readonly maxCost: number;
};

/** The cadence nothing is configured for: off. */
export const PLAN_FRESHNESS_OFF: PlanFreshnessConfig = {
  cadence: "off",
  maxCost: DEFAULT_PLAN_FRESHNESS_MAX_COST,
};

/**
 * The configuration `PLAN_FRESHNESS` and `PLAN_FRESHNESS_MAX_COST` spell, or the reason they do not.
 * Blank is the default; a cadence that is not one of `PLAN_FRESHNESS_CADENCES`, or a bound that is
 * not a positive number, is an error, so a typo is reported rather than read as a cadence.
 */
export const planFreshnessConfigOf = (env: {
  readonly cadence?: string | undefined;
  readonly maxCost?: string | undefined;
}):
  | { readonly ok: true; readonly config: PlanFreshnessConfig }
  | { readonly ok: false; readonly error: string } => {
  const cadence = (env.cadence ?? "").trim().toLowerCase();
  const chosen = cadence === "" ? "off" : cadence;
  if (!PLAN_FRESHNESS_CADENCES.some((one) => one === chosen)) {
    return {
      ok: false,
      error: `PLAN_FRESHNESS is "${env.cadence ?? ""}"; it is one of ${PLAN_FRESHNESS_CADENCES.join(", ")}`,
    };
  }
  const bound = (env.maxCost ?? "").trim();
  const maxCost =
    bound === "" ? DEFAULT_PLAN_FRESHNESS_MAX_COST : Number(bound);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    return {
      ok: false,
      error: `PLAN_FRESHNESS_MAX_COST is "${bound}"; it is a positive number of US dollars`,
    };
  }
  return {
    ok: true,
    config: { cadence: chosen === "merged" ? "merged" : "off", maxCost },
  };
};

/** What one spec session's pass came to. */
export type PlanFreshnessPass = {
  readonly sessionId: string;
  readonly outcome:
    | "proposed"
    | "already-proposed"
    | "replayed"
    | "refused"
    | "failed"
    /** Claimed and handed to `PlanFreshnessPasses`: the pass runs past the answer. */
    | "accepted";
  /** The revision's key, for `proposed` and `already-proposed`. */
  readonly key?: string;
  /** How many proposals the revision holds. */
  readonly proposals?: number;
  /** Why a pass was refused or failed: a `PlanFreshnessReason`, `refused_answer`, or the error. */
  readonly reason?: string;
};

/** What a delivery came to: `off` and `ignored` ran nothing; `passes` lists each spec session's. */
export type PlanFreshnessOutcome =
  | { readonly status: "off" }
  | { readonly status: "ignored"; readonly reason: string }
  | {
      readonly status: "merged";
      readonly passes: readonly PlanFreshnessPass[];
    };

/**
 * Where a claimed pass runs when the caller will not wait for it: a fiber set the process owns, so a
 * pass outlives the request that claimed it and is interrupted only when the process shuts down.
 * `idle` waits until every pass handed to it has finished.
 */
export class PlanFreshnessPasses extends Context.Service<
  PlanFreshnessPasses,
  {
    readonly run: (pass: Effect.Effect<void>) => Effect.Effect<void>;
    readonly idle: Effect.Effect<void>;
  }
>()("@repo/core/PlanFreshnessPasses") {}

/** The passes' fiber set, scoped to the layer: closing it interrupts (and awaits) every pass. */
export const PlanFreshnessPassesLive = Layer.effect(
  PlanFreshnessPasses,
  Effect.gen(function* () {
    const set = yield* FiberSet.make<void, never>();
    return PlanFreshnessPasses.of({
      run: (pass) => Effect.asVoid(FiberSet.run(set, pass)),
      idle: FiberSet.awaitEmpty(set),
    });
  }),
);

/** The merged PR's title, when the payload carries one. */
const titleOf = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const pr: unknown = Reflect.get(payload, "pull_request");
  if (typeof pr !== "object" || pr === null) return undefined;
  const title: unknown = Reflect.get(pr, "title");
  return typeof title === "string" && title.trim() !== "" ? title : undefined;
};

/** The dedupe id one pass claims: the spec it reads and the merge it answers. */
export const planFreshnessDeliveryId = (
  sessionId: string,
  pr: string,
): string => `plan-freshness:${sessionId}:${pr}`;

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/** The refusals a later delivery of the same merge may not meet again. */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set([
  "busy",
  "tracker_failed",
]);

/**
 * The sessions whose specs a merge is read against: per session that opened the PR, its card's
 * newest `specified` event's session, or itself when it runs on no card (or its card was never
 * specified). Distinct, and only ids that name a session.
 */
const specSessionsOf = (pr: string, apiUrl: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ readonly id: string }>`
      SELECT DISTINCT spec.id FROM (
        SELECT COALESCE(
          (
            SELECT te.actor FROM task_runs tr
            JOIN task_events te ON te.task_id = tr.task_id AND te.kind = 'specified'
            WHERE tr.session_id = s.id
            ORDER BY te.id DESC
            LIMIT 1
          ),
          s.id
        ) AS id
        FROM sessions s
        WHERE s.pr_url = ${pr} OR s.pr_url = ${apiUrl}
      ) spec
      JOIN sessions known ON known.id = spec.id
      ORDER BY spec.id
    `;
    return rows.map((row) => row.id).filter(Schema.is(SessionIdSchema));
  });

/**
 * One signed GitHub `pull_request` delivery, taken as far as the plan cares: with the cadence on, a
 * merge of a factory PR runs one pass per spec of record; anything else runs nothing. Never fails:
 * every outcome is an answer the route reports, and a storage failure is logged and reported as
 * `failed` with the claim given back.
 *
 * With `fork`, each claimed pass is handed to it and answered `accepted` — the route's way, so the
 * answer does not wait on a model call (`PlanFreshnessPasses`). Without, each pass runs before the
 * answer, which reports what it came to.
 */
export const handlePlanFreshnessDelivery = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
  readonly config: PlanFreshnessConfig;
  /** How long a `received` claim is held before a redelivery may take it; the seam's by default. */
  readonly reclaimAfter?: Duration.Input;
  /** Runs a claimed pass past the answer; see above. */
  readonly fork?: (pass: Effect.Effect<void>) => Effect.Effect<void>;
}): Effect.Effect<PlanFreshnessOutcome, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    if (input.config.cadence === "off") return { status: "off" } as const;
    if (refuseGitHubDelivery(input) !== undefined) {
      return { status: "ignored", reason: "unsigned" } as const;
    }
    const payload = yield* Schema.decodeEffect(JsonBody)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const lifecycle = githubPullRequestLifecycle(payload);
    if (lifecycle === undefined || lifecycle._tag !== "merged") {
      return { status: "ignored", reason: "not a merge" } as const;
    }
    const sql = yield* SqlClient;
    const sessions = yield* SessionService;
    const pr = lifecycle.pr.url;
    const reclaimSeconds = Duration.toSeconds(
      Duration.fromInputUnsafe(input.reclaimAfter ?? TRIGGER_RECLAIM_AFTER),
    );
    const specs = yield* specSessionsOf(pr, lifecycle.apiUrl ?? pr).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logError(
            `plan freshness: the sessions of merged ${pr} could not be read: ${error.message}`,
          ),
          [] as SessionIdSchema[],
        ),
      ),
    );
    const title = titleOf(payload);
    const trigger = {
      pr,
      number: lifecycle.pr.number,
      ...(title === undefined ? {} : { title }),
    };
    /** The claimed pass on `sessionId`, run to its outcome, with the claim settled or given back. */
    const runPass = (
      sessionId: SessionIdSchema,
      requestId: string,
      claim: string,
    ): Effect.Effect<PlanFreshnessPass> =>
      Effect.gen(function* () {
        const settle = (status: "processed" | "skipped", reason: string) =>
          settleDeliveryClaim(sql, requestId, claim, status, reason).pipe(
            Effect.ignore,
          );
        const release = releaseDeliveryClaim(sql, requestId, claim).pipe(
          Effect.ignore,
        );
        const exit = yield* Effect.exit(
          sessions
            .refreshPlan({
              sessionId,
              key: planRevisionKey(pr),
              trigger,
              maxCost: input.config.maxCost,
            })
            // An interrupt is not an exit `Effect.exit` sees here: the claim goes back on it too.
            .pipe(Effect.onInterrupt(() => release)),
        );
        if (Exit.isSuccess(exit)) {
          const { revision, created } = exit.value;
          yield* settle(
            "processed",
            `plan revision ${revision.key}: ${revision.proposals.length} proposal(s)`,
          );
          return {
            sessionId,
            outcome: created ? "proposed" : "already-proposed",
            key: revision.key,
            proposals: revision.proposals.length,
          } as const;
        }
        const error = Exit.findErrorOption(exit);
        if (
          error._tag === "Some" &&
          error.value._tag === "PlanFreshnessRefused"
        ) {
          // A busy spec session and a tracker that failed are passing states: the claim goes back,
          // so a redelivery tries again. Every other refusal is the merge's answer and is recorded.
          yield* TRANSIENT_REFUSALS.has(error.value.reason)
            ? release
            : settle(
                "skipped",
                `plan freshness refused: ${error.value.message}`,
              );
          return {
            sessionId,
            outcome: "refused",
            reason: error.value.reason,
          } as const;
        }
        if (
          error._tag === "Some" &&
          error.value._tag === "PlanProposalsRefused"
        ) {
          yield* settle("skipped", error.value.message);
          yield* Effect.logWarning(
            `plan freshness: session ${sessionId}'s pass answered proposals the rules refuse: ${error.value.message}`,
          );
          return {
            sessionId,
            outcome: "refused",
            reason: "refused_answer",
          } as const;
        }
        // A storage or model failure, a defect or an interrupt: the claim goes back, so a
        // redelivery runs the pass that did not finish.
        yield* release;
        const message =
          error._tag === "Some"
            ? error.value.message
            : "the pass did not finish";
        yield* Effect.logError(
          `plan freshness: session ${sessionId}'s pass for ${pr} failed: ${message}`,
        );
        return { sessionId, outcome: "failed", reason: message } as const;
      });
    /**
     * Claim `sessionId`'s pass and run it, or hand it to `fork`. Uninterruptible when forking, so a
     * request that goes away between the claim and the hand-off cannot strand a claim no pass holds.
     */
    const claimAndRun = (
      sessionId: SessionIdSchema,
    ): Effect.Effect<PlanFreshnessPass> =>
      Effect.gen(function* () {
        const requestId = planFreshnessDeliveryId(sessionId, pr);
        const claimed = yield* Effect.result(
          claimDeliveryRow(sql, requestId, reclaimSeconds),
        );
        if (Result.isFailure(claimed)) {
          yield* Effect.logError(
            `plan freshness: the pass of session ${sessionId} for ${pr} could not be claimed: ${claimed.failure.message}`,
          );
          return { sessionId, outcome: "failed", reason: "storage" } as const;
        }
        const claim = claimed.success;
        if (claim === undefined) {
          return { sessionId, outcome: "replayed" } as const;
        }
        if (input.fork === undefined) {
          return yield* runPass(sessionId, requestId, claim);
        }
        yield* input.fork(Effect.asVoid(runPass(sessionId, requestId, claim)));
        return { sessionId, outcome: "accepted" } as const;
      });
    const passes: PlanFreshnessPass[] = [];
    for (const sessionId of specs) {
      passes.push(
        yield* input.fork === undefined
          ? claimAndRun(sessionId)
          : Effect.uninterruptible(claimAndRun(sessionId)),
      );
    }
    return { status: "merged", passes } as const;
  });
