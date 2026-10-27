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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
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
  defineTask,
  Harness as HarnessRuntime,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MissionDoc } from "./docs";
import {
  MISSION_VERSION,
  MissionTask,
  missionKey,
  readMission,
  type MissionInput,
  type MissionPhase,
  type MissionResult,
  type MissionState,
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

/** A mission definition the registry runs: the current one, or a stand-in an older version wrote. */
type MissionDefinition = typeof MissionTask;

/** One log, opened the way the control plane opens it: a registry, a faux model and a real shell. */
const openHarness = async (
  id: string,
  mode: "owner" | "reader",
  mission: MissionDefinition = MissionTask,
): Promise<{ readonly harness: Harness; readonly storage: Storage }> => {
  const storage = await PostgresStorage.open(sql, { logId: id, mode }, context);
  const registry = createRegistry();
  // The mission is the registry's only task: a phase's work is the mission's own, not a tool's.
  registry.install(
    defineExtension({ name: "factory.mission.test", tasks: [mission] }),
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
  mission: MissionDefinition = MissionTask,
): Promise<{
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: Storage;
}> => {
  const { harness, storage } = await openHarness(id, "owner", mission);
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

/** Resolve once `holds` answers true, polling; reject after `ms` so a stuck mission fails the case. */
const eventually = async (
  what: string,
  holds: () => boolean,
  ms = 30_000,
): Promise<void> => {
  for (let waited = 0; !holds(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
};

/** The phase a task record's checkpoint names, or `undefined` once the task has settled. */
const checkpointPhase = (
  record: { readonly state: { readonly checkpoint?: unknown } } | undefined,
): string | undefined => {
  const checkpoint = record?.state.checkpoint;
  return typeof checkpoint === "object" &&
    checkpoint !== null &&
    "phase" in checkpoint &&
    typeof checkpoint.phase === "string"
    ? checkpoint.phase
    : undefined;
};

/**
 * A stand-in for the mission as version 1 left it in a log: the same task kind at version 1, whose
 * task starts at `checkpoint`. Its phases never run — the case commits the document v1 wrote by
 * hand and closes the harness — so only the record it stores matters: the kind, the version and the
 * checkpoint a reopen reserves.
 */
const missionV1 = (checkpoint: MissionPhase): MissionDefinition =>
  defineTask<MissionInput, MissionState, MissionResult>({
    name: MissionTask.definition.name,
    version: 1,
    initial: () => ({ phase: checkpoint }),
    phases: MissionTask.definition.phases,
    abort: (task, runtime, invocation) =>
      MissionTask.definition.abort(task, runtime, invocation),
  });

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
  it("never names a phase its checkpoint is not in, sampled while it runs", async () => {
    const dir = checkout();
    const id = `${logId}-sampled`;
    const { harness, root } = await startWork(id);
    // The verify command holds its phase open until the case releases it. That is the one window
    // long enough to read deterministically, and it is where version 1 left the document saying
    // `implement` while the checkpoint, and so a reopened harness, said `verify` (LOB-233).
    const verify =
      "touch verify.started; while [ ! -f verify.release ]; do sleep 0.01; done";
    const mission = await createMission(root, {
      feature: "a sampled mission",
      workspace: { path: dir, commands: { verify }, commandsSource: "repo" },
    });

    // A sample is the checkpoint and the document read back to back. The task is read on both
    // sides of the document and a sample kept only when the two task reads agree: every commit a
    // mission takes moves its checkpoint or settles it, so equal reads mean no commit landed between
    // them and the document read belongs to the same commit as the checkpoint.
    const samples: { checkpoint: string; doc: string | undefined }[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const before = await harness.getTask(mission, context);
        const doc = await Effect.runPromise(
          readMission(harness, root.id, mission),
        );
        const after = await harness.getTask(mission, context);
        const checkpoint = checkpointPhase(before);
        if (
          checkpoint !== undefined &&
          JSON.stringify(before?.state) === JSON.stringify(after?.state)
        )
          samples.push({ checkpoint, doc: doc?.phase });
        await Effect.runPromise(Effect.sleep("1 millis"));
      }
    })();

    harness.resume();
    await eventually("verify to start", () =>
      existsSync(join(dir, "verify.started")),
    );
    // Held in verify until the sampler has read that window, so the case cannot pass by missing it.
    await eventually("a sample taken while verify runs", () =>
      samples.some((sample) => sample.checkpoint === "verify"),
    );
    writeFileSync(join(dir, "verify.release"), "");
    const settled = await harness.waitForTask(mission, context);
    sampling = false;
    await sampler;

    expect(settled.state.outcome).toMatchObject({ status: "completed" });
    // The claim: no sample names a phase other than the checkpoint's. The one allowance is a mission
    // whose document was never written — created without the start's seed and not yet past plan —
    // which reads as no phase at all rather than as a wrong one.
    expect(
      samples.filter(
        (sample) =>
          sample.doc !== sample.checkpoint &&
          !(sample.doc === undefined && sample.checkpoint === "plan"),
      ),
    ).toEqual([]);
    expect(
      samples.some(
        (sample) => sample.checkpoint === "verify" && sample.doc === "verify",
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(readMission(harness, root.id, mission)),
    ).toEqual({
      phase: "verify",
      definitionVersion: MISSION_VERSION,
      entered: ["plan", "implement", "verify"],
    });
    await Effect.runPromise(closeHarness(harness));
  }, 120_000);

  it.each([
    {
      killed: "between plan's commit and implement's",
      checkpoint: "implement",
      written: { phase: "plan", entered: ["plan"] },
      reads: { phase: "implement", entered: ["plan", "implement"] },
    },
    {
      killed: "while verify ran",
      checkpoint: "verify",
      written: { phase: "implement", entered: ["plan", "implement"] },
      reads: { phase: "verify", entered: ["plan", "implement", "verify"] },
    },
  ] as const)(
    "opens a document version 1 wrote, killed $killed, at the phase the mission is in",
    async ({ checkpoint, written, reads }) => {
      const dir = checkout();
      const id = `${logId}-v1-${checkpoint}`;
      // The log as version 1 left it: a v1 task record whose checkpoint is `checkpoint`, and in the
      // same commit the document v1's `enterPhase` wrote one phase behind it.
      const old = await startWork(id, missionV1(checkpoint));
      const mission = await old.root.commit(
        (tx) =>
          tx
            .createTask(
              missionV1(checkpoint),
              {
                feature: "a version 1 mission",
                workspace: {
                  path: dir,
                  commands: { verify: "true" },
                  commandsSource: "repo",
                },
              },
              { ownership: { kind: "conversation" } },
            )
            .then((created) => {
              const key = missionKey(created);
              return tx.doc(MissionDoc, old.root.id, key, key).then((doc) => {
                doc.mission = key;
                doc.phase = written.phase;
                doc.entered = [...written.entered];
                doc.definitionVersion = 1;
                return created;
              });
            }),
        context,
      );
      await Effect.runPromise(closeHarness(old.harness));

      // Reopened under the current definition, before anything runs: the record is still v1's, and
      // the document reads the phase the checkpoint is in rather than the one before it.
      const { harness } = await openHarness(id, "owner");
      const record = await harness.getTask(mission, context);
      expect(record?.version).toBe(1);
      expect(checkpointPhase(record)).toBe(checkpoint);
      expect(
        await Effect.runPromise(readMission(harness, old.root.id, mission)),
      ).toEqual({ ...reads, definitionVersion: 1 });

      // And the task itself migrates: the current definition reserves the v1 record, resumes it in
      // the phase it died in, and the commit it takes rewrites the document under this version.
      // Asked of the scheduler first, so a definition with no `migrate` fails here as `blocked`
      // rather than as a wait that never ends.
      const inspection = await harness.inspect(context);
      expect(
        inspection.tasks.find((task) => task.record.id === mission)?.state,
      ).toEqual({ kind: "ready", migrates: true });
      harness.resume();
      const settled = await harness.waitForTask(mission, context);
      expect(settled.state.outcome).toMatchObject({ status: "completed" });
      expect(
        await Effect.runPromise(readMission(harness, old.root.id, mission)),
      ).toEqual({
        phase: "verify",
        definitionVersion: MISSION_VERSION,
        entered: ["plan", "implement", "verify"],
      });
      await Effect.runPromise(closeHarness(harness));
    },
    120_000,
  );

  it("refuses to migrate a record that is not a mission's", () => {
    const migrate = (input: JsonValue, checkpoint: JsonValue, from: number) =>
      MissionTask.definition.migrate?.(input, checkpoint, from);
    const input = {
      feature: "a mission",
      workspace: { path: "/w", commands: {}, commandsSource: "none" },
    };
    expect(migrate(input, { phase: "verify" }, 1)).toEqual({
      input,
      checkpoint: { phase: "verify" },
    });
    // A phase this definition has no handler for, and an input with no workspace, throw: Pi Durable
    // records a failed migration and blocks the task instead of running a phase on a foreign shape.
    expect(() => migrate(input, { phase: "implementing" }, 1)).toThrow();
    expect(() =>
      migrate({ feature: "a mission" }, { phase: "verify" }, 1),
    ).toThrow();
  });
});
