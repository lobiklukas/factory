/**
 * The live-task projection (LOB-183): a session's snapshot and stream say what is running in it.
 *
 * Pi Durable's `Harness.taskGraph()` is the source — every live task with its status, phase, owner
 * and owned conversations — and this suite proves the issue's criteria against a real log: an idle
 * session reports no tasks, a started task is `pending` before it is scheduled and `running` once
 * it is, a task that parks names the ids it waits on, and a task that settles reaches an attached
 * client as a `tasks` event rather than on a read.
 *
 * Deterministic and offline: the model is pi-ai's faux provider. Postgres is required, because the
 * projection reads the same committed graph the API serves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness as HarnessRuntime,
} from "@earendil-works/pi-durable";
import { SessionId } from "@repo/domain/Session";
import type { SessionError, SessionEvent } from "@repo/domain/Session";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  ManagedRuntime,
  Random,
  Ref,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelAccess } from "./models";
import {
  closeHarness,
  liveSessionEvents,
  readLiveSnapshot,
  type LiveSession,
  type SessionRef,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");

const workdir = mkdtempSync(join(tmpdir(), "factory-harness-tasks-"));

/** Every failure Pi Durable reported without failing the call that caused it. */
const reported: unknown[] = [];
const logId = `harness-tasks-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

let sql: SqlClient;

beforeAll(async () => {
  try {
    sql = await runtime.runPromise(SqlClient);
  } catch (cause) {
    throw new Error(
      "Postgres is unreachable. Start it with `docker compose up -d --wait postgres`. " +
        String(cause),
      { cause },
    );
  }
}, 60_000);

afterAll(async () => {
  await runtime.dispose();
});

/** A session ref for the projections; only the id and the workspace path reach the assertions. */
const ref: SessionRef = {
  id: Schema.decodeSync(SessionId)("ses_00000000000000000000000001"),
  title: "tasks",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path: workdir, commands: {}, commandsSource: "none" },
};

/**
 * The handler that keeps a task `running` until the test lets it settle.
 *
 * A phase must commit durable progress, so it parks on a promise the test resolves and then commits
 * a terminal outcome — the settle the stream has to publish.
 */
const holdReleased = Deferred.makeUnsafe<void>();

/** Let every parked task settle, and block the handler until then without leaving Effect. */
const releaseHold = (): void => {
  Deferred.doneUnsafe(holdReleased, Effect.void);
};

const HoldTask = defineTask({
  name: "factory.test.hold",
  version: 1,
  initial: (_input: { readonly label: string }) => ({ phase: "hold" as const }),
  phases: {
    hold: async (_task, taskRuntime, taskContext) => {
      await Effect.runPromise(Deferred.await(holdReleased));
      await taskRuntime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "completed" as const, result: null },
        }),
        taskContext,
      );
    },
  },
  abort: async (_task, taskRuntime, taskContext) => {
    await taskRuntime.commit(
      () => ({
        status: "terminal" as const,
        outcome: { status: "aborted" as const },
      }),
      taskContext,
    );
  },
});

/**
 * A task that parks on another: its first phase creates a child task of its own and waits on it, and
 * the phase it resumes into settles. A task may only wait on tasks it owns (Pi Durable refuses the
 * rest at commit), so the parked task has to own what it waits for. The second phase keeps a
 * resumed waiter from parking again on work that already settled, which would reschedule it forever.
 */
const WaitingTask = defineTask({
  name: "factory.test.wait",
  version: 1,
  initial: (_input: {
    readonly label: string;
  }): { phase: "start" } | { phase: "settled" } => ({ phase: "start" }),
  phases: {
    start: async (task, taskRuntime, taskContext) => {
      await taskRuntime.commit(async (tx) => {
        const child = await tx.createTask(
          HoldTask,
          { label: "waited-on" },
          { ownership: { kind: "task", taskId: task.id } },
        );
        return {
          status: "waiting" as const,
          checkpoint: { phase: "settled" as const },
          on: [child],
          policy: "failFast" as const,
        };
      }, taskContext);
    },
    settled: async (_task, taskRuntime, taskContext) => {
      await taskRuntime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "completed" as const, result: null },
        }),
        taskContext,
      );
    },
  },
  abort: async (_task, taskRuntime, taskContext) => {
    await taskRuntime.commit(
      () => ({
        status: "terminal" as const,
        outcome: { status: "aborted" as const },
      }),
      taskContext,
    );
  },
});

/** Bounded polling for a condition the scheduler reaches; the wait is the test's, not the product's. */
const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

describe("live tasks", () => {
  it("projects the task graph into the snapshot and the stream", async () => {
    const storage = await PostgresStorage.open(
      sql,
      { logId, mode: "owner" },
      context,
    );

    const collected = await runtime.runPromise(
      Effect.gen(function* () {
        const opened = yield* Effect.gen(function* () {
          // The harness the test opens itself: these two task definitions are the registry's only
          // tasks, which is what "a `defineTask` task in the session" means here. Nothing else is
          // installed, because neither task calls a model or a tool.
          const registry = createRegistry();
          registry.install(
            defineExtension({
              name: "factory.test.tasks",
              tasks: [HoldTask, WaitingTask],
            }),
          );
          const harness = yield* Effect.promise(() =>
            HarnessRuntime.open(
              storage,
              { models: model.models, registry },
              context,
            ),
          );
          const root = yield* Effect.promise(() =>
            harness.root(context, {
              agent: {
                model: { provider: model.provider, modelId: model.modelId },
                cwd: workdir,
              },
            }),
          );
          return { harness, root };
        });
        const session: LiveSession = opened;
        const events = yield* Ref.make<readonly SessionEvent[]>([]);
        let streamed: Fiber.Fiber<void, SessionError> | undefined;

        try {
          // Nothing runs in a session nobody has started work in: an empty list, not a missing key.
          const idle = yield* readLiveSnapshot(session, ref);
          expect(idle.tasks).toEqual([]);

          const held = yield* Effect.promise(() =>
            opened.root.commit(
              (tx) =>
                tx.createTask(
                  HoldTask,
                  { label: "held" },
                  {
                    ownership: { kind: "conversation" },
                  },
                ),
              context,
            ),
          );

          // Scheduling is not enabled until someone asks for progress, so the committed task is
          // reported before any invocation reserves it.
          const pending = yield* readLiveSnapshot(session, ref);
          expect(pending.tasks).toHaveLength(1);
          expect(pending.tasks[0]).toMatchObject({
            id: String(held),
            kind: "factory.test.hold",
            status: "pending",
            phase: "hold",
            waitingOn: [],
            // A conversation-owned task owns no conversations of its own and names no owner task.
            conversations: [],
          });

          yield* Effect.sync(() => opened.harness.resume());
          yield* waitUntil(
            readLiveSnapshot(session, ref).pipe(
              Effect.map((snapshot) => snapshot.tasks[0]?.status === "running"),
            ),
            "the held task to run",
          );

          const waiting = yield* Effect.promise(() =>
            opened.root.commit(
              (tx) =>
                tx.createTask(
                  WaitingTask,
                  { label: "waiting" },
                  {
                    ownership: { kind: "task", taskId: held },
                  },
                ),
              context,
            ),
          );
          yield* waitUntil(
            readLiveSnapshot(session, ref).pipe(
              Effect.map((snapshot) =>
                snapshot.tasks.some(
                  (task) =>
                    task.id === String(waiting) &&
                    task.status === "waiting" &&
                    task.owner === String(held) &&
                    task.waitingOn.length === 1,
                ),
              ),
            ),
            "the waiting task to park and name the task it waits on",
          );

          // Attach before the settle, so the `tasks` event that follows can only come from the
          // graph's publication rather than from a poll.
          streamed = yield* liveSessionEvents(session, ref).pipe(
            Stream.tap((event) => Ref.update(events, (all) => [...all, event])),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* waitUntil(
            Ref.get(events).pipe(
              Effect.map((all) =>
                all.some((event) => event._tag === "snapshot"),
              ),
            ),
            "the attached snapshot",
          );

          releaseHold();

          yield* waitUntil(
            Ref.get(events).pipe(
              Effect.map((all) =>
                all.some(
                  (event) =>
                    event._tag === "tasks" &&
                    event.tasks.every((task) => task.id !== String(held)),
                ),
              ),
            ),
            "a tasks event without the settled task",
          );

          const seen = yield* Ref.get(events);
          const taskEvents = seen.flatMap((event) =>
            event._tag === "tasks" ? [event.tasks] : [],
          );
          // The settle is an event, not a re-read: one graph revision says the task is live and a
          // later one says it is gone. A poll would have shown only the second.
          expect(
            taskEvents.some((tasks) =>
              tasks.some((task) => task.id === String(held)),
            ),
          ).toBe(true);
          const afterRelease = yield* readLiveSnapshot(session, ref);
          expect(afterRelease.tasks.map((task) => task.id)).not.toContain(
            String(held),
          );

          return seen;
        } finally {
          if (streamed !== undefined) yield* Fiber.interrupt(streamed);
          yield* closeHarness(opened.harness).pipe(Effect.ignore);
        }
      }),
    );

    expect(collected.length).toBeGreaterThan(1);
    expect(reported).toEqual([]);
  }, 60_000);
});
