/**
 * The trigger seam (LOB-188, part 1 of LOB-34): one typed path from an inbound delivery to a
 * session — dedupe → filter → map → create → write back.
 *
 * An adapter owns exactly one thing: turning its wire payload into a `TriggerEvent`
 * (`@repo/domain/Trigger`). Everything after that lives here, so the Linear route, the generic
 * webhook, and the Jira/GitHub/Slack adapters that follow cannot drift from each other on the
 * parts that are easy to get wrong: what makes a delivery a replay, what a refusal records, and
 * how much of a delivery is allowed to reach a session.
 *
 * **Dedupe is the row, not a memo.** `webhook_deliveries` (LOB-168) has `request_id` as its
 * primary key, and the claim is a single `INSERT … ON CONFLICT DO NOTHING RETURNING`: the caller
 * that gets no row back is the replay, whoever it is and however many processes there are. Two
 * simultaneous deliveries of one id therefore cannot both create a session, which a
 * read-then-insert cannot promise (and which is why `api.memo` is not used here — it dedupes
 * within one task invocation and this is not a task; see LOB-178's record).
 *
 * **The session is created by a port, not by `SessionService`.** The seam's job is to decide
 * *whether* work starts; opening a harness, a worktree and a log is the session layer's. So the
 * port is two calls (`create`, `send`) and a test can prove the dedupe against real Postgres with
 * a counting fake, while `TriggerSessionsFromSessionService` is the production wiring.
 *
 * **The write-back is optional and injected.** No adapter in part 1 needs one (the generic webhook
 * has no place to write, and the Linear route only delegates), so the default is a no-op: a
 * deployment that configures no client never fails a delivery because of one.
 */
