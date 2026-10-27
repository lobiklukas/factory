/**
 * A mission's fan-out and join (LOB-193): independent workers as owned conversations, and the join
 * policy that decides what one worker's failure does to the others.
 *
 * The criteria are read off the log, not off timing. A worker's `check` holds its phase open until
 * the case writes the worker's release file, so a case decides when each worker may finish; what
 * the mission is waiting on, who owns each worker and which conversations each worker owns are read
 * from `Harness.taskGraph()`, the same graph a session's snapshot projects. A worker that has to be
 * aborted is never released, so the only way it can settle is the abort the case is about — and a
 * case that removed the abort wiring would wait on it until its bound, and fail.
 *
 * Deterministic and offline: the model is pi-ai's faux provider, which answers each worker's prompt
 * from its own transcript. Postgres is required, because the tasks and their outcomes are the log
 * the API serves.
 */
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  Harness,
  TaskGraph,
  TaskId,
} from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineExtension,
  Harness as HarnessRuntime,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MISSION_TASKS,
  MISSION_TASK_NAME,
  MISSION_VERSION,
  MissionTask,
  readMission,
  type MissionInput,
  type MissionResult,
} from "./mission";
import {
  MISSION_WORKER_TASK_NAME,
  MissionWorkerTask,
  type MissionWorker,
} from "./mission-worker";
import { createModelAccess } from "./models";
import { closeHarness } from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");

