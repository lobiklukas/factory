/**
 * A mission: three durable phases in one Pi Durable task (LOB-229).
 *
 * The suite proves the issue's criteria against a real log rather than against a return value: the
 * phase order is read back from the `entered` list the mission's document commits, and a second
 * harness opened in `reader` mode — one that never saw the mission run — is what reads the last phase
 * back after a reopen.
 *
 * Deterministic and offline: the model is pi-ai's faux provider and no phase calls it. Postgres is
 * required, because the mission's checkpoints and its document are the log the API serves.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  Harness,
  Storage,
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
  MISSION_VERSION,
  MissionTask,
  readMission,
  type MissionInput,
  type MissionResult,
} from "./mission";
import { createModelAccess } from "./models";
import { closeHarness } from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");

const logId = `harness-mission-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

/** A checkout per case, so two cases' `verify` commands cannot overwrite each other's effect. */
const checkout = (): string =>
  mkdtempSync(join(tmpdir(), "factory-harness-mission-"));

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

/** One log, opened the way the control plane opens it: a registry, a faux model and a real shell. */
const openHarness = async (
  id: string,
  mode: "owner" | "reader",
): Promise<{ readonly harness: Harness; readonly storage: Storage }> => {
  const storage = await PostgresStorage.open(sql, { logId: id, mode }, context);
  const registry = createRegistry();
  // The mission is the registry's only task: a phase's work is the mission's own, not a tool's.
  registry.install(
    defineExtension({ name: "factory.mission.test", tasks: [MissionTask] }),
  );
  const harness = await HarnessRuntime.open(
    storage,
    {
      models: model.models,
      registry,
      // The verify phase runs the repo's command in the session's checkout, so the harness needs a
      // real execution environment; nothing else in the mission touches one.
      env: (target) =>
        new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
    },
    context,
  );
  return { harness, storage };
};

/** A log with a root conversation, which is where a mission is created. */
const startWork = async (
  id: string,
): Promise<{
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: Storage;
}> => {
  const { harness, storage } = await openHarness(id, "owner");
  const root = await harness.root(context, {
    agent: {
      model: { provider: model.provider, modelId: model.modelId },
      cwd: process.cwd(),
    },
  });
  return { harness, root, storage };
};

/** Create one mission in the root conversation — no RPC yet (LOB-230 brings it). */
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

