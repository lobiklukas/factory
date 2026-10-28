/**
 * The trigger seam against the real delivery store (LOB-188).
 *
 * What only a database can prove: two deliveries with one request id start one piece of work, and
 * the loser says `replayed`. A read-then-insert would pass a single-threaded case and fail the
 * concurrent one, so the case below fires both at once — the claim is `INSERT … ON CONFLICT …
 * RETURNING`. Firing them at once is not enough on its own: the first delivery's read and insert
 * usually land before the second's read, so the case holds the key in an uncommitted insert until
 * both deliveries are queued on it (`holdKeyUntilContended`, LOB-219). A mutation that removes the
 * claim, or that replaces it with a `SELECT` first, then turns "exactly one winner" red every run.
 *
 * What a race *cannot* prove is which of two honest answers the loser gives: it reads the row the
 * winner claimed, and whether the winner has recorded its outcome by then is a scheduling fact
 * (LOB-217). So the concurrent case asserts the outcome set, and the case after it holds the
 * winner inside that window with a `Deferred` and pins the in-flight answer exactly.
 *
 * The sessions are a counting fake: the seam's question is *whether* work starts, and a real
 * harness would prove the same count more slowly. `verify-api`'s `webhook.ts` drive is where the
 * same path runs with the real `SessionService`.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row this file writes carries a
 * per-run id, so it is safe against a database other suites also use.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import {
  externalRefOf,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  MAX_TASK_BODY_CHARS,
} from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { linearDeliveryFor } from "./Linear";
import { SENTRY_LABEL, sentryDelivery } from "./Sentry";
import {
  TriggerRoutes,
  TriggerRoutesLive,
  type TriggerRoutesShape,
} from "./TriggerRoutes";
import { TaskService, TaskServiceLive } from "./TaskService";
import {
  cardBodyOf,
  NoCards,
  NoWriteBack,
  sessionRequestIdOf,
  TriggerCardsFromTaskService,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  triggerActorOf,
  TriggerWriteBack,
  type TriggerServiceShape,
  type TriggerSessionsShape,
  type TriggerWriteBackShape,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");

/** One fake session, as the seam sees it: an id and the messages that were sent to it. */
type Created = {
  readonly id: SessionId;
  /** The delivery's source, which the session port turns into the session's actor (LOB-162). */
  readonly source: string;
  readonly requestId: string;
  readonly title: string;
  readonly repo: RepoSlug;
  readonly baseRef: string | undefined;
  /** Every message the session admitted, in order: what a retry that re-sends would grow. */
  readonly messages: Array<string>;
  /** The send request ids it admitted, which is the dedupe Pi Durable keeps per conversation. */
  readonly sendRequestIds: Set<string>;
};

const repo = "acme/widgets" as RepoSlug;
const otherRepo = "acme/gadgets" as RepoSlug;
/**
 * A repo that only this case's own registration can create — per-run, because the suite shares a
 * database with other suites and a slug that was ever registered stays registered.
 */
const unregisteredRepo = `acme/unregistered-${runId}` as RepoSlug;

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo,
    baseRef: "main",
    prompt: "Work on {{title}}:\n{{body}}",
  },
  { label: "factory-elsewhere", repo: otherRepo, prompt: "{{key}}" },
  { label: "factory-unregistered", repo: unregisteredRepo, prompt: "{{key}}" },
  // A rule that admits the two lifecycle actions (LOB-197). It is *last*, so an event carrying both
  // `factory` and `docs` routes to the `factory` rule — which is the case below.
  {
    label: "factory-docs",
    repo: otherRepo,
    prompt: "{{key}}",
    startsWorkFor: ["push", "schedule"],
  },
];

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  source: "generic",
  key: `${runId}-issue`,
  action: "create",
  title: "Fix the widget",
  body: "The widget wobbles.",
  labels: ["factory"],
  ...over,
});

type Harness = {
  /** Run one effect on the seam's runtime — the only context that holds the delivery store. */
  readonly run: <A>(
    effect: Effect.Effect<A, TriggerError, never>,
  ) => Promise<A>;
  readonly trigger: TriggerServiceShape;
  /** The stored routes (LOB-266), on the same database the seam reads them from. */
  readonly routes: TriggerRoutesShape;
  readonly created: Array<Created>;
  /** The session id of every write-back the seam attempted, failed ones included. */
  readonly writeBacks: Array<SessionId>;
};

const withRuntime = async <A>(
  body: (harness: Harness) => Promise<A>,
  options: {
    readonly registerRepo?: ReadonlyArray<RepoSlug>;
    /** The seam's fallback rules, when a case needs other than `rules` (the env's, in production). */
    readonly rules?: ReadonlyArray<TriggerRule>;
    /** Read the stored routes per delivery, as the API's seam does (LOB-266). */
    readonly storedRoutes?: boolean;
    /** What the fallback rules are called in a reason (`env:TRIGGER_RULES`, in production). */
    readonly rulesOrigin?: string;
    /** The seam's reclaim window, when a case needs one other than the default. */
    readonly reclaimAfter?: Duration.Input;
    /** Fail the first `create` this many times, as a session layer under stress would. */
    readonly failCreateTimes?: number;
    /** Die (a defect, not a typed failure) on the first `create` that many times. */
    readonly dieCreateTimes?: number;
    /**
     * Fail the write-back this many times — *after* the prompt was sent, the failure the existing
     * retry cases (which fail in `create`) do not reach (LOB-218).
     */
    readonly failWriteBackTimes?: number;
    /**
     * Fail every `send` as the session layer does when the session's worktree setup failed
     * (S-env-setup), counting each attempt: the prompt is never sent.
     */
    readonly failSetup?: { attempts: number };
    /**
     * Park the winning delivery in `send`, i.e. after its claim and before its outcome, until
     * `release` fires: the window in which a second delivery of the same id is a replay of work
     * that is still running.
     */
    readonly holdInFlight?: {
      readonly arrived: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {},
): Promise<A> => {
  const created: Array<Created> = [];
  let failuresLeft = options.failCreateTimes ?? 0;
  let deathsLeft = options.dieCreateTimes ?? 0;
  let writeBackFailuresLeft = options.failWriteBackTimes ?? 0;
  const writeBacks: Array<SessionId> = [];
  const sessions: TriggerSessionsShape = {
    create: (input) =>
      Effect.suspend(
        (): Effect.Effect<{ readonly id: SessionId }, TriggerError> => {
          if (deathsLeft > 0) {
            deathsLeft -= 1;
            return Effect.die(new Error("the session layer died"));
          }
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            return Effect.fail(
              new TriggerError({
                code: "session-create",
                message: "the session layer is unavailable",
              }),
            );
          }
          return Effect.sync(() => {
            // `SessionService.create` dedupes on `sessions.request_id`, so a retry that reaches
            // `create` again gets the session its first attempt opened. The fake keeps that, or a
            // retry after the send could not tell "one session, one message" from two sessions.
            const existing = created.find(
              (entry) => entry.requestId === input.requestId,
            );
            if (existing !== undefined) return { id: existing.id };
            // The count is what the cases assert; the id only has to be a well-formed session id.
            const id =
              `ses_${String(created.length + 1).padStart(26, "0")}` as SessionId;
            created.push({
              id,
              source: input.source,
              requestId: input.requestId,
              title: input.title,
              repo: input.repo,
              baseRef: input.baseRef,
              messages: [],
              sendRequestIds: new Set(),
            });
            return { id };
          });
        },
      ),
    send: (input) =>
      Effect.gen(function* () {
        const setup = options.failSetup;
        if (setup !== undefined) {
          setup.attempts += 1;
          return yield* new TriggerError({
            code: "setup-failed",
            message: `session ${input.sessionId}: setup failed: install \`bun install\` exited 1 in /w\nerror: registry unreachable`,
          });
        }
        const hold = options.holdInFlight;
        if (hold !== undefined) {
          yield* Deferred.succeed(hold.arrived, undefined);
          yield* Deferred.await(hold.release);
        }
        const entry = created.find((entry) => entry.id === input.sessionId);
        // Pi Durable's submission dedupe: a request id this conversation already admitted returns
        // the existing submission rather than appending a second message.
        if (entry === undefined || entry.sendRequestIds.has(input.requestId)) {
          return;
        }
        entry.sendRequestIds.add(input.requestId);
        entry.messages.push(input.content);
      }),
  };
  const writeBack: TriggerWriteBackShape = {
    write: (input) =>
      Effect.suspend(() => {
        writeBacks.push(input.sessionId);
        if (writeBackFailuresLeft > 0) {
          writeBackFailuresLeft -= 1;
          return Effect.fail(
            new TriggerError({
              code: "write-back",
              message: "the tracker answered 500",
            }),
          );
        }
        return Effect.void;
      }),
  };

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      TriggerServiceLive({
        rules: options.rules ?? rules,
        ...(options.storedRoutes === true ? { storedRoutes: true } : {}),
        ...(options.rulesOrigin === undefined
          ? {}
          : { rulesOrigin: options.rulesOrigin }),
        ...(options.reclaimAfter === undefined
          ? {}
          : { reclaimAfter: options.reclaimAfter }),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TriggerSessions, TriggerSessions.of(sessions)),
            Layer.succeed(TriggerWriteBack, TriggerWriteBack.of(writeBack)),
            NoCards,
          ),
        ),
      ),
      TriggerRoutesLive,
    ).pipe(Layer.provide(Layer.mergeAll(DatabaseLive, BunServices.layer))),
  );

  try {
    const trigger = await runtime.runPromise(TriggerService);
    const routes = await runtime.runPromise(TriggerRoutes);
    // The registry is a real row: `unregistered-repo` is the seam's refusal, and a case that
    // asserts it has to be able to register the repo and watch a later delivery succeed.
    if (options.registerRepo !== undefined) {
      const slugs = options.registerRepo;
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            for (const slug of slugs) {
              yield* sql`INSERT INTO repos (slug) VALUES (${slug})
                         ON CONFLICT (slug) DO NOTHING`;
            }
          }),
          DatabaseLive,
        ),
      );
    }
    const run: Harness["run"] = (effect) => runtime.runPromise(effect);
    return await body({ run, trigger, routes, created, writeBacks });
  } finally {
    await runtime.dispose();
  }
};

