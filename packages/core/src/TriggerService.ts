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
 * primary key, and the claim is a single `INSERT … ON CONFLICT … RETURNING`: the caller that gets no
 * row back is the replay, whoever it is and however many processes there are. Two simultaneous
 * deliveries of one id therefore cannot both create a session, which a read-then-insert cannot
 * promise (and which is why `api.memo` is not used here — it dedupes within one task invocation and
 * this is not a task; see LOB-178's record). The conflict only updates — and so only hands the claim
 * over — for a row that is no longer anybody's: a claim older than the reclaim window, whose process
 * died before it recorded an outcome (LOB-216).
 *
 * **The session is created by a port, not by `SessionService`.** The seam's job is to decide
 * *whether* work starts; opening a harness, a worktree and a log is the session layer's. So the
 * port is two calls (`create`, `send`) and a test can prove the dedupe against real Postgres with
 * a counting fake, while `TriggerSessionsFromSessionService` is the production wiring.
 *
 * **A card rule puts a card on the board instead (LOB-254).** A rule in `card` mode
 * (`TriggerRule.mode`) makes no session: the delivery files one card on the repo's board through a
 * second port (`TriggerCards`, `TaskService.file` in production), in the definition's initial
 * column, with the event's title, its body as the card's body and `<source>:<key>` as its external
 * ref. The card is keyed by that ref, not by the delivery, so a second, distinct delivery about the
 * same issue finds the card the first made; a repo with no board is a recorded skip that names
 * `factory board create`, and — like an unregistered repo — reclaimable by a delivery keyed by its
 * work once the operator makes one. A run starts from the card (docs/board.md B12), and the Linear
 * write-back follows the card's runs to the issue (`./LinearSync`).
 *
 * **The write-back is optional and injected.** No adapter in part 1 needs one (the generic webhook
 * has no place to write, and the Linear route only delegates), so the default is a no-op: a
 * deployment that configures no client never fails a delivery because of one.
 */
import { Context, Duration, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type {
  CreateSessionInput,
  RepoSlug,
  SessionId,
} from "@repo/domain/Session";
import { isWebLink, type TaskId } from "@repo/domain/Task";
import {
  externalRefOf,
  resolveMapping,
  ruleClaims,
  startsWork,
  TRIGGER_ACTION,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerMapping,
  type TriggerOutcome,
  type TriggerRule,
  type TriggerSource,
} from "@repo/domain/Trigger";
import { SessionService } from "./SessionService";
import { TaskService } from "./TaskService";
import { envRoutedRules, readRoutedRules } from "./TriggerRoutes";

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
  /**
   * The rules a delivery is routed with *now*: the stored routes, then the `TRIGGER_RULES` fallback
   * (LOB-266). Read per call, so a route added a moment ago is in it. An adapter normalizes against
   * this — which labels count as work, which key a delivery gets — so the key, the filter and the
   * mapping agree on which payloads a rule claims; it is the same set `deliver` maps with.
   */
  readonly rules: Effect.Effect<ReadonlyArray<TriggerRule>, TriggerError>;
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
 * What the seam needs of the board, for a rule in `card` mode (LOB-254): file one card, at most once
 * per item. `externalRef` is the dedupe key (`externalRefOf`), so an implementation answers the card
 * the board already holds for it with `created: false` rather than making a second.
 */
export type TriggerCardsShape = {
  readonly file: (input: {
    /** Where the delivery came from: the card's actor is `trigger:<source>`, as a session's is. */
    readonly source: TriggerSource;
    readonly boardId: string;
    readonly repo: RepoSlug;
    readonly title: string;
    readonly body: string;
    readonly baseRef: string | undefined;
    readonly externalRef: string;
    readonly externalUrl: string | undefined;
  }) => Effect.Effect<
    { readonly id: TaskId; readonly created: boolean },
    TriggerError
  >;
};

/**
 * The card port. Optional in the seam's requirements, unlike `TriggerSessions`: the docs and review
 * seams carry rules of their own and never file a card, so they wire none. A card rule that reaches
 * a seam with no port fails the delivery with `card-create` naming the gap — loudly, and with the
 * claim given back — rather than quietly opening a session instead.
 */
export class TriggerCards extends Context.Service<
  TriggerCards,
  TriggerCardsShape
>()("@repo/core/TriggerCards") {}

/**
 * The production card port: `TaskService.file`. A `TaskError` becomes a `TriggerError` here, so the
 * trigger path does not leak a board-shaped failure. A card whose input the service refuses (a body
 * over its cap, a base ref git would not take) fails the delivery the same way, naming the field.
 */
export const TriggerCardsFromTaskService = Layer.effect(
  TriggerCards,
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return TriggerCards.of({
      file: (input) =>
        tasks
          .file({
            boardId: input.boardId,
            repo: input.repo,
            title: input.title,
            body: input.body,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            externalRef: input.externalRef,
            ...(input.externalUrl === undefined
              ? {}
              : { externalUrl: input.externalUrl }),
            actor: triggerActorOf(input.source),
          })
          .pipe(
            Effect.map(({ task, created }) => ({ id: task.id, created })),
            Effect.mapError(
              (cause) =>
                new TriggerError({
                  code: "card-create",
                  message: `${cause._tag}: ${cause.message}`,
                }),
            ),
          ),
    });
  }),
);

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
  /**
   * Read the stored routes (`trigger_routes`, LOB-266) per delivery and consult them *before*
   * `rules`, which then are the fallback. Off by default: the docs and review seams carry rules of
   * their own, and a route an operator stored for a label must not hijack theirs.
   */
  readonly storedRoutes?: boolean;
  /**
   * What `rules` are called in a recorded reason: `<origin>[i]` after the rule's name, so an
   * operator can tell which of several rules routed a delivery (`env:TRIGGER_RULES[0]`). Absent, the
   * reason names the rule only, as it did before there were stored routes.
   */
  readonly rulesOrigin?: string;
  /**
   * How old a claim with no recorded outcome must be before another delivery of the same id may
   * take it (default `TRIGGER_RECLAIM_AFTER`). Inside the window a replay answers `received`,
   * because the first process may still be working; past it, that process is presumed dead.
   */
  readonly reclaimAfter?: Duration.Input;
};