describe("a mission", () => {
  it("runs plan, implement and verify in order, and the log is what says so", async () => {
    const dir = checkout();
    const id = `${logId}-order`;
    const { harness, root } = await startWork(id);
    const verify = "printf verified > mission-verify.out";
    const input: MissionInput = {
      feature: "a mission",
      workspace: { path: dir, commands: { verify }, commandsSource: "repo" },
    };

    const mission = await createMission(root, input);
    harness.resume();
    const settled = await harness.waitForTask(mission, context);
    // Completed, and the result says what verify ran: the mission is not done by reaching a phase
    // but by the repo's own command passing in the workspace.
    expect(settled.state.outcome).toEqual({
      status: "completed",
      result: {
        feature: "a mission",
        verify: { command: verify, exitCode: 0 },
      },
    });

    // The phase ran the repo's command in the checkout rather than reporting that it would have.
    expect(readFileSync(join(dir, "mission-verify.out"), "utf8")).toBe(
      "verified",
    );

    // The order is the log's, not the run's return value: the mission's document names every phase
    // it entered, in the order it entered them.
    const live = await Effect.runPromise(
      readMission(harness, root.id, mission),
    );
    expect(live).toEqual({
      phase: "verify",
      definitionVersion: MISSION_VERSION,
      entered: ["plan", "implement", "verify"],
    });
    await Effect.runPromise(closeHarness(harness));

    // A reopen reads it back from the log again: a fresh harness over a read-only handle of the
    // same log, which never saw the mission run.
    const reopened = await openHarness(id, "reader");
    const afterReopen = await Effect.runPromise(
      readMission(reopened.harness, root.id, mission),
    );
    expect(afterReopen).toEqual({
      phase: "verify",
      definitionVersion: MISSION_VERSION,
      entered: ["plan", "implement", "verify"],
    });
    await Effect.runPromise(closeHarness(reopened.harness));
  }, 120_000);

  it("settles failed, naming the phase, when the repo declares no verify command", async () => {
    const id = `${logId}-none`;
    const { harness, root } = await startWork(id);
    const input: MissionInput = {
      feature: "an unverified feature",
      workspace: {
        path: checkout(),
        commands: {},
        commandsSource: "none",
      },
    };

    const mission = await createMission(root, input);
    harness.resume();
    const settled = await harness.waitForTask(mission, context);

    // `failed`, not `faulted`: a mission that cannot verify has not verified, and it says so as a
    // committed outcome naming the phase rather than by throwing out of the phase.
    expect(settled.state.outcome).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("declares no verify command"),
        detail: {
          phase: "verify",
          reason: "no-verify-command",
          commandsSource: "none",
        },
      },
    });
    // The mission still reached verify, and the log still says which phase it died in.
    expect(
      await Effect.runPromise(readMission(harness, root.id, mission)),
    ).toEqual({
      phase: "verify",
      definitionVersion: MISSION_VERSION,
      entered: ["plan", "implement", "verify"],
    });
    await Effect.runPromise(closeHarness(harness));
  }, 120_000);

  it("settles failed, naming the phase, when the verify command exits non-zero", async () => {
    const id = `${logId}-exits`;
    const { harness, root } = await startWork(id);
    const input: MissionInput = {
      feature: "a broken feature",
      workspace: {
        path: checkout(),
        commands: { verify: "exit 3" },
        commandsSource: "repo",
      },
    };

    const mission = await createMission(root, input);
    harness.resume();
    const settled = await harness.waitForTask(mission, context);

    expect(settled.state.outcome).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("failed in verify"),
        detail: {
          phase: "verify",
          reason: "verify-failed",
          command: "exit 3",
          exitCode: 3,
        },
      },
    });
    await Effect.runPromise(closeHarness(harness));
  }, 120_000);

  it("settles aborted when it is aborted before it reaches a phase", async () => {
    const id = `${logId}-aborted`;
    const { harness, root } = await startWork(id);
    const input: MissionInput = {
      feature: "an abandoned feature",
      workspace: {
        path: checkout(),
        commands: { verify: "true" },
        commandsSource: "repo",
      },
    };

    const mission = await createMission(root, input);
    // Marked before scheduling resumes, so the abort invocation, not a phase, is the first one.
    expect(await harness.abortTask(mission, context)).toBe("marked");
    harness.resume();
    const settled = await harness.waitForTask(mission, context);

    expect(settled.state.outcome).toEqual({ status: "aborted" });
    // No phase was entered, so the log names none: the document is still the seed it was never
    // written to, which reads as "no mission here" rather than as the phase it never reached.
    expect(
      await Effect.runPromise(readMission(harness, root.id, mission)),
    ).toBeUndefined();
    await Effect.runPromise(closeHarness(harness));
  }, 120_000);

  it("keeps one mission's record out of another's", async () => {
    const id = `${logId}-two`;
    const { harness, root } = await startWork(id);
    const workspace = {
      path: checkout(),
      commands: { verify: "true" },
      commandsSource: "repo" as const,
    };

    // Two missions in one conversation, and neither runs yet: the second is aborted before
    // scheduling resumes, so it never enters a phase. Under one document shared by the conversation
    // it would read the first mission's `verify` back as its own; a mission owns its record, so it
    // reads as "this mission has entered no phase". The abort is what makes that deterministic
    // rather than a race between the scheduler and the assertion.
    const first = await createMission(root, {
      feature: "the first feature",
      workspace,
    });
    const second = await createMission(root, {
      feature: "the second feature",
      workspace,
    });
    expect(await harness.abortTask(second, context)).toBe("marked");

    harness.resume();
    await harness.waitForTask(first, context);
    await harness.waitForTask(second, context);

    const both = await Effect.runPromise(
      Effect.all([
        readMission(harness, root.id, first),
        readMission(harness, root.id, second),
      ]),
    );
    expect(both).toEqual([
      {
        phase: "verify",
        definitionVersion: MISSION_VERSION,
        entered: ["plan", "implement", "verify"],
      },
      undefined,
    ]);
    await Effect.runPromise(closeHarness(harness));
  }, 120_000);

  it("settles typed when the session has no execution environment", async () => {
    const id = `${logId}-no-env`;
    // A harness with no `env`: the verify phase has a command it cannot run, so it must settle
    // `failed` with the reason rather than throw out of the phase and fault the task.
    const storage = await PostgresStorage.open(
      sql,
      { logId: id, mode: "owner" },
      context,
    );
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: "factory.mission.test", tasks: [MissionTask] }),
    );
    const harness = await HarnessRuntime.open(
      storage,
      { models: model.models, registry },
      context,
    );
    const root = await harness.root(context, {
      agent: {
        model: { provider: model.provider, modelId: model.modelId },
        cwd: process.cwd(),
      },
    });
    const mission = await createMission(root, {
      feature: "an environment-less feature",
      workspace: {
        path: checkout(),
        commands: { verify: "true" },
        commandsSource: "repo",
      },
    });

    harness.resume();
    const settled = await harness.waitForTask(mission, context);

    expect(settled.state.outcome).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("no execution environment"),
        detail: { phase: "verify", reason: "no-environment" },
      },
    });
    await Effect.runPromise(closeHarness(harness));
  }, 120_000);
});