/**
 * Leave a claim behind the way a killed process does: the row is `received`, and nothing will ever
 * record its outcome or release it. `age` is how long ago the claim was taken, as a Postgres
 * interval.
 */
const writeOrphanedClaim = (requestId: string, age: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          INSERT INTO webhook_deliveries (request_id, status, received_at, claimed_at)
          VALUES (${requestId}, 'received', now() - ${age}::interval, now() - ${age}::interval)
        `;
      }),
      DatabaseLive,
    ),
  );

/** Push a live claim back in time, as a process that outlives the reclaim window would see it. */
const ageClaim = (requestId: string, age: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          UPDATE webhook_deliveries SET claimed_at = now() - ${age}::interval
          WHERE request_id = ${requestId}
        `;
      }),
      DatabaseLive,
    ),
  );

/** The delivery's recorded status, or `undefined` when it has no row. */
const deliveryStatus = (requestId: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ status: string }>`
          SELECT status FROM webhook_deliveries WHERE request_id = ${requestId}
        `;
        return rows[0]?.status;
      }),
      DatabaseLive,
    ),
  );

/** How the key holder below ends its transaction: failing with this rolls its row back. */
class ReleaseKey extends Schema.TaggedError<ReleaseKey>()("ReleaseKey", {}) {}

/**
 * Hold `requestId`'s key in an uncommitted insert until `contenders` other backends are queued
 * behind it, then roll it back. Postgres makes an insert of a key that an open transaction already
 * inserted wait for that transaction, while a `SELECT` cannot see the uncommitted row: so by the
 * time any contender can land its row, every one of them has read "no delivery yet" and reached its
 * own insert. That is the interleaving a read-then-insert loses, made the only one the race case
 * runs. Left to the scheduler, the first delivery's read and insert finish before the second's read
 * starts, and a read-then-insert passes the race 20 times out of 20 (LOB-219).
 *
 * `held` fires once the row is in, so the deliveries start after it. The wait is bounded: a seam
 * that never inserts the key fails the case with this message instead of hanging it. Only this key
 * is held, so suites sharing the database never queue behind it.
 */