/**
 * The default reclaim window. It has to outlast the slowest honest claim — opening a session can
 * clone a repo — and it can afford to, because guessing wrong is harmless: a reclaim of a claim
 * that was still alive re-runs `create` and `send`, and both dedupe on the delivery's own key
 * (`sessions.request_id`, and Pi Durable's submission id), so the session still gets one prompt.
 */
export const TRIGGER_RECLAIM_AFTER: Duration.Input = "10 minutes";

/**
 * What a won claim returns: the row's key, and the `claimed_at` it set, as Postgres text so the
 * release can match it exactly (a `Date` would drop the microseconds).
 */
type ClaimRow = {
  readonly requestId: string;
  readonly claim: string;
};

/** One `webhook_deliveries` row as the replay read returns it. */
type DeliveryRow = {
  readonly status: string;
  /** The outcome's recorded reason: why it was skipped, or which rule mapped a processed one. */
  readonly skipReason: string | null;
};

/**
 * The unregistered-repo skip reason, and the `LIKE` pattern that recognizes it in a recorded row.
 * One definition for both, so the reclaim cannot drift from the words the skip writes.
 */
const unregisteredRepo = (repo: RepoSlug): string =>
  `repo ${repo} is not registered`;
const UNREGISTERED_REPO_PATTERN = "repo % is not registered";

/**
 * The no-board skip reason (LOB-254), and its pattern, for the same reason: a card rule's repo with
 * no board is the other refusal an operator fixes, and a delivery keyed by its work reclaims it.
 */
const noBoard = (repo: RepoSlug): string =>
  `repo ${repo} has no board (create one with \`factory board create --repo ${repo}\`)`;
const NO_BOARD_PATTERN = "repo % has no board (%";

const toTriggerError =
  (what: string) =>
  (cause: { readonly message: string }): TriggerError =>
    new TriggerError({ code: "storage", message: `${what}: ${cause.message}` });