import { Context, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type {
  CreateSessionInput,
  RepoSlug,
  SessionId,
} from "@repo/domain/Session";
import {
  resolveMapping,
  startsWork,
  TRIGGER_ACTIONS,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerOutcome,
  type TriggerRule,
  type TriggerSource,
} from "@repo/domain/Trigger";
import { SessionService } from "./SessionService";

export type TriggerServiceShape = {
  /**
   * Take one delivery as far as it goes, and answer what happened to it.
   *
   * Idempotent on `delivery.requestId`: a second call with the same id creates nothing and
   * answers `replayed: true` with whatever the first call recorded.
   */
  readonly deliver: (
    delivery: TriggerDelivery,
  ) => Effect.Effect<TriggerOutcome, TriggerError>;
};

export class TriggerService extends Context.Service<
  TriggerService,
  TriggerServiceShape
>()("@repo/core/TriggerService") {}

/**
 * What the seam needs of the session layer, and nothing more.
 *
 * `deliveryId` is the source's own idempotency key, un-namespaced, because it is the one thing an
 * adapter may want to name something after: the docs trigger cuts its session's branch as
 * `factory/doc-<deliveryId>` (LOB-197), so the branch says which delivery produced the run. It is
 * passed rather than derived from `requestId`: the seam's `trigger:` prefix is the seam's own
 * business, and a caller that stripped it would break the day the prefix changed.
 */
export type TriggerSessionsShape = {
  readonly create: (input: {
    /** Where the delivery came from: the session's actor is `trigger:<source>` (LOB-162). */
    readonly source: TriggerSource;
    readonly title: string;
    readonly requestId: string;
    readonly deliveryId: string;
    readonly repo: RepoSlug;
    readonly baseRef: string | undefined;
  }) => Effect.Effect<{ readonly id: SessionId }, TriggerError>;
  /**
   * Send the delivery's prompt. `requestId` is the delivery's own key (the same namespaced id the
   * session was created under), and a port must admit one message per id: the seam gives a failed
   * delivery's claim back, so a write-back that fails *after* the send makes the sender's retry
   * send again, and only this key keeps that retry from appending the prompt twice (LOB-218).
   */
  readonly send: (input: {
    readonly sessionId: SessionId;
    readonly content: string;
    readonly requestId: string;
  }) => Effect.Effect<void, TriggerError>;
};

export class TriggerSessions extends Context.Service<
  TriggerSessions,
  TriggerSessionsShape
>()("@repo/core/TriggerSessions") {}

/**
 * The request id a delivery's session is created under: the delivery's own id, namespaced, because
 * `sessions.request_id` dedupes client retries too and a delivery id that happened to equal a
 * caller's request id would hand that caller this session.
 *
 * Exported with its inverse so a reader that has only the session — the Linear write-back
 * (LOB-15) finding which issue a PR belongs to — reads the prefix from here rather than spelling
 * it, and cannot break the day it changes.
 */
export const sessionRequestIdOf = (deliveryId: string): string =>
  `trigger:${deliveryId}`;

/**
 * The actor a trigger-started session's spend is attributed to (LOB-162): the source that started
 * it, namespaced so it can never read as a person's name. The person behind the issue or message is
 * the source's to know, not a verified identity; LOB-20 is where that lands.
 */
export const triggerActorOf = (source: TriggerSource): string =>
  `trigger:${source}`;

/** The delivery a session was created for, or `undefined` for a session no trigger opened. */
export const deliveryIdOfSession = (
  requestId: string | null | undefined,
): string | undefined =>
  requestId?.startsWith("trigger:") === true
    ? requestId.slice("trigger:".length)
    : undefined;

/** Where an adapter posts the session's link back. Part 1 ships no adapter that needs one. */
export type TriggerWriteBackShape = {
  readonly write: (input: {
    readonly event: TriggerEvent;
    readonly sessionId: SessionId;
  }) => Effect.Effect<void, TriggerError>;
};

export class TriggerWriteBack extends Context.Service<
  TriggerWriteBack,
  TriggerWriteBackShape
>()("@repo/core/TriggerWriteBack") {}

/** The default: a deployment with no write-back client records the session and stops there. */
export const NoWriteBack = Layer.succeed(
  TriggerWriteBack,
  TriggerWriteBack.of({ write: () => Effect.void }),
);

/**
 * The production wiring: the seam's two calls are `SessionService.create` and
 * `SessionService.send`, and a `SessionError` becomes a `TriggerError` here rather than leaking a
 * session-shaped failure out of the trigger path. Both carry the request id: `create` dedupes on
 * `sessions.request_id`, `send` on Pi Durable's submission `requestId`, which survives a restart.
 */
export const TriggerSessionsFromSessionService = Layer.effect(
  TriggerSessions,
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const failSession = (cause: { readonly message: string }): TriggerError =>
      new TriggerError({ code: "session-create", message: cause.message });
    return TriggerSessions.of({
      create: (input) =>
        sessions
          .create({
            title: input.title,
            requestId: input.requestId,
            repo: input.repo,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            actor: triggerActorOf(input.source),
          } satisfies CreateSessionInput)
          .pipe(
            Effect.map((summary) => ({ id: summary.id })),
            Effect.mapError(failSession),
          ),
      send: (input) =>
        sessions
          .send({
            sessionId: input.sessionId,
            content: input.content,
            requestId: input.requestId,
          })
          .pipe(Effect.asVoid, Effect.mapError(failSession)),
    });
  }),
);

export type TriggerServiceOptions = {
  /**
   * The mapping rules, in the operator's order: the first rule whose label the event carries wins,
   * so a specific label placed before a catch-all is how one repo takes precedence.
   */
  readonly rules: ReadonlyArray<TriggerRule>;
};

/** One `webhook_deliveries` row as the replay read returns it. */
type DeliveryRow = {
  readonly status: string;
  readonly skipReason: string | null;
};

/**
 * The unregistered-repo skip reason, and the `LIKE` pattern that recognizes it in a recorded row.
 * One definition for both, so the reclaim cannot drift from the words the skip writes.
 */
const unregisteredRepo = (repo: RepoSlug): string =>
  `repo ${repo} is not registered`;
const UNREGISTERED_REPO_PATTERN = "repo % is not registered";

const toTriggerError =
  (what: string) =>
  (cause: SqlError): TriggerError =>
    new TriggerError({ code: "storage", message: `${what}: ${cause.message}` });

