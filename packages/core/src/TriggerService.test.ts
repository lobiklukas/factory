/**
 * The trigger seam against the real delivery store (LOB-188).
 *
 * What only a database can prove: two deliveries with one request id create one session, and the
 * loser says `replayed`. A read-then-insert would pass a single-threaded case and fail the
 * concurrent one, so the case below fires both at once — the claim is `INSERT … ON CONFLICT DO
 * NOTHING RETURNING`, and a mutation that removes it (or that replaces it with a `SELECT` first)
 * turns "exactly one session" red.
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
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  type TriggerServiceShape,
  type TriggerSessionsShape,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");

/** One fake session, as the seam sees it: an id and the message that was sent to it. */
type Created = {
  readonly id: SessionId;
  readonly title: string;
  readonly repo: RepoSlug;
  readonly baseRef: string | undefined;
  readonly prompt: string | undefined;
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
};

const withRuntime = async <A>(
  body: (harness: Harness) => Promise<A>,
  options: {
    readonly registerRepo?: ReadonlyArray<RepoSlug>;
    /** Fail the first `create` this many times, as a session layer under stress would. */
    readonly failCreateTimes?: number;
    /** Die (a defect, not a typed failure) on the first `create` that many times. */
    readonly dieCreateTimes?: number;
  } = {},
): Promise<A> => {
  const created: Array<Created> = [];
  let failuresLeft = options.failCreateTimes ?? 0;
  let deathsLeft = options.dieCreateTimes ?? 0;
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
            // The count is what the cases assert; the id only has to be a well-formed session id.
            const id =
              `ses_${String(created.length + 1).padStart(26, "0")}` as SessionId;
            created.push({
              id,
              title: input.title,
              repo: input.repo,
              baseRef: input.baseRef,
              prompt: undefined,
            });
            return { id };
          });
        },
      ),
    send: (input) =>
      Effect.sync(() => {
        const index = created.findIndex(
          (entry) => entry.id === input.sessionId,
        );
        const entry = created[index];
        if (entry !== undefined) {
          created[index] = { ...entry, prompt: input.content };
        }
      }),
  };

  const runtime = ManagedRuntime.make(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TriggerSessions, TriggerSessions.of(sessions)),
          NoWriteBack,
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
    return await body({ run, trigger, created });
  } finally {
    await runtime.dispose();
  }
};

const deliver = (requestId: string, over: Partial<TriggerEvent> = {}) =>
  ({
    requestId,
    event: event(over),
  }) satisfies TriggerDelivery;

describe("the trigger seam", () => {
  it("creates exactly one session when two deliveries race, and the loser says replayed", async () => {
    await withRuntime(
      async ({ run, trigger, created }) => {
        const requestId = `${runId}-race`;
        const outcomes = await run(
          Effect.all(
            [
              trigger.deliver(deliver(requestId)),
              trigger.deliver(deliver(requestId)),
            ],
            { concurrency: "unbounded" },
          ),
        );

        expect(created).toHaveLength(1);
        const first = outcomes.filter((outcome) => !outcome.replayed);
        const replays = outcomes.filter((outcome) => outcome.replayed);
        expect(first).toHaveLength(1);
        expect(replays).toHaveLength(1);
        expect(first[0]?.sessionId).toBe(created[0]?.id);
        // A replay answers what the first delivery recorded, including its outcome.
        expect(replays[0]?.status).toBe("processed");
      },
      { registerRepo: [repo] },
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

  it("sends the rendered prompt as the session's first message", async () => {
    await withRuntime(
      async ({ run, trigger, created }) => {
        const outcome = await run(trigger.deliver(deliver(`${runId}-prompt`)));
        expect(outcome.status).toBe("processed");
        expect(created[0]?.prompt).toBe(
          "Work on Fix the widget:\nThe widget wobbles.",
        );
        expect(created[0]?.repo).toBe(repo);
        expect(created[0]?.baseRef).toBe("main");
      },
      { registerRepo: [repo] },
    );
  }, 60_000);
});