export const TriggerServiceLive = (options: TriggerServiceOptions) =>
  Layer.effect(
    TriggerService,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const reclaimSeconds = Duration.toSeconds(
        Duration.fromInputUnsafe(options.reclaimAfter ?? TRIGGER_RECLAIM_AFTER),
      );
      const sessions = yield* TriggerSessions;
      const cards = yield* Effect.serviceOption(TriggerCards);
      const writeBack = yield* TriggerWriteBack;
      const fallback = envRoutedRules(options.rules, options.rulesOrigin);
      /** The rule set one delivery is routed with, stored routes first (LOB-266). */
      const routed =
        options.storedRoutes === true
          ? readRoutedRules(sql, fallback).pipe(
              Effect.mapError(toTriggerError("read trigger routes")),
            )
          : Effect.succeed(fallback);

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

      /** Record a processed delivery's outcome reason, in the column a skip's reason goes in. */
      const processed = (requestId: string, reason: string) =>
        storage(
          "record processed delivery",
          sql`UPDATE webhook_deliveries
            SET status = 'processed', skip_reason = ${reason}
            WHERE request_id = ${requestId}`,
        );

      /**
       * A card rule's delivery (LOB-254): one card on the repo's board, and no session. The board is
       * the repo's one board (`createBoard` keeps it to one); none is a recorded skip naming the
       * command that makes one. The card is filed under the item's key, so this delivery and any
       * other about the same issue — a replay is answered before this, by the claim — land on one
       * card, and the reason says which happened.
       */
      const fileCard = (
        requestId: string,
        event: TriggerEvent,
        mapping: TriggerMapping,
        routedBy: string,
      ): Effect.Effect<TriggerOutcome, TriggerError> =>
        Effect.gen(function* () {
          const port = Option.getOrUndefined(cards);
          if (port === undefined) {
            return yield* new TriggerError({
              code: "card-create",
              message: `rule "${mapping.label}" files a card, but this trigger seam has no card port (TriggerCards) wired`,
            });
          }
          const boards = yield* storage(
            "read the repo's board",
            sql<{ id: string }>`
              SELECT id FROM board_instances WHERE repo = ${mapping.repo}
              ORDER BY created_at, id
              LIMIT 1
            `,
          );
          const board = boards[0];
          if (board === undefined) {
            return yield* skip(requestId, noBoard(mapping.repo));
          }
          const externalRef = externalRefOf(event);
          const card = yield* port.file({
            source: event.source,
            boardId: board.id,
            repo: mapping.repo,
            title: event.title,
            body: event.body,
            baseRef: mapping.baseRef,
            externalRef,
            // A link the card pane renders, so only a web link; an adapter that passed anything
            // else gets a card with no link rather than a delivery that fails on it.
            externalUrl:
              event.url !== undefined && isWebLink(event.url)
                ? event.url
                : undefined,
          });
          const reason = `${routedBy}: ${
            card.created ? "filed card" : "already on the board as card"
          } ${card.id} (${externalRef}) on board ${board.id}`;
          yield* processed(requestId, reason);
          return {
            status: "processed",
            replayed: false,
            taskId: card.id,
            reason,
          } as const;
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
          //
          // Any delivery also wins over a *stale* claim: a row still `received` whose claim is older
          // than `reclaimAfter` belongs to a process that died between its claim and its outcome
          // (a `SIGKILL` runs no release), and answering it `replayed` would be a success to work
          // that never started (LOB-216). The reclaim is the same conditional `DO UPDATE`, and it
          // renews `claimed_at`, so of two retries that race for a stale row only the first wins —
          // the second re-reads a fresh claim and is the replay.
          const claimed = yield* storage(
            "claim delivery",
            delivery.keyedByWork === true
              ? sql<ClaimRow>`
                  INSERT INTO webhook_deliveries (request_id, status)
                  VALUES (${requestId}, 'received')
                  ON CONFLICT (request_id) DO UPDATE
                    SET status = 'received', skip_reason = NULL, claimed_at = now()
                    WHERE (webhook_deliveries.status = 'skipped'
                        AND (webhook_deliveries.skip_reason LIKE ${UNREGISTERED_REPO_PATTERN}
                          OR webhook_deliveries.skip_reason LIKE ${NO_BOARD_PATTERN}))
                      OR (webhook_deliveries.status = 'received'
                        AND webhook_deliveries.claimed_at < now() - make_interval(secs => ${reclaimSeconds}))
                  RETURNING request_id, claimed_at::text AS claim
                `
              : sql<ClaimRow>`
                  INSERT INTO webhook_deliveries (request_id, status)
                  VALUES (${requestId}, 'received')
                  ON CONFLICT (request_id) DO UPDATE
                    SET claimed_at = now()
                    WHERE webhook_deliveries.status = 'received'
                      AND webhook_deliveries.claimed_at < now() - make_interval(secs => ${reclaimSeconds})
                  RETURNING request_id, claimed_at::text AS claim
                `,
          );
          const claim = claimed[0]?.claim;
          if (claim === undefined) {
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
              const matched = (yield* routed).find((candidate) =>
                ruleClaims(candidate.rule, event),
              );
              const routing = matched?.rule;
              const asked =
                routing?.startsWorkFor === undefined
                  ? []
                  : [routing.startsWorkFor];
              if (!startsWork(event.action, asked)) {
                // The reason names what *this* rule admits, not every action the seam knows: a
                // caller told `is not "create", "push", "schedule"` would read the lifecycle
                // actions as open to it, and the generic webhook refuses both (LOB-235).
                const admitted = [TRIGGER_ACTION, ...asked.flat()];
                return yield* skip(
                  requestId,
                  `action "${event.action}" is not ${admitted
                    .map((action) => `"${action}"`)
                    .join(", ")}`,
                );
              }

              // The rule the filter consulted is the one that maps, and its origin comes from the same
              // list, so the reason cannot name a rule other than the one that chose the repo.
              const mapping =
                matched === undefined
                  ? undefined
                  : resolveMapping([matched.rule], event);
              if (matched === undefined || mapping === undefined) {
                return yield* skip(
                  requestId,
                  `${
                    event.labels.length === 0
                      ? "the event carries no labels, so no rule maps it"
                      : `no rule matches labels [${event.labels.join(", ")}]`
                  }${event.team === undefined ? "" : ` in team ${event.team}`}`,
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

              // What the delivery's recorded reason says chose the repo, whichever thing it starts.
              const routedBy = `rule "${mapping.label}"${
                matched.origin === undefined ? "" : ` (${matched.origin})`
              } mapped it to ${mapping.repo}`;

              if (mapping.mode === "card") {
                return yield* fileCard(requestId, event, mapping, routedBy);
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

              // The reason is stored with the outcome, in the same column a skip's reason goes in
              // (`skip_reason` is the delivery's recorded outcome reason, whatever the outcome), so a
              // replay of a processed delivery names the route that started it, and so does the row
              // an operator reads after the first response is gone.
              const reason = routedBy;
              yield* processed(requestId, reason);

              return {
                status: "processed",
                replayed: false,
                sessionId: session.id,
                reason,
              } as const;
            });

          // Release the claim on *any* unsuccessful exit, not only a typed one: a defect in the
          // session layer (a driver error, a `die`) and an interrupt both leave the row in
          // `received`, and both would otherwise turn the sender's retry into a `replayed: true`
          // answer about work that never happened. `Effect.exit` is what sees all three, and the
          // release is uninterruptible so a cancelled request cannot skip its own cleanup. What it
          // cannot cover is a process that runs no cleanup at all (`SIGKILL`); the claim's
          // `claimed_at` and the reclaim window above are what recover that row. The release is
          // scoped to this attempt's own claim (`claimed_at` as the claim returned it, as text so
          // its microseconds survive the round trip): a process slow enough to have been reclaimed
          // meanwhile must not delete the reclaimer's row, or a third retry would claim it afresh
          // and run `create` and `send` beside the reclaimer that is still working.
          const releaseClaim = storage(
            "release an unclaimed delivery",
            sql`DELETE FROM webhook_deliveries
                WHERE request_id = ${requestId}
                  AND claimed_at = ${claim}::timestamptz`,
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

      return TriggerService.of({
        deliver,
        rules: routed.pipe(
          Effect.map((candidates) => candidates.map(({ rule }) => rule)),
        ),
      });
    }),
  );
