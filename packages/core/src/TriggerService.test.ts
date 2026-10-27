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
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
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
import {
  sessionRequestIdOf,
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
  readonly created: Array<Created>;
  /** The session id of every write-back the seam attempted, failed ones included. */
  readonly writeBacks: Array<SessionId>;
};

const withRuntime = async <A>(
  body: (harness: Harness) => Promise<A>,
  options: {
    readonly registerRepo?: ReadonlyArray<RepoSlug>;
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
    TriggerServiceLive({
      rules,
      ...(options.reclaimAfter === undefined
        ? {}
        : { reclaimAfter: options.reclaimAfter }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TriggerSessions, TriggerSessions.of(sessions)),
          Layer.succeed(TriggerWriteBack, TriggerWriteBack.of(writeBack)),
        ),
      ),
      Layer.provide(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );

  try {
    const trigger = await runtime.runPromise(TriggerService);
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
    return await body({ run, trigger, created, writeBacks });
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
        expect(outcome.reason).toContain('action "update"');
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
        expect(both.reason).toContain('action "push"');
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