const holdKeyUntilContended = (
  requestId: string,
  options: {
    readonly held: Deferred.Deferred<void>;
    readonly contenders: number;
  },
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO webhook_deliveries (request_id, status)
                VALUES (${requestId}, 'received')
              `;
              yield* Deferred.succeed(options.held, undefined);
              // `pg_locks`, not `pg_stat_activity`: a backend reads the activity view from one
              // snapshot for the life of its transaction, and this transaction stays open.
              yield* sql<{ waiting: number }>`
                SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks
                WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
              `.pipe(
                Effect.map((rows) => rows[0]?.waiting ?? 0),
                Effect.repeat({
                  until: (waiting) => waiting >= options.contenders,
                  schedule: Schedule.spaced(Duration.millis(10)),
                }),
                Effect.timeoutOrElse({
                  duration: Duration.seconds(20),
                  orElse: () =>
                    Effect.die(
                      new Error(
                        `fewer than ${options.contenders} deliveries ever waited on the claim of ${requestId}`,
                      ),
                    ),
                }),
              );
              return yield* new ReleaseKey();
            }),
          )
          .pipe(Effect.catchTag("ReleaseKey", () => Effect.void));
      }),
      DatabaseLive,
    ),
  );

const deliver = (requestId: string, over: Partial<TriggerEvent> = {}) =>
  ({
    requestId,
    event: event(over),
  }) satisfies TriggerDelivery;

describe("the trigger seam", () => {
  it("creates exactly one session when two deliveries race, and the loser says replayed", async () => {
    await withRuntime(
      async ({ run, trigger, created, writeBacks }) => {
        const requestId = `${runId}-race`;
        const held = Deferred.makeUnsafe<void>();
        const holding = holdKeyUntilContended(requestId, {
          held,
          contenders: 2,
        });
        // Raced against the holder, so a holder that fails before its row is in fails the case.
        await Promise.race([run(Deferred.await(held)), holding]);
        const [outcomes] = await Promise.all([
          run(
            Effect.all(
              [
                trigger.deliver(deliver(requestId)),
                trigger.deliver(deliver(requestId)),
              ],
              { concurrency: "unbounded" },
            ),
          ),
          holding,
        ]);

        expect(created).toHaveLength(1);
        // The fake dedupes `create` on the session request id, as `SessionService` does, so two
        // winners would still count one session; the second tracker comment is what they cannot
        // hide, and it is what the sender's issue would show.
        expect(writeBacks).toHaveLength(1);
        const first = outcomes.filter((outcome) => !outcome.replayed);
        const replays = outcomes.filter((outcome) => outcome.replayed);
        expect(first).toHaveLength(1);
        expect(replays).toHaveLength(1);
        expect(first[0]?.sessionId).toBe(created[0]?.id);
        expect(first[0]?.status).toBe("processed");
        // The loser answers what the winner had recorded when it read the row: `processed` once
        // the winner had finished, `received` while it was still working (`TriggerOutcome` says
        // so). Which one a loaded machine sees is a scheduling fact the seam never promised, so
        // this case asserts the set; the case below pins each member exactly (LOB-217).
        expect(["processed", "received"]).toContain(replays[0]?.status);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("answers a delivery that arrives mid-flight with received, and its session is not a second one", async () => {
    const holdInFlight = {
      arrived: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    await withRuntime(
      async ({ run, trigger, created }) => {
        const requestId = `${runId}-inflight`;
        // Not awaited: the winner claims the row, opens its session, and parks in `send`.
        const winner = run(trigger.deliver(deliver(requestId)));
        try {
          // Raced against the winner, so a winner that fails before `send` — and so never arrives —
          // fails this case with its own cause instead of waiting out the timeout. The race also
          // leaves the winner handled when an assertion below throws.
          await Promise.race([
            run(Deferred.await(holdInFlight.arrived)),
            winner,
          ]);

          // The second delivery lands inside the window between the claim and the outcome.
          const loser = await run(trigger.deliver(deliver(requestId)));
          expect(loser.replayed).toBe(true);
          expect(loser.status).toBe("received");
          expect(loser.sessionId).toBeUndefined();
          expect(created).toHaveLength(1);
        } finally {
          // A failed assertion must not leave the winner parked: the runtime's dispose waits.
          await run(Deferred.succeed(holdInFlight.release, undefined));
        }

        const won = await winner;
        expect(won.replayed).toBe(false);
        expect(won.status).toBe("processed");
        expect(won.sessionId).toBe(created[0]?.id);
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo], holdInFlight },
    );
  }, 60_000);

  it("records a replay of a finished delivery without creating a second session", async () => {
    await withRuntime(
      async ({ run, trigger, created }) => {
        const requestId = `${runId}-again`;
        const first = await run(trigger.deliver(deliver(requestId)));
        const second = await run(trigger.deliver(deliver(requestId)));

        expect(first.status).toBe("processed");
        expect(first.replayed).toBe(false);
        expect(second.replayed).toBe(true);
        // The other member of the set the concurrent case accepts: a replay of a *finished*
        // delivery answers its outcome. Sequential, so this one can be exact.
        expect(second.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("filters an action that is not a create, records why, and creates nothing", async () => {
    await withRuntime(
      async ({ run, trigger, created }) => {
        const requestId = `${runId}-update`;
        const outcome = await run(
          trigger.deliver(deliver(requestId, { action: "update" })),
        );

        expect(outcome.status).toBe("skipped");
        expect(outcome.replayed).toBe(false);
        // The reason names what the routing rule admits — `factory` asks for nothing beyond a
        // create — rather than every action the seam knows (LOB-235).
        expect(outcome.reason).toBe('action "update" is not "create"');
        expect(created).toHaveLength(0);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("refuses a lifecycle action no rule asked for, so a caller cannot name a push", async () => {
    // `create` always starts work; `push` and `schedule` only when a rule claiming the event asks
    // for them (LOB-197). The generic webhook's `action` is whatever its caller typed, so this is
    // the case that keeps widening the filter for the docs trigger from widening it for everyone.
    await withRuntime(
      async ({ run, trigger, created }) => {
        const outcome = await run(
          trigger.deliver(deliver(`${runId}-push`, { action: "push" })),
        );

        expect(outcome.status).toBe("skipped");
        expect(outcome.reason).toContain('action "push"');
        expect(created).toHaveLength(0);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("admits a lifecycle action only through the rule the mapping routes to", async () => {
    // The filter and the router must pick the same rule: `factory-docs` asks for `push`, but an
    // event labelled `["factory", "factory-docs"]` routes to `factory` (it is first), so a push
    // there would land on the wrong rule's repo and prompt. Same event with only the docs label is
    // the delivery the docs trigger means.
    await withRuntime(
      async ({ run, trigger, created }) => {
        const both = await run(
          trigger.deliver(
            deliver(`${runId}-two-labels`, {
              action: "push",
              labels: ["factory", "factory-docs"],
            }),
          ),
        );
        expect(both.status).toBe("skipped");
        expect(both.reason).toBe('action "push" is not "create"');
        expect(created).toHaveLength(0);

        // The docs rule's refusal names what *it* admits, so the reason and the filter agree.
        const docsEdit = await run(
          trigger.deliver(
            deliver(`${runId}-docs-update`, {
              action: "update",
              labels: ["factory-docs"],
            }),
          ),
        );
        expect(docsEdit.status).toBe("skipped");
        expect(docsEdit.reason).toBe(
          'action "update" is not "create", "push", "schedule"',
        );
        expect(created).toHaveLength(0);

        const docsOnly = await run(
          trigger.deliver(
            deliver(`${runId}-docs-label`, {
              action: "push",
              labels: ["factory-docs"],
            }),
          ),
        );
        expect(docsOnly.status).toBe("processed");
        expect(created).toHaveLength(1);
        expect(created[0]?.repo).toBe(otherRepo);
      },
      { registerRepo: [repo, otherRepo] },
    );
  }, 60_000);

  it("refuses a delivery no rule matches, naming the labels", async () => {
    await withRuntime(
      async ({ run, trigger, created }) => {
        const outcome = await run(
          trigger.deliver(
            deliver(`${runId}-unmapped`, { labels: ["nothing"] }),
          ),
        );

        expect(outcome.status).toBe("skipped");
        expect(outcome.reason).toBe("no rule matches labels [nothing]");
        expect(created).toHaveLength(0);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("refuses a rule whose repo is unregistered, and records the refusal even after registering it", async () => {
    const requestId = `${runId}-registry`;
    const unregistered = { labels: ["factory-unregistered"] } as const;
    const skipped = await withRuntime(async ({ run, trigger, created }) => {
      const outcome = await run(
        trigger.deliver(deliver(requestId, unregistered)),
      );
      expect(created).toHaveLength(0);
      return outcome;
    });

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe(`repo ${unregisteredRepo} is not registered`);

    // Registering the repo does not rewrite a recorded refusal: the delivery was answered, and a
    // retry of the same id is a replay, not a second chance.
    const replay = await withRuntime(
      async ({ run, trigger }) =>
        run(trigger.deliver(deliver(requestId, unregistered))),
      { registerRepo: [unregisteredRepo] },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("skipped");

    // A *new* delivery of the same event is what an operator's retry looks like.
    const fresh = await withRuntime(
      async ({ run, trigger, created }) => {
        const outcome = await run(
          trigger.deliver(deliver(`${requestId}-retry`, unregistered)),
        );
        expect(created).toHaveLength(1);
        return outcome;
      },
      { registerRepo: [unregisteredRepo] },
    );
    expect(fresh.status).toBe("processed");
  }, 90_000);

  it("gives the claim back when the session cannot be created, so a retry starts the work", async () => {
    const requestId = `${runId}-recover`;
    await withRuntime(
      async ({ run, trigger, created }) => {
        const failed = await run(
          Effect.exit(trigger.deliver(deliver(requestId))),
        );
        expect(failed._tag).toBe("Failure");
        expect(created).toHaveLength(0);

        // The retry is the *same* delivery, and it must run rather than answer `replayed` to work
        // that never happened. `SessionService.create` dedupes on `trigger:<requestId>`, so even a
        // failure after a session was opened reuses that session instead of opening a second one.
        const retried = await run(trigger.deliver(deliver(requestId)));
        expect(retried.replayed).toBe(false);
        expect(retried.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo], failCreateTimes: 1 },
    );
  }, 60_000);

  it("gives the claim back even when the session layer dies rather than failing", async () => {
    const requestId = `${runId}-defect`;
    await withRuntime(
      async ({ run, trigger, created }) => {
        const died = await run(
          Effect.exit(trigger.deliver(deliver(requestId))),
        );
        expect(died._tag).toBe("Failure");
        expect(created).toHaveLength(0);

        // A defect is not a typed failure: `Effect.tapError` would have skipped the release here.
        const retried = await run(trigger.deliver(deliver(requestId)));
        expect(retried.replayed).toBe(false);
        expect(retried.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo], dieCreateTimes: 1 },
    );
  }, 60_000);

  it("records a session whose setup failed as the delivery's outcome, so a retry does not set it up again", async () => {
    // S-env-setup: the send fails because the session's worktree setup did. That is the delivery's
    // result, not a failure to retry: the claim is kept and the sender's retry is a replay.
    const requestId = `${runId}-setup-failed`;
    const failSetup = { attempts: 0 };
    await withRuntime(
      async ({ run, trigger, created }) => {
        const first = await run(trigger.deliver(deliver(requestId)));
        expect(first.status).toBe("processed");
        expect(first.sessionId).toBe(created[0]?.id);
        expect(first.reason).toContain("worktree setup failed");
        expect(first.reason).toContain("exited 1");
        // The reason is one line: the output's tail is the session's log, not the delivery's.
        expect(first.reason).not.toContain("registry unreachable");
        expect(created[0]?.messages).toEqual([]);

        const retried = await run(trigger.deliver(deliver(requestId)));
        expect(retried.replayed).toBe(true);
        expect(retried.reason).toBe(first.reason);
        expect(failSetup.attempts).toBe(1);
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo], failSetup },
    );
  }, 60_000);

  it("does not send the prompt again when a delivery fails after the send and is retried", async () => {
    // LOB-218: the cases above fail in `create`, before anything reached the session. This one
    // fails in the write-back, after the prompt was sent: the claim is given back, the sender
    // retries, and the retry runs `create` (which reuses the session) and `send` again. Without the
    // send's request id the session holds the prompt twice.
    const requestId = `${runId}-after-send`;
    await withRuntime(
      async ({ run, trigger, created, writeBacks }) => {
        const failed = await run(
          Effect.exit(trigger.deliver(deliver(requestId))),
        );
        expect(failed._tag).toBe("Failure");
        // The failure is the write-back's, so the prompt had already been sent.
        expect(created).toHaveLength(1);
        expect(created[0]?.messages).toHaveLength(1);

        const retried = await run(trigger.deliver(deliver(requestId)));
        expect(retried.replayed).toBe(false);
        expect(retried.status).toBe("processed");
        expect(retried.sessionId).toBe(created[0]?.id);
        // One delivery, one session, one message — however many times the sender tried.
        expect(created).toHaveLength(1);
        expect(created[0]?.messages).toEqual([
          "Work on Fix the widget:\nThe widget wobbles.",
        ]);
        // The retry did reach the write-back again: it is the send alone that dedupes.
        expect(writeBacks).toEqual([created[0]?.id, created[0]?.id]);
      },
      { registerRepo: [repo], failWriteBackTimes: 1 },
    );
  }, 60_000);

  it("reclaims a delivery whose process died between its claim and its outcome", async () => {
    // LOB-216: a `SIGKILL` after the claim runs no release, so the row stays `received`. Before the
    // reclaim window every retry answered `replayed: true` to work that never started; an hour-old
    // claim is far past the default window, so the retry is the delivery that does the work.
    const requestId = `${runId}-orphaned`;
    await writeOrphanedClaim(requestId, "1 hour");
    await withRuntime(
      async ({ run, trigger, created }) => {
        const reclaimed = await run(trigger.deliver(deliver(requestId)));
        expect(reclaimed.replayed).toBe(false);
        expect(reclaimed.status).toBe("processed");
        expect(reclaimed.sessionId).toBe(created[0]?.id);
        expect(created).toHaveLength(1);
        expect(created[0]?.messages).toEqual([
          "Work on Fix the widget:\nThe widget wobbles.",
        ]);

        // The reclaim recorded its outcome on the same row, so the next retry is an honest replay.
        const again = await run(trigger.deliver(deliver(requestId)));
        expect(again.replayed).toBe(true);
        expect(again.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("leaves a claim inside the window alone, and measures the window it was given", async () => {
    // Two minutes old: inside the default window, so the first process may still be working and
    // the retry is a replay of work in flight. The same row under a one-minute window is stale.
    const requestId = `${runId}-young-claim`;
    await writeOrphanedClaim(requestId, "2 minutes");
    await withRuntime(
      async ({ run, trigger, created }) => {
        const replay = await run(trigger.deliver(deliver(requestId)));
        expect(replay.replayed).toBe(true);
        expect(replay.status).toBe("received");
        expect(created).toHaveLength(0);
      },
      { registerRepo: [repo] },
    );
    await withRuntime(
      async ({ run, trigger, created }) => {
        const reclaimed = await run(trigger.deliver(deliver(requestId)));
        expect(reclaimed.replayed).toBe(false);
        expect(reclaimed.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo], reclaimAfter: "1 minute" },
    );
  }, 60_000);

  it("renews a reclaimed claim, so a retry that lands while the reclaimer works is a replay", async () => {
    // The reclaim sets `claimed_at` in the statement that takes the row. Without that the row would
    // still look stale to the next retry, and every retry inside the reclaimer's own window would
    // take the work again. The reclaimer parks in `send`; the retry comes from a second runtime —
    // a second process — so it shares the row and nothing else.
    const requestId = `${runId}-orphaned-renew`;
    await writeOrphanedClaim(requestId, "1 hour");
    const holdInFlight = {
      arrived: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    await withRuntime(
      async ({ run, trigger, created }) => {
        const reclaimer = run(trigger.deliver(deliver(requestId)));
        try {
          await Promise.race([
            run(Deferred.await(holdInFlight.arrived)),
            reclaimer,
          ]);
          const retry = await withRuntime(
            async (other) => {
              const outcome = await other.run(
                other.trigger.deliver(deliver(requestId)),
              );
              expect(other.created).toHaveLength(0);
              return outcome;
            },
            { registerRepo: [repo] },
          );
          expect(retry.replayed).toBe(true);
          expect(retry.status).toBe("received");
        } finally {
          await run(Deferred.succeed(holdInFlight.release, undefined));
        }

        const reclaimed = await reclaimer;
        expect(reclaimed.replayed).toBe(false);
        expect(reclaimed.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo], holdInFlight },
    );
  }, 60_000);

  it("lets a slow process whose claim was reclaimed release only its own claim, not the reclaimer's", async () => {
    // A process alive past the window is indistinguishable from a dead one, so its claim is taken.
    // When it then fails, its release must not delete the row the reclaimer now holds: a third
    // retry would claim it afresh and run `create` and `send` beside the reclaimer. Three runtimes
    // are three processes sharing the row. Without the release's `claimed_at` guard the third
    // delivery wins a fresh claim and opens a session.
    const requestId = `${runId}-slow-release`;
    const slowHold = {
      arrived: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    const reclaimerHold = {
      arrived: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    await withRuntime(
      async (slowProcess) => {
        // The slow process claims, parks in `send`, and will fail its write-back once released.
        const slow = slowProcess.run(
          Effect.exit(slowProcess.trigger.deliver(deliver(requestId))),
        );
        try {
          await Promise.race([
            slowProcess.run(Deferred.await(slowHold.arrived)),
            slow,
          ]);
          // Its claim outlives the window without its process dying.
          await ageClaim(requestId, "1 hour");

          await withRuntime(
            async (reclaimerProcess) => {
              const reclaimer = reclaimerProcess.run(
                reclaimerProcess.trigger.deliver(deliver(requestId)),
              );
              try {
                await Promise.race([
                  reclaimerProcess.run(Deferred.await(reclaimerHold.arrived)),
                  reclaimer,
                ]);

                // The slow process wakes, fails, and releases — what it releases is the question.
                await slowProcess.run(
                  Deferred.succeed(slowHold.release, undefined),
                );
                expect((await slow)._tag).toBe("Failure");
                expect(await deliveryStatus(requestId)).toBe("received");

                const third = await withRuntime(
                  async (thirdProcess) => {
                    const outcome = await thirdProcess.run(
                      thirdProcess.trigger.deliver(deliver(requestId)),
                    );
                    expect(thirdProcess.created).toHaveLength(0);
                    return outcome;
                  },
                  { registerRepo: [repo] },
                );
                expect(third.replayed).toBe(true);
                expect(third.status).toBe("received");
              } finally {
                await reclaimerProcess.run(
                  Deferred.succeed(reclaimerHold.release, undefined),
                );
              }

              const reclaimed = await reclaimer;
              expect(reclaimed.replayed).toBe(false);
              expect(reclaimed.status).toBe("processed");
              expect(reclaimerProcess.created).toHaveLength(1);
              expect(await deliveryStatus(requestId)).toBe("processed");
            },
            { registerRepo: [repo], holdInFlight: reclaimerHold },
          );
        } finally {
          await slowProcess.run(Deferred.succeed(slowHold.release, undefined));
          await slow;
        }
      },
      { registerRepo: [repo], holdInFlight: slowHold, failWriteBackTimes: 1 },
    );
  }, 60_000);

  it("reclaims a stale claim for a delivery keyed by the work, too", async () => {
    // A work-keyed delivery (the Linear adapter's issue key) has its own conflict clause — the
    // unregistered-repo reclaim — and the stale-claim reclaim has to be in that one as well.
    const requestId = `${runId}-orphaned-keyed`;
    await writeOrphanedClaim(requestId, "1 hour");
    await withRuntime(
      async ({ run, trigger, created }) => {
        const reclaimed = await run(
          trigger.deliver({ ...deliver(requestId), keyedByWork: true }),
        );
        expect(reclaimed.replayed).toBe(false);
        expect(reclaimed.status).toBe("processed");
        expect(created).toHaveLength(1);
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("sends the rendered prompt as the session's first message", async () => {
    await withRuntime(
      async ({ run, trigger, created }) => {
        const outcome = await run(trigger.deliver(deliver(`${runId}-prompt`)));
        expect(outcome.status).toBe("processed");
        expect(created[0]?.messages).toEqual([
          "Work on Fix the widget:\nThe widget wobbles.",
        ]);
        // Sent under the delivery's own key, the one the session was created under.
        expect([...(created[0]?.sendRequestIds ?? [])]).toEqual([
          sessionRequestIdOf(`${runId}-prompt`),
        ]);
        expect(created[0]?.repo).toBe(repo);
        expect(created[0]?.baseRef).toBe("main");
        // The port is told where the delivery came from, so the session's spend is the source's.
        expect(created[0]?.source).toBe("generic");
      },
      { registerRepo: [repo] },
    );
  }, 60_000);

  it("attributes a trigger's session to `trigger:<source>`, never to a bare name", () => {
    expect(triggerActorOf("linear")).toBe("trigger:linear");
    expect(triggerActorOf("github")).toBe("trigger:github");
  });
});

/**
 * Stored trigger routes (LOB-266): rows on the repo registry the seam reads per delivery, with
 * `TRIGGER_RULES` as the fallback. Every label and team below is per-run, because the table is the
 * database's and a route another run left must not claim this run's events; each case removes the
 * routes it added.
 *
 * Mutations these cases catch: reading the table once at boot (the first case adds a route to a
 * running seam and the very next delivery uses it); consulting the rules before the table (the
 * precedence case); dropping the origin from the reason; reading the table when `storedRoutes` is off
 * (the docs and review seams); ordering by insertion alone (the specificity case adds the catch-all
 * first).
 */
describe("stored trigger routes", () => {
  const routeLabel = `route-${runId}`;
  const routeTeam = `T${runId.toUpperCase()}`;
  const routeRepo = "acme/routed" as RepoSlug;
  const envRepo = "acme/env-routed" as RepoSlug;
  const envRule: TriggerRule = {
    label: routeLabel,
    repo: envRepo,
    prompt: "env: {{key}}",
  };
  const origin = "env:TRIGGER_RULES";

  const asRoutes = (routes: TriggerRoutesShape) => ({
    add: (input: Parameters<TriggerRoutesShape["add"]>[0]) =>
      Effect.runPromise(routes.add(input)),
    remove: (id: Parameters<TriggerRoutesShape["remove"]>[0]) =>
      Effect.runPromise(routes.remove(id)),
    list: () => Effect.runPromise(routes.list),
  });

  const withStored = (
    body: (
      harness: Harness & { readonly stored: ReturnType<typeof asRoutes> },
    ) => Promise<void>,
    options: { readonly rules?: ReadonlyArray<TriggerRule> } = {},
  ) =>
    withRuntime(
      async (harness) => {
        const stored = asRoutes(harness.routes);
        const added: Array<Parameters<TriggerRoutesShape["remove"]>[0]> = [];
        const tracked = {
          ...stored,
          add: async (input: Parameters<TriggerRoutesShape["add"]>[0]) => {
            const route = await stored.add(input);
            added.push(route.id);
            return route;
          },
        };
        try {
          await body({ ...harness, stored: tracked });
        } finally {
          for (const id of added) {
            await stored.remove(id).catch(() => undefined);
          }
        }
      },
      {
        registerRepo: [routeRepo, envRepo],
        storedRoutes: true,
        rulesOrigin: origin,
        rules: options.rules ?? [],
      },
    );

  it("routes the next delivery through a route added after the seam started, and the reason names it", async () => {
    await withStored(async ({ run, trigger, created, stored }) => {
      const before = await run(
        trigger.deliver(
          deliver(`${runId}-stored-before`, {
            source: "linear",
            labels: [routeLabel],
          }),
        ),
      );
      expect(before.status).toBe("skipped");
      expect(created).toHaveLength(0);

      const route = await stored.add({
        label: routeLabel,
        repo: routeRepo,
        baseRef: "develop",
        prompt: "stored: {{key}}",
      });
      // No restart and no new seam: the same running instance, the next delivery.
      const after = await run(
        trigger.deliver(
          deliver(`${runId}-stored-after`, {
            source: "linear",
            labels: [routeLabel],
          }),
        ),
      );
      expect(after.status).toBe("processed");
      expect(after.reason).toBe(
        `rule "${routeLabel}" (route ${route.id}) mapped it to ${routeRepo}`,
      );
      expect(created).toHaveLength(1);
      expect(created[0]?.repo).toBe(routeRepo);
      expect(created[0]?.baseRef).toBe("develop");
      expect(created[0]?.messages).toEqual([`stored: ${runId}-issue`]);

      // The reason is stored with the delivery, not only in the first response: the row names the
      // route, and a replay of the processed delivery answers with it.
      const replayed = await run(
        trigger.deliver(
          deliver(`${runId}-stored-after`, {
            source: "linear",
            labels: [routeLabel],
          }),
        ),
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.status).toBe("processed");
      expect(replayed.reason).toBe(after.reason);
      expect(replayed.reason).toContain(`route ${route.id}`);
    });
  }, 60_000);

  it("takes a Linear label add and a Linear team's new issue as work once a route claims them, with no env rule", async () => {
    // The adapter normalizes against the seam's own rules, so what counts as work (an added label,
    // the issue's team) changes with the table too: a route stored after boot is not skipped by the
    // adapter's key before the seam ever sees it.
    await withStored(async ({ run, trigger, created, stored }) => {
      const labelAdded = {
        type: "Issue",
        action: "update",
        updatedFrom: { labelIds: [] },
        data: {
          id: `${runId}-linear-label`,
          title: "Add a label",
          labelIds: ["lbl-1"],
          labels: [{ id: "lbl-1", name: routeLabel }],
        },
      };
      const teamIssue = {
        type: "Issue",
        action: "create",
        data: {
          id: `${runId}-linear-team`,
          title: "A team's issue",
          labels: [],
          team: { id: "team-1", key: routeTeam },
        },
      };
      const viaSeam = async (payload: unknown) => {
        const rules = await run(trigger.rules);
        const delivery = linearDeliveryFor(rules)(payload);
        if (delivery === undefined) throw new Error("not a Linear issue");
        return { delivery, outcome: await run(trigger.deliver(delivery)) };
      };

      expect((await viaSeam(labelAdded)).outcome.status).toBe("skipped");
      expect((await viaSeam(teamIssue)).outcome.status).toBe("skipped");

      const labelRoute = await stored.add({
        label: routeLabel,
        repo: routeRepo,
        prompt: "label {{key}}",
      });
      const teamRoute = await stored.add({
        team: routeTeam,
        repo: envRepo,
        prompt: "team {{key}}",
      });

      const label = await viaSeam({
        ...labelAdded,
        data: { ...labelAdded.data, id: `${runId}-linear-label-2` },
      });
      expect(label.delivery.keyedByWork).toBe(true);
      expect(label.outcome.reason).toContain(`route ${labelRoute.id}`);
      const team = await viaSeam({
        ...teamIssue,
        data: { ...teamIssue.data, id: `${runId}-linear-team-2` },
      });
      expect(team.outcome.reason).toBe(
        `rule "team ${routeTeam}" (route ${teamRoute.id}) mapped it to ${envRepo}`,
      );
      expect(created.map((session) => session.repo)).toEqual([
        routeRepo,
        envRepo,
      ]);
    });
  }, 60_000);

  it("still routes through a TRIGGER_RULES rule when no stored route claims the event, and names the env rule", async () => {
    await withStored(
      async ({ run, trigger, created }) => {
        const outcome = await run(
          trigger.deliver(
            deliver(`${runId}-env-fallback`, { labels: [routeLabel] }),
          ),
        );
        expect(outcome.status).toBe("processed");
        // Index 1: the position in the variable, not the number of rules that came before it.
        expect(outcome.reason).toBe(
          `rule "${routeLabel}" (${origin}[1]) mapped it to ${envRepo}`,
        );
        expect(created[0]?.repo).toBe(envRepo);
      },
      {
        rules: [
          { label: `unrelated-${runId}`, repo: envRepo, prompt: "x" },
          envRule,
        ],
      },
    );
  }, 60_000);

  it("consults a stored route before the env rule for the same label, and falls back when it is removed", async () => {
    await withStored(
      async ({ run, trigger, created, stored }) => {
        const route = await stored.add({
          label: routeLabel,
          repo: routeRepo,
          prompt: "stored",
        });
        const won = await run(
          trigger.deliver(
            deliver(`${runId}-precedence-1`, { labels: [routeLabel] }),
          ),
        );
        expect(won.reason).toContain(`route ${route.id}`);
        expect(created[0]?.repo).toBe(routeRepo);

        // The same seam, a row fewer: the fallback answers, with no restart either way.
        await stored.remove(route.id);
        const fell = await run(
          trigger.deliver(
            deliver(`${runId}-precedence-2`, { labels: [routeLabel] }),
          ),
        );
        expect(fell.reason).toBe(
          `rule "${routeLabel}" (${origin}[0]) mapped it to ${envRepo}`,
        );
        expect(created[1]?.repo).toBe(envRepo);
      },
      { rules: [envRule] },
    );
  }, 60_000);

  it("leaves the stored routes alone when the seam is not told to read them", async () => {
    // The docs and review seams carry rules of their own; a route an operator stored for a label
    // must not hijack theirs.
    await withRuntime(
      async ({ run, trigger, routes, created }) => {
        const stored = asRoutes(routes);
        const route = await stored.add({
          label: routeLabel,
          repo: routeRepo,
          prompt: "stored",
        });
        try {
          const outcome = await run(
            trigger.deliver(
              deliver(`${runId}-not-read`, { labels: [routeLabel] }),
            ),
          );
          expect(outcome.reason).toBe(
            `rule "${routeLabel}" mapped it to ${envRepo}`,
          );
          expect(created[0]?.repo).toBe(envRepo);
        } finally {
          await stored.remove(route.id);
        }
      },
      { registerRepo: [routeRepo, envRepo], rules: [envRule] },
    );
  }, 60_000);

  it("claims a team's events by its key, and a team route is not claimed by another team", async () => {
    await withStored(async ({ run, trigger, created, stored }) => {
      const route = await stored.add({
        team: routeTeam,
        repo: routeRepo,
        prompt: "team",
      });
      const other = await run(
        trigger.deliver(
          deliver(`${runId}-team-other`, { labels: [], team: "ELSEWHERE" }),
        ),
      );
      expect(other.status).toBe("skipped");
      // The reason names the team, so an operator who stored a team route can see why this one was not
      // claimed.
      expect(other.reason).toBe(
        "the event carries no labels, so no rule maps it in team ELSEWHERE",
      );
      const none = await run(
        trigger.deliver(deliver(`${runId}-team-none`, { labels: [] })),
      );
      expect(none.status).toBe("skipped");

      const mine = await run(
        trigger.deliver(
          deliver(`${runId}-team-mine`, { labels: [], team: routeTeam }),
        ),
      );
      expect(mine.status).toBe("processed");
      expect(mine.reason).toBe(
        `rule "team ${routeTeam}" (route ${route.id}) mapped it to ${routeRepo}`,
      );
      expect(created).toHaveLength(1);
    });
  }, 60_000);

  it("orders routes by what they name, not by when they were added", async () => {
    await withStored(async ({ run, trigger, stored }) => {
      // The catch-all goes in first: insertion order alone would put it first.
      const teamOnly = await stored.add({
        team: routeTeam,
        repo: envRepo,
        prompt: "team",
      });
      const labelOnly = await stored.add({
        label: routeLabel,
        repo: envRepo,
        prompt: "label",
      });
      const both = await stored.add({
        label: routeLabel,
        team: routeTeam,
        repo: routeRepo,
        prompt: "both",
      });

      const mine = (await stored.list())
        .map((route) => route.id)
        .filter((id) => [teamOnly.id, labelOnly.id, both.id].includes(id));
      expect(mine).toEqual([both.id, labelOnly.id, teamOnly.id]);

      const seen = await run(trigger.rules);
      expect(seen.slice(0, 3).map((rule) => rule.prompt)).toEqual([
        "both",
        "label",
        "team",
      ]);

      const delivered = await run(
        trigger.deliver(
          deliver(`${runId}-specific`, {
            labels: [routeLabel],
            team: routeTeam,
          }),
        ),
      );
      expect(delivered.reason).toContain(`route ${both.id}`);
    });
  }, 60_000);

  it("admits the actions a stored route lists, and reads them back", async () => {
    await withStored(async ({ run, trigger, stored }) => {
      const route = await stored.add({
        label: routeLabel,
        repo: routeRepo,
        prompt: "push",
        startsWorkFor: ["push"],
      });
      expect(route.startsWorkFor).toEqual(["push"]);
      const pushed = await run(
        trigger.deliver(
          deliver(`${runId}-stored-push`, {
            labels: [routeLabel],
            action: "push",
          }),
        ),
      );
      expect(pushed.status).toBe("processed");
      const edited = await run(
        trigger.deliver(
          deliver(`${runId}-stored-edit`, {
            labels: [routeLabel],
            action: "update",
          }),
        ),
      );
      expect(edited.status).toBe("skipped");
      expect(edited.reason).toBe(`action "update" is not "create", "push"`);
    });
  }, 60_000);

  it("refuses a route to a repo nobody registered, and a removal of an id it has no row for", async () => {
    await withStored(async ({ stored }) => {
      // Its own slug: `unregisteredRepo` is registered by an earlier case on purpose.
      const never = `acme/never-registered-${runId}` as RepoSlug;
      const refused = await stored
        .add({ label: routeLabel, repo: never, prompt: "x" })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toMatchObject({
        _tag: "TriggerRouteError",
        code: "invalid_input",
      });
      expect(String((refused as { message: string }).message)).toContain(never);

      const missing = await stored
        .remove("trr_00000000000000000000000000" as never)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(missing).toMatchObject({ _tag: "TriggerRouteNotFound" });
    });
  }, 60_000);

  it("answers one of two concurrent removals of a route with the row and the other with not-found", async () => {
    await withStored(async ({ stored }) => {
      const route = await stored.add({
        label: `${routeLabel}-race`,
        repo: routeRepo,
        prompt: "x",
      });
      const settled = await Promise.allSettled([
        stored.remove(route.id),
        stored.remove(route.id),
      ]);
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = settled.find((r) => r.status === "rejected");
      expect(lost).toMatchObject({
        reason: { _tag: "TriggerRouteNotFound" },
      });
    });
  }, 60_000);
});

/**
 * Card mode (LOB-254): a mapped delivery puts one card on the repo's board and opens no session.
 *
 * The card port is the production one (`TriggerCardsFromTaskService` over the real `TaskService`),
 * because the dedupe the issue asks for — one card per issue, whatever delivery carries it — is a
 * fact of the `tasks` table and the service's lock on it, not of a fake. The sessions are the counting
 * fake above, so "no session" is a count of zero rather than an absence nobody looked for.
 */
describe("a card rule", () => {
  /** A repo per case, registered and (unless the case says not) given a board, as an operator would. */
  const cardRepo = (name: string) => `acme/cards-${name}-${runId}` as RepoSlug;

  const cardRules = (slug: RepoSlug): ReadonlyArray<TriggerRule> => [
    {
      label: "intake",
      repo: slug,
      baseRef: "main",
      prompt: "unused: a card's runs are told its body",
      mode: "card",
    },
  ];

  /** Linear's `Issue` `create` webhook body, as the adapter reads it. */
  const linearIssue = (id: string, over: Record<string, unknown> = {}) => ({
    action: "create",
    type: "Issue",
    webhookTimestamp: 1_761_559_200_000,
    url: `https://linear.app/acme/issue/${id}`,
    data: {
      id,
      identifier: id,
      title: "Make the widget stop wobbling",
      description: "## Goal\n\nThe widget **wobbles** — make it stop.\n",
      url: `https://linear.app/acme/issue/${id}/make-the-widget-stop-wobbling`,
      labels: [{ id: "label-intake", name: "intake" }],
      labelIds: ["label-intake"],
      ...over,
    },
  });

  type CardHarness = {
    readonly trigger: TriggerServiceShape;
    readonly routes: TriggerRoutesShape;
    readonly created: ReadonlyArray<{ readonly id: SessionId }>;
    readonly run: <A, E>(
      effect: Effect.Effect<A, E, TaskService | SqlClient>,
    ) => Promise<A>;
  };

  const withCards = async <A>(
    slug: RepoSlug,
    body: (harness: CardHarness) => Promise<A>,
    options: {
      readonly board?: boolean;
      readonly cards?: boolean;
      readonly storedRoutes?: boolean;
      readonly rules?: ReadonlyArray<TriggerRule>;
    } = {},
  ): Promise<A> => {
    const created: Array<{ readonly id: SessionId }> = [];
    const sessions: TriggerSessionsShape = {
      create: () =>
        Effect.sync(() => {
          const id =
            `ses_${String(created.length + 1).padStart(26, "0")}` as SessionId;
          created.push({ id });
          return { id };
        }),
      send: () => Effect.void,
    };
    const seam = TriggerServiceLive({
      rules: options.rules ?? cardRules(slug),
      ...(options.storedRoutes === true ? { storedRoutes: true } : {}),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TriggerSessions, TriggerSessions.of(sessions)),
          NoWriteBack,
          options.cards === false
            ? NoCards
            : TriggerCardsFromTaskService.pipe(Layer.provide(TaskServiceLive)),
        ),
      ),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(seam, TaskServiceLive, TriggerRoutesLive).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    try {
      const run: CardHarness["run"] = (effect) => runtime.runPromise(effect);
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`INSERT INTO repos (slug) VALUES (${slug}) ON CONFLICT (slug) DO NOTHING`;
          if (options.board !== false) {
            const tasks = yield* TaskService;
            yield* tasks.createBoard({
              repo: slug,
              definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
            });
          }
        }),
      );
      const trigger = await runtime.runPromise(TriggerService);
      const routes = await runtime.runPromise(TriggerRoutes);
      return await body({ trigger, routes, created, run });
    } finally {
      await runtime.dispose();
    }
  };

  /** Every card on the repo's board, as `TaskService` reads them. */
  const cardsOn = (slug: RepoSlug) =>
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const board = (yield* tasks.listBoards).find(
        (candidate) => candidate.repo === slug,
      );
      return board === undefined
        ? []
        : yield* tasks.list({ boardId: board.id });
    });

  it("files exactly one card in intake from a Linear issue create, with its description as the body, and opens no session", async () => {
    const slug = cardRepo("create");
    await withCards(slug, async ({ trigger, created, run }) => {
      const issueId = `iss-${runId}-create`;
      const delivery = linearDeliveryFor(cardRules(slug))(linearIssue(issueId));
      expect(delivery).toBeDefined();
      const outcome = await run(trigger.deliver(delivery!));

      expect(outcome.status).toBe("processed");
      expect(outcome.sessionId).toBeUndefined();
      expect(outcome.taskId).toBeDefined();
      expect(created).toHaveLength(0);

      const cards = await run(cardsOn(slug));
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card.id).toBe(outcome.taskId);
      // The default pipeline's initial column, read from the definition the board pins.
      expect(card.column).toBe("intake");
      expect(card.title).toBe("Make the widget stop wobbling");
      expect(card.body).toBe(
        "## Goal\n\nThe widget **wobbles** — make it stop.\n",
      );
      expect(card.externalRef).toBe(`linear:${issueId}`);
      expect(card.externalUrl).toBe(
        `https://linear.app/acme/issue/${issueId}/make-the-widget-stop-wobbling`,
      );
      expect(card.baseRef).toBe("main");
      expect(outcome.reason).toContain(`filed card ${card.id}`);
    });
  }, 60_000);

  it("files no second card for a replayed delivery, nor for a second, distinct delivery about the same issue", async () => {
    const slug = cardRepo("dedupe");
    await withCards(slug, async ({ trigger, created, run }) => {
      const issueId = `iss-${runId}-dedupe`;
      const delivery = linearDeliveryFor(cardRules(slug))(linearIssue(issueId));
      const first = await run(trigger.deliver(delivery!));
      const replayed = await run(trigger.deliver(delivery!));
      expect(replayed.replayed).toBe(true);
      expect(replayed.status).toBe("processed");

      // Distinct deliveries about the same issue id: a key the claim has never seen (a sender that
      // keys every delivery afresh, say), and a re-label of the issue under another key.
      const distinct = await run(
        trigger.deliver({
          requestId: `${runId}-dedupe-second`,
          event: { ...delivery!.event, title: "Retitled in Linear" },
        }),
      );
      expect(distinct.replayed).toBe(false);
      expect(distinct.status).toBe("processed");
      expect(distinct.taskId).toBe(first.taskId);
      expect(distinct.reason).toContain(
        `already on the board as card ${first.taskId}`,
      );

      const cards = await run(cardsOn(slug));
      expect(cards.map((card) => card.id)).toEqual([first.taskId]);
      expect(cards[0]?.title).toBe("Make the widget stop wobbling");
      expect(created).toHaveLength(0);
    });
  }, 60_000);

  it("files one card per Sentry issue, not per event: a card rule binds the issue's events as a session rule does (LOB-82)", async () => {
    const slug = cardRepo("sentry");
    const sentryRules: ReadonlyArray<TriggerRule> = [
      { label: SENTRY_LABEL, repo: slug, prompt: "", mode: "card" },
    ];
    const issue = `${runId}-sentry-issue`;
    const alertIn = (eventId: string) => ({
      action: "triggered",
      data: {
        event: {
          event_id: eventId,
          issue_id: issue,
          title: "ReferenceError: heck is not defined",
          level: "error",
          project: 1,
          environment: "production",
        },
        triggered_rule: "Very Important Alert!",
      },
    });
    await withCards(
      slug,
      async ({ trigger, created, run }) => {
        const outcomes = [];
        for (const eventId of [`${runId}-sentry-e1`, `${runId}-sentry-e2`]) {
          const delivery = sentryDelivery(
            alertIn(eventId),
            { resource: "event_alert", requestId: `req-${eventId}` },
            sentryRules,
          );
          if ("refused" in delivery) throw new Error(delivery.refused);
          outcomes.push(await run(trigger.deliver(delivery)));
        }
        const [first, second] = outcomes;
        expect(first?.status).toBe("processed");
        expect(second).toMatchObject({
          status: "processed",
          replayed: false,
          taskId: first?.taskId,
        });
        expect(second?.reason).toContain(
          `already on the board as card ${first?.taskId} (sentry:${issue})`,
        );
        const cards = await run(cardsOn(slug));
        expect(cards.map((card) => card.externalRef)).toEqual([
          `sentry:${issue}`,
        ]);
        expect(created).toHaveLength(0);
      },
      { rules: sentryRules },
    );
  }, 60_000);

  it("files one card when a second delivery about the issue arrives while the first is still filing it", async () => {
    // The interleaving a read-then-insert loses, made the only one this case runs: the first filing
    // holds its transaction open (its card inserted, uncommitted) until the second delivery is
    // queued behind it, then commits. `TaskService.file`'s lock is what queues the second; without
    // it the second never waits — the holder's bounded wait fails the case — and, reading no
    // committed card, it would file its own.
    const slug = cardRepo("race");
    await withCards(slug, async ({ trigger, run }) => {
      const issueId = `iss-${runId}-race`;
      const delivery = linearDeliveryFor(cardRules(slug))(linearIssue(issueId));
      const board = (await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          return (yield* tasks.listBoards).find((b) => b.repo === slug);
        }),
      ))!;
      const held = Deferred.makeUnsafe<void>();
      const holding = run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const tasks = yield* TaskService;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const first = yield* tasks.file({
                boardId: board.id,
                title: "filed first",
                externalRef: externalRefOf(delivery!.event),
                actor: "trigger:linear",
              });
              yield* Deferred.succeed(held, undefined);
              yield* sql<{ waiting: number }>`
                SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks
                WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
              `.pipe(
                Effect.map((rows) => rows[0]?.waiting ?? 0),
                Effect.repeat({
                  until: (waiting) => waiting >= 1,
                  schedule: Schedule.spaced(Duration.millis(10)),
                }),
                Effect.timeoutOrElse({
                  duration: Duration.seconds(10),
                  orElse: () =>
                    Effect.die(
                      new Error(
                        "the second delivery never waited on the first filing",
                      ),
                    ),
                }),
              );
              return first;
            }),
          );
        }),
      );
      await Effect.runPromise(Deferred.await(held));
      const second = await run(
        trigger.deliver({
          requestId: `${runId}-race-second`,
          event: delivery!.event,
        }),
      );
      const first = await holding;
      expect(first.created).toBe(true);
      expect(second.status).toBe("processed");
      expect(second.taskId).toBe(first.task.id);
      expect(await run(cardsOn(slug))).toHaveLength(1);
    });
  }, 60_000);

  it("records that the repo has no board, naming the command that makes one, and files the card once there is one", async () => {
    const slug = cardRepo("noboard");
    await withCards(
      slug,
      async ({ trigger, created, run }) => {
        const delivery = linearDeliveryFor(cardRules(slug))(
          linearIssue(`iss-${runId}-noboard`),
        );
        const skipped = await run(trigger.deliver(delivery!));
        expect(skipped.status).toBe("skipped");
        expect(skipped.reason).toContain(`repo ${slug} has no board`);
        expect(skipped.reason).toContain(`factory board create --repo ${slug}`);
        expect(await deliveryStatus(delivery!.requestId)).toBe("skipped");
        expect(created).toHaveLength(0);

        // The operator makes the board. The Linear key names the issue, so no fresh delivery id is
        // coming: the next delivery under it is claimed again instead of replaying the skip.
        await run(
          Effect.gen(function* () {
            const tasks = yield* TaskService;
            yield* tasks.createBoard({
              repo: slug,
              definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
            });
          }),
        );
        const filed = await run(trigger.deliver(delivery!));
        expect(filed.replayed).toBe(false);
        expect(filed.status).toBe("processed");
        expect(await run(cardsOn(slug))).toHaveLength(1);
      },
      { board: false },
    );
  }, 60_000);

  it("fails a card rule on a seam with no card port, and gives the claim back", async () => {
    const slug = cardRepo("noport");
    await withCards(
      slug,
      async ({ trigger, created, run }) => {
        const delivery = linearDeliveryFor(cardRules(slug))(
          linearIssue(`iss-${runId}-noport`),
        );
        const failed = await run(Effect.flip(trigger.deliver(delivery!)));
        expect(failed).toMatchObject({ code: "card-create" });
        expect(failed.message).toContain("no card port");
        expect(await deliveryStatus(delivery!.requestId)).toBeUndefined();
        // Never a session instead: a card rule that cannot file its card starts nothing.
        expect(created).toHaveLength(0);
      },
      { cards: false },
    );
  }, 60_000);

  it("cuts a description over the card body's cap to the cap, with a marker, and says so", () => {
    expect(cardBodyOf("short")).toEqual({ body: "short" });
    const exact = "x".repeat(MAX_TASK_BODY_CHARS);
    expect(cardBodyOf(exact)).toEqual({ body: exact });
    const long = `${"y".repeat(MAX_TASK_BODY_CHARS)}TAIL`;
    const cut = cardBodyOf(long);
    expect(cut.cut).toBe(long.length);
    expect(cut.body).toHaveLength(MAX_TASK_BODY_CHARS);
    expect(cut.body.startsWith("yyyy")).toBe(true);
    expect(cut.body).not.toContain("TAIL");
    expect(cut.body).toContain(
      `[cut at ${MAX_TASK_BODY_CHARS} characters by the factory; the source's description has ${long.length}]`,
    );
  });

  it("files the card for an issue whose description is over the card body's cap, cut to the cap", async () => {
    // Pasted logs: longer than a card body takes, shorter than the webhook body cap. A refusal here
    // would answer 500 and give the claim back, so the sender would retry a delivery that can never
    // file — the card is filed instead, with the head of the description and a marker.
    const slug = cardRepo("long");
    await withCards(slug, async ({ trigger, created, run }) => {
      const description = `## Logs\n\n${"log line\n".repeat(4_500)}`;
      expect(description.length).toBeGreaterThan(MAX_TASK_BODY_CHARS);
      const delivery = linearDeliveryFor(cardRules(slug))(
        linearIssue(`iss-${runId}-long`, { description }),
      );
      const outcome = await run(trigger.deliver(delivery!));
      expect(outcome.status).toBe("processed");
      expect(outcome.reason).toContain(
        `its body was cut to ${MAX_TASK_BODY_CHARS} of ${description.length} characters`,
      );
      const cards = await run(cardsOn(slug));
      expect(cards).toHaveLength(1);
      expect(cards[0]?.body).toHaveLength(MAX_TASK_BODY_CHARS);
      expect(cards[0]?.body?.startsWith("## Logs")).toBe(true);
      expect(cards[0]?.body).toContain("[cut at ");
      expect(await deliveryStatus(delivery!.requestId)).toBe("processed");
      expect(created).toHaveLength(0);
    });
  }, 60_000);

  it("records a card the board refuses for its input as a skip naming the field, not a failure to retry", async () => {
    const slug = cardRepo("refused");
    const rules = cardRules(slug).map((rule) => ({
      ...rule,
      baseRef: "main..evil",
    }));
    await withCards(
      slug,
      async ({ trigger, created, run }) => {
        const delivery = linearDeliveryFor(rules)(
          linearIssue(`iss-${runId}-refused`),
        );
        const outcome = await run(trigger.deliver(delivery!));
        expect(outcome.status).toBe("skipped");
        expect(outcome.reason).toContain(
          "the board refused the card's baseRef",
        );
        expect(outcome.reason).toContain('"main..evil"');
        // Recorded, so a retry is answered with the skip rather than refused again.
        expect(await deliveryStatus(delivery!.requestId)).toBe("skipped");
        const replayed = await run(trigger.deliver(delivery!));
        expect(replayed).toMatchObject({ status: "skipped", replayed: true });
        expect(await run(cardsOn(slug))).toHaveLength(0);
        expect(created).toHaveLength(0);
      },
      { rules },
    );
  }, 60_000);

  it("stores a route's card mode, reads it back, and files a card through it", async () => {
    const slug = cardRepo("route");
    await withCards(
      slug,
      async ({ trigger, routes, created, run }) => {
        const label = `intake-route-${runId}`;
        const route = await run(
          routes.add({ label, repo: slug, prompt: "", mode: "card" }),
        );
        expect(route.mode).toBe("card");
        expect(
          (await run(routes.list)).find((stored) => stored.id === route.id)
            ?.mode,
        ).toBe("card");
        try {
          const outcome = await run(
            trigger.deliver(
              deliver(`${runId}-route-card`, {
                labels: [label],
                key: `${runId}-route-card-issue`,
              }),
            ),
          );
          expect(outcome.status).toBe("processed");
          expect(outcome.reason).toContain(`route ${route.id}`);
          expect(created).toHaveLength(0);
          const cards = await run(cardsOn(slug));
          expect(cards.map((card) => card.externalRef)).toEqual([
            `generic:${runId}-route-card-issue`,
          ]);
        } finally {
          await run(routes.remove(route.id));
        }
      },
      { storedRoutes: true },
    );
  }, 60_000);
});