export const TriggerServiceLive = (options: TriggerServiceOptions) =>
  Layer.effect(
    TriggerService,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const sessions = yield* TriggerSessions;
      const writeBack = yield* TriggerWriteBack;

      const storage = <A>(
        what: string,
        effect: Effect.Effect<A, SqlError>,
      ): Effect.Effect<A, TriggerError> =>
        Effect.mapError(effect, toTriggerError(what));

      /** Record the refusal, then answer with it. A skip is a decision, not a failure. */
      const skip = (
        requestId: string,
        reason: string,
      ): Effect.Effect<TriggerOutcome, TriggerError> =>
        Effect.gen(function* () {
          yield* storage(
            "record skipped delivery",
            sql`UPDATE webhook_deliveries
                SET status = 'skipped', skip_reason = ${reason}
                WHERE request_id = ${requestId}`,
          );
          return { status: "skipped", replayed: false, reason } as const;
        });

      /** Answer a replay with what the first delivery recorded. */
      const replay = (
        requestId: string,
      ): Effect.Effect<TriggerOutcome, TriggerError> =>
        Effect.gen(function* () {
          const rows = yield* storage(
            "read delivery",
            sql<DeliveryRow>`
              SELECT status, skip_reason
              FROM webhook_deliveries WHERE request_id = ${requestId}
            `,
          );
          const row = rows[0];
          if (row === undefined) {
            // The claim conflicted but the row is gone: a deleted dedupe fact is a broken store,
            // not a delivery to retry silently.
            return yield* new TriggerError({
              code: "storage",
              message: `delivery ${requestId} conflicted but has no row`,
            });
          }
          const reason = row.skipReason ?? undefined;
          return {
            status:
              row.status === "skipped"
                ? ("skipped" as const)
                : row.status === "processed"
                  ? ("processed" as const)
                  : ("received" as const),
            replayed: true,
            ...(reason === undefined ? {} : { reason }),
          };
        });

      const deliver = (
        delivery: TriggerDelivery,
      ): Effect.Effect<TriggerOutcome, TriggerError> =>
        Effect.gen(function* () {
          const { requestId, event } = delivery;

          // The claim. `RETURNING` on a conflicting insert yields no row, which is exactly the
          // question "am I the first?" — one statement, so two workers cannot both win.
          //
          // A key that names the work (`keyedByWork`) also wins over its own recorded
          // unregistered-repo skip: the conditional `DO UPDATE` flips that row back to `received`
          // in the same statement, so the delivery after the operator registers the repo starts the
          // session, and two such deliveries still cannot both win (the second sees `received`).
          const claimed = yield* storage(
            "claim delivery",
            delivery.keyedByWork === true
              ? sql<{ requestId: string }>`
                  INSERT INTO webhook_deliveries (request_id, status)
                  VALUES (${requestId}, 'received')
                  ON CONFLICT (request_id) DO UPDATE
                    SET status = 'received', skip_reason = NULL
                    WHERE webhook_deliveries.status = 'skipped'
                      AND webhook_deliveries.skip_reason LIKE ${UNREGISTERED_REPO_PATTERN}
                  RETURNING request_id
                `
              : sql<{ requestId: string }>`
                  INSERT INTO webhook_deliveries (request_id, status)
                  VALUES (${requestId}, 'received')
                  ON CONFLICT (request_id) DO NOTHING
                  RETURNING request_id
                `,
          );
          if (claimed.length === 0) {
            return yield* replay(requestId);
          }

          // Everything below this line is the claimed delivery, and anything that fails in it has
          // to give the claim back: a row left in `received` makes every later retry of this
          // delivery a `replayed: true` answer to work that never started, which is worse than an
          // error (LOB-188 review). Releasing it is safe because the session's own `requestId` is
          // `trigger:<requestId>`, so a retry that gets as far as `sessions.create` reuses the
          // session the failed attempt made instead of opening a second one, and its `send` carries
          // the same id, so a retry after a failed write-back finds its prompt already submitted
          // instead of appending it again (LOB-218).
          const sessionRequestId = sessionRequestIdOf(requestId);
          const claimedWork: Effect.Effect<TriggerOutcome, TriggerError> =
            Effect.gen(function* () {
              // The filter. `create` always starts work; a lifecycle action (`push`, `schedule`)
              // only when the rule that would *route* this event asked for it, so widening what the
              // docs trigger needs did not widen what every adapter accepts (LOB-197).
              //
              // The rule is the one `resolveMapping` would pick — the first that claims one of the
              // labels — not "any claiming rule": an event labelled `["ticket", "docs"]` routes to
              // the `ticket` rule, so the `docs` rule's `startsWorkFor` must not admit an action
              // that lands on the ticket rule's repo and prompt.
              const routing = options.rules.find((rule) =>
                event.labels.includes(rule.label),
              );
              const asked =
                routing?.startsWorkFor === undefined
                  ? []
                  : [routing.startsWorkFor];
              if (!startsWork(event.action, asked)) {
                return yield* skip(
                  requestId,
                  `action "${event.action}" is not ${TRIGGER_ACTIONS.map(
                    (action) => `"${action}"`,
                  ).join(", ")}`,
                );
              }

              const mapping = resolveMapping(options.rules, event);
              if (mapping === undefined) {
                return yield* skip(
                  requestId,
                  event.labels.length === 0
                    ? "the event carries no labels, so no rule maps it"
                    : `no rule matches labels [${event.labels.join(", ")}]`,
                );
              }

              // A rule can name a repo nobody registered — a configuration mistake the operator
              // fixes by registering it, so the delivery says which repo is missing rather than
              // failing.
              const registered = yield* storage(
                "read repo registry",
                sql<{ slug: string }>`
                SELECT slug FROM repos WHERE slug = ${mapping.repo}
              `,
              );
              if (registered.length === 0) {
                return yield* skip(requestId, unregisteredRepo(mapping.repo));
              }

              const session = yield* sessions.create({
                source: event.source,
                title: event.title,
                deliveryId: requestId,
                // Namespaced (`sessionRequestIdOf`): `sessions.request_id` dedupes client retries
                // too.
                requestId: sessionRequestId,
                repo: mapping.repo,
                baseRef: mapping.baseRef,
              });

              // The prompt is the session's first message, so a mapped delivery with no prompt
              // still has a session with a title rather than one that was never told why it exists.
              // Keyed on the delivery: everything after this can fail and be retried, and the
              // retry must not tell the session the same thing twice.
              yield* sessions.send({
                sessionId: session.id,
                content: mapping.prompt,
                requestId: sessionRequestId,
              });

              yield* writeBack.write({ event, sessionId: session.id });

              yield* storage(
                "record processed delivery",
                sql`UPDATE webhook_deliveries SET status = 'processed'
                  WHERE request_id = ${requestId}`,
              );

              return {
                status: "processed",
                replayed: false,
                sessionId: session.id,
                reason: `rule "${mapping.label}" mapped it to ${mapping.repo}`,
              } as const;
            });

          // Release the claim on *any* unsuccessful exit, not only a typed one: a defect in the
          // session layer (a driver error, a `die`) and an interrupt both leave the row in
          // `received`, and both would otherwise turn the sender's retry into a `replayed: true`
          // answer about work that never happened. `Effect.exit` is what sees all three, and the
          // release is uninterruptible so a cancelled request cannot skip its own cleanup.
          const releaseClaim = storage(
            "release an unclaimed delivery",
            sql`DELETE FROM webhook_deliveries WHERE request_id = ${requestId}`,
          ).pipe(
            // The original failure is what the caller needs; a failed release must not mask it.
            // The next attempt re-claims the row if this one did land.
            Effect.tapError(() =>
              Effect.logWarning(
                `trigger: could not release delivery ${requestId}`,
              ),
            ),
            Effect.ignore,
          );

          const settled = Effect.exit(claimedWork).pipe(
            Effect.flatMap((exit) =>
              Exit.isSuccess(exit)
                ? Effect.succeed(exit.value)
                : releaseClaim.pipe(
                    Effect.andThen(Effect.failCause(exit.cause)),
                  ),
            ),
            Effect.uninterruptible,
          );

          return yield* settled;
        });

      return TriggerService.of({ deliver });
    }),
  );