const logId = `harness-fanout-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

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

/** A log opened the way the control plane opens one: the mission's tasks, a faux model, a shell. */
const startWork = async (
  id: string,
  tasks: readonly (
    | typeof MissionTask
    | typeof MissionWorkerTask
  )[] = MISSION_TASKS,
): Promise<{ readonly harness: Harness; readonly root: Conversation }> => {
  const storage = await PostgresStorage.open(
    sql,
    { logId: id, mode: "owner" },
    context,
  );
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "factory.mission.fanout.test", tasks }),
  );
  const harness = await HarnessRuntime.open(
    storage,
    {
      models: model.models,
      registry,
      env: (target) =>
        new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
    },
    context,
  );
  const root = await harness.root(context, {
    agent: {
      model: { provider: model.provider, modelId: model.modelId },
      cwd: process.cwd(),
    },
  });
  return { harness, root };
};

const createMission = (
  root: Conversation,
  input: MissionInput,
): Promise<TaskId<MissionResult>> =>
  root.commit(
    (tx) =>
      tx.createTask(MissionTask, input, {
        ownership: { kind: "conversation" },
      }),
    context,
  );

/** Resolve once `holds` answers true, polling; reject after `ms` naming what never happened. */
const eventually = async (
  what: string,
  holds: () => boolean | Promise<boolean>,
  ms = 30_000,
): Promise<void> => {
  for (let waited = 0; !(await holds()); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
};

/** `promise`, or a rejection naming `what` once `ms` pass first. */
const within = <A>(what: string, promise: Promise<A>, ms: number): Promise<A> =>
  Effect.runPromise(
    Effect.promise(() => promise).pipe(
      Effect.timeoutOrElse({
        duration: `${ms} millis`,
        orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
      }),
    ),
  );

/** The task graph as it is now: a read, disposed at once. */
const graphOf = async (harness: Harness): Promise<TaskGraph> => {
  const state = await harness.taskGraph(context);
  try {
    return state.value;
  } finally {
    state.dispose();
  }
};

/** A checkout, and a `check` per worker name that holds until the case releases that worker. */
const checkout = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-harness-fanout-"));
  return {
    dir,
    holds: (name: string) =>
      `touch ${name}.started; while [ ! -f ${name}.release ]; do sleep 0.01; done`,
    started: (name: string) => existsSync(join(dir, `${name}.started`)),
    release: (name: string) => writeFileSync(join(dir, `${name}.release`), ""),
  };
};

const missionInput = (
  dir: string,
  workers: readonly MissionWorker[],
  joinPolicy?: MissionInput["join"],
): MissionInput => ({
  feature: "a fanned-out feature",
  workspace: {
    path: dir,
    commands: { verify: "true" },
    commandsSource: "repo",
  },
  workers,
  ...(joinPolicy === undefined ? {} : { join: joinPolicy }),
});

/** The worker ids a waiting mission names in the graph, once it is waiting on them. */
const waitingOn = async (
  harness: Harness,
  mission: TaskId,
): Promise<readonly TaskId[]> => {
  let on: readonly TaskId[] = [];
  await eventually("the mission to wait on its workers", async () => {
    const node = (await graphOf(harness)).tasks[String(mission)];
    if (node?.state.status !== "waiting") return false;
    on = node.state.on;
    return true;
  });
  return on;
};

describe("a mission's fan-out", () => {
  it("runs two workers as two owned conversations and joins only once both are done", async () => {
    const work = checkout();
    const { harness, root } = await startWork(`${logId}-join`);
    try {
      const mission = await createMission(
        root,
        missionInput(work.dir, [
          { id: "a", prompt: "do part a", check: work.holds("a") },
          { id: "b", prompt: "do part b", check: work.holds("b") },
        ]),
      );
      harness.resume();
      const [a, b] = await waitingOn(harness, mission);
      if (a === undefined || b === undefined)
        throw new Error("the mission waits on fewer than two workers");
      await eventually(
        "both workers to reach their check",
        () => work.started("a") && work.started("b"),
      );

      // Both workers are live at once, each a child of the mission with one conversation of its
      // own, and the mission is parked on both under the default policy.
      const both = await graphOf(harness);
      expect(both.tasks[String(mission)]).toMatchObject({
        kind: MISSION_TASK_NAME,
        state: {
          status: "waiting",
          phase: "implement",
          on: [a, b],
          policy: "failFast",
        },
      });
      const nodeA = both.tasks[String(a)];
      const nodeB = both.tasks[String(b)];
      expect(nodeA).toMatchObject({
        kind: MISSION_WORKER_TASK_NAME,
        owner: mission,
        state: { status: "running", phase: "check" },
      });
      expect(nodeB).toMatchObject({
        kind: MISSION_WORKER_TASK_NAME,
        owner: mission,
        state: { status: "running", phase: "check" },
      });
      expect(nodeA?.conversations).toHaveLength(1);
      expect(nodeB?.conversations).toHaveLength(1);
      const conversations = [
        ...(nodeA?.conversations ?? []),
        ...(nodeB?.conversations ?? []),
      ];
      expect(new Set(conversations).size).toBe(2);
      expect(conversations).not.toContain(root.id);

      // One worker done is not the join: the mission still waits on both, and the other is live.
      work.release("a");
      const settledA = await harness.waitForTask(a, context);
      expect(settledA.state.outcome).toMatchObject({ status: "completed" });
      const one = await graphOf(harness);
      expect(one.tasks[String(a)]).toBeUndefined();
      expect(one.tasks[String(b)]?.state.status).toBe("running");
      expect(one.tasks[String(mission)]?.state).toMatchObject({
        status: "waiting",
        phase: "implement",
        on: [a, b],
      });

      // Both done: the join moves the mission on to verify, and it completes naming its workers.
      work.release("b");
      const settled = await harness.waitForTask(mission, context);
      expect(settled.state.outcome).toEqual({
        status: "completed",
        result: {
          feature: "a fanned-out feature",
          verify: { command: "true", exitCode: 0 },
          workers: [
            {
              id: "a",
              taskId: String(a),
              conversationId: String(nodeA?.conversations[0]),
            },
            {
              id: "b",
              taskId: String(b),
              conversationId: String(nodeB?.conversations[0]),
            },
          ],
        },
      });
      // Each worker talked in its own conversation: the prompt is in that conversation's transcript
      // and not in the root's.
      for (const [node, prompt] of [
        [nodeA, "do part a"],
        [nodeB, "do part b"],
      ] as const) {
        const id = node?.conversations[0];
        if (id === undefined) throw new Error("a worker owns no conversation");
        const conversation = await harness.conversation(id, context);
        const view = await conversation?.viewState(context);
        try {
          expect(JSON.stringify(view?.value)).toContain(prompt);
        } finally {
          view?.dispose();
        }
      }
      expect(
        await Effect.runPromise(readMission(harness, root.id, mission)),
      ).toEqual({
        phase: "verify",
        definitionVersion: MISSION_VERSION,
        entered: ["plan", "implement", "verify"],
      });
    } finally {
      work.release("a");
      work.release("b");
      await Effect.runPromise(closeHarness(harness));
    }
  }, 120_000);

  it("aborts the other worker when one fails under failFast, and the aborted worker says why", async () => {
    const work = checkout();
    const { harness, root } = await startWork(`${logId}-failfast`);
    try {
      // `b` is never released: the only way it settles is the abort this case is about. `a` fails
      // only once `b` is running its check, so the abort has a live check process to stop, and `b`
      // beats while that process lives, so the case can tell it was stopped rather than left.
      const mission = await createMission(
        root,
        missionInput(work.dir, [
          {
            id: "a",
            prompt: "do part a",
            check: "while [ ! -f b.started ]; do sleep 0.01; done; exit 1",
          },
          {
            id: "b",
            prompt: "do part b",
            // The beat is written before the start mark, so once `a` sees `b.started` (and the
            // abort can follow) the beat file already exists.
            check:
              "touch b.alive; touch b.started; while [ ! -f b.release ]; do touch b.alive; sleep 0.01; done",
          },
        ]),
      );
      harness.resume();
      const [a, b] = await waitingOn(harness, mission);
      if (a === undefined || b === undefined)
        throw new Error("the mission waits on fewer than two workers");

      // Bounded well below the case's timeout, so a mission whose join does not abort `b` fails
      // here, naming the wait, rather than as a test timeout.
      const settled = await within(
        "the failFast join to abort the held worker",
        harness.waitForTask(mission, context),
        20_000,
      );
      expect(settled.state.outcome).toMatchObject({
        status: "failed",
        error: {
          message: expect.stringContaining('worker "a" failed'),
          detail: {
            phase: "implement",
            reason: "worker-failed",
            join: "failFast",
            workers: [
              {
                id: "a",
                taskId: String(a),
                status: "failed",
                message: expect.stringContaining("exited 1"),
              },
              {
                id: "b",
                taskId: String(b),
                status: "aborted",
                message: expect.stringContaining(
                  'the worker "a" settled failed',
                ),
              },
            ],
          },
        },
      });
      // The abort is recorded on the aborted worker itself, not only on the mission that read it.
      // `a` failed only once `b` had started its check, so `b` was aborted there.
      const aborted = await harness.getTask(b, context);
      expect(aborted?.state.outcome).toEqual({
        status: "aborted",
        reason:
          'the worker "b" was aborted in check: the worker "a" settled failed and the mission joins its workers failFast',
      });
      // And its check process is gone, not left running: the beat it wrote while alive has stopped.
      const beat = () => statSync(join(work.dir, "b.alive")).mtimeMs;
      const last = beat();
      await Effect.runPromise(Effect.sleep("300 millis"));
      expect(beat()).toBe(last);
      // The mission failed in implement, and never verified.
      expect(
        await Effect.runPromise(readMission(harness, root.id, mission)),
      ).toEqual({
        phase: "implement",
        definitionVersion: MISSION_VERSION,
        entered: ["plan", "implement"],
      });
    } finally {
      work.release("b");
      await Effect.runPromise(closeHarness(harness));
    }
  }, 120_000);

  it("lets the other worker finish when the same failure happens under allSettled", async () => {
    const work = checkout();
    const { harness, root } = await startWork(`${logId}-allsettled`);
    try {
      const mission = await createMission(
        root,
        missionInput(
          work.dir,
          [
            { id: "a", prompt: "do part a", check: "exit 1" },
            { id: "b", prompt: "do part b", check: work.holds("b") },
          ],
          "allSettled",
        ),
      );
      harness.resume();
      const [a, b] = await waitingOn(harness, mission);
      if (a === undefined || b === undefined)
        throw new Error("the mission waits on fewer than two workers");

      const failedA = await harness.waitForTask(a, context);
      expect(failedA.state.outcome).toMatchObject({ status: "failed" });
      await eventually("the other worker to reach its check", () =>
        work.started("b"),
      );
      // `a` failed and `b` is still live and unmarked, with the mission still waiting on it.
      const graph = await graphOf(harness);
      expect(graph.tasks[String(b)]).toMatchObject({
        abortRequested: false,
        state: { status: "running", phase: "check" },
      });
      expect(graph.tasks[String(mission)]?.state).toMatchObject({
        status: "waiting",
        policy: "allSettled",
        on: [a, b],
      });

      work.release("b");
      const settled = await harness.waitForTask(mission, context);
      // `b` finished its work; the mission still failed, because `a` did.
      expect(settled.state.outcome).toMatchObject({
        status: "failed",
        error: {
          detail: {
            phase: "implement",
            reason: "worker-failed",
            join: "allSettled",
            workers: [
              { id: "a", status: "failed" },
              { id: "b", status: "completed" },
            ],
          },
        },
      });
      const finished = await harness.getTask(b, context);
      expect(finished?.state.outcome).toMatchObject({
        status: "completed",
        result: {
          worker: "b",
          check: { command: work.holds("b"), exitCode: 0 },
        },
      });
    } finally {
      work.release("b");
      await Effect.runPromise(closeHarness(harness));
    }
  }, 120_000);

  it("aborts its workers first when the mission itself is aborted while it waits", async () => {
    const work = checkout();
    const { harness, root } = await startWork(`${logId}-abort`);
    try {
      const mission = await createMission(
        root,
        missionInput(work.dir, [
          { id: "a", prompt: "do part a", check: work.holds("a") },
          { id: "b", prompt: "do part b", check: work.holds("b") },
        ]),
      );
      harness.resume();
      const [a, b] = await waitingOn(harness, mission);
      if (a === undefined || b === undefined)
        throw new Error("the mission waits on fewer than two workers");

      expect(await harness.abortTask(mission, context)).toBe("marked");
      const settled = await within(
        "the mission's abort to reach its workers",
        harness.waitForTask(mission, context),
        20_000,
      );
      expect(settled.state.outcome).toEqual({ status: "aborted" });
      // No worker failed, so each records its mission's abort rather than blaming a sibling.
      for (const [worker, name] of [
        [a, "a"],
        [b, "b"],
      ] as const) {
        const record = await harness.getTask(worker, context);
        expect(record?.state.outcome).toEqual({
          status: "aborted",
          reason: expect.stringMatching(
            new RegExp(
              `^the worker "${name}" was aborted in (open|converse|check): its mission was aborted$`,
            ),
          ),
        });
      }
    } finally {
      work.release("a");
      work.release("b");
      await Effect.runPromise(closeHarness(harness));
    }
  }, 120_000);

  it("refuses to fan out two workers that share an id", async () => {
    const work = checkout();
    const { harness, root } = await startWork(`${logId}-duplicate`);
    try {
      const mission = await createMission(
        root,
        missionInput(work.dir, [
          { id: "a", prompt: "do part a" },
          { id: "a", prompt: "do part a again" },
        ]),
      );
      harness.resume();
      const settled = await harness.waitForTask(mission, context);
      expect(settled.state.outcome).toMatchObject({
        status: "failed",
        error: {
          detail: {
            phase: "implement",
            reason: "duplicate-worker",
            worker: "a",
          },
        },
      });
      // Nothing fanned out: the log holds no worker task, live or settled.
      const workers = await root.commit(
        (tx) => tx.scanTasks({ kind: MISSION_WORKER_TASK_NAME }, 10),
        context,
      );
      expect(workers.items).toEqual([]);
    } finally {
      await Effect.runPromise(closeHarness(harness));
    }
  }, 120_000);

  it("still commits a worker's abort when reading why it was aborted fails", async () => {
    type Abort = typeof MissionWorkerTask.definition.abort;
    const committed: unknown[] = [];
    const task = {
      id: 7,
      owner: 3,
      input: { worker: { id: "b", prompt: "p" }, workspace: { path: "/w" } },
      state: { status: "running", checkpoint: { phase: "check" } },
    } as unknown as Parameters<Abort>[0];
    const runtime = {
      getTask: () => Promise.reject(new Error("storage is down")),
      commit: (next: () => unknown) => {
        committed.push(next());
        return Promise.resolve();
      },
    } as unknown as Parameters<Abort>[1];
    await MissionWorkerTask.definition.abort(task, runtime, context);
    // The reason falls back to the phase it can show; the abort itself is not lost.
    expect(committed).toEqual([
      {
        status: "terminal",
        outcome: {
          status: "aborted",
          reason: 'the worker "b" was aborted in check',
        },
      },
    ]);
  });

  it("reads a waiting checkpoint back through migrate", () => {
    const migrate = (input: JsonValue, checkpoint: JsonValue, from: number) =>
      MissionTask.definition.migrate?.(input, checkpoint, from);
    const input = {
      feature: "a fanned-out feature",
      workspace: {
        path: "/w",
        commands: { verify: "true" },
        commandsSource: "repo",
      },
      workers: [{ id: "a", prompt: "p" }],
      join: "allSettled",
    };
    expect(migrate(input, { phase: "implement", workers: [3, 4] }, 1)).toEqual({
      input,
      checkpoint: { phase: "implement", workers: [3, 4] },
    });
    // A worker id that is not a task id is not a checkpoint this definition can join on.
    expect(() =>
      migrate(input, { phase: "implement", workers: ["3"] }, 1),
    ).toThrow();
    expect(() =>
      migrate({ ...input, join: "sometimes" }, { phase: "plan" }, 1),
    ).toThrow();
  });
});
