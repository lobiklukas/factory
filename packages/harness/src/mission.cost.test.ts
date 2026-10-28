/**
 * Per-worker cost attribution in a mission's snapshot (LOB-194): each worker's spend is read from the
 * `pi.usage` of the conversation it owns, and the workers' costs add up to the session's.
 *
 * The model is pi-ai's faux provider priced with `fauxCost` (it reports a cost of zero on its own),
 * and its `callCount` is the witness for the numbers: a cost the snapshot reported about itself would
 * be the snapshot grading its own work, so every expectation here is either a count of requests the
 * faux provider served or a read of `pi.usage` straight off the harness (`UsageDoc`), never the
 * projection under test.
 *
 * Two workers run in conversations of their own, and the second is then spoken to once more so the
 * two spends differ — a breakdown that handed every worker the same share, or the first worker's
 * share twice, would still add up to a total some other way, but not to these per-worker numbers.
 * No database: the storage is Pi Durable's in-memory implementation, wrapped so a harness can be
 * closed and a second opened over the same log, which is what a reopen is.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  UsageDoc,
  type ConversationId,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import type { SessionSnapshot } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MissionDoc, MissionBindingDoc } from "./docs";
import {
  MISSION_TASKS,
  MissionTask,
  missionKey,
  type MissionResult,
} from "./mission";
import { createFauxModelAccess } from "./models";
import { usageCostTotal } from "./projection";
import {
  closeHarness,
  openSession,
  readHistoricalSnapshot,
  readLiveSnapshot,
  submitMessage,
  type OpenSession,
  type SessionRef,
} from "./session";

const COST = 0.01;

const ref = (path: string): SessionRef => ({
  id: SessionIdSchema.make(`ses_${"0".repeat(26)}`),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: {
    path,
    commands: { verify: "true" },
    commandsSource: "repo",
  },
});

/** `inner` as a storage a harness can close without ending the log, so a second harness can open it. */
const closable = (inner: MemoryStorage): Storage =>
  new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

type Opened = OpenSession & {
  readonly inner: MemoryStorage;
  readonly calls: () => number;
  readonly ref: SessionRef;
};

/** A session on a priced faux model whose harness runs missions, the way the control plane opens one. */
const open = async (
  options: { readonly sleepMs?: number } = {},
  inner = new MemoryStorage(),
  cwd = mkdtempSync(join(tmpdir(), "factory-mission-cost-")),
): Promise<Opened> => {
  const { access, faux } = createFauxModelAccess({
    fauxCost: COST,
    ...(options.sleepMs === undefined ? {} : { fauxSleepMs: options.sleepMs }),
  });
  const session = await Effect.runPromise(
    openSession({
      storage: closable(inner),
      model: access,
      cwd,
      tasks: MISSION_TASKS,
    }),
  );
  return {
    ...session,
    inner,
    calls: () => faux.state.callCount,
    ref: ref(cwd),
  };
};

const startMission = (
  session: Opened,
  workers: readonly { readonly id: string; readonly prompt: string }[],
): Promise<TaskId<MissionResult>> =>
  session.root
    .commit(
      (tx) =>
        tx.createTask(
          MissionTask,
          {
            feature: "a feature",
            workspace: {
              path: session.ref.workspace.path,
              commands: { verify: "true" },
              commandsSource: "repo",
            },
            workers,
          },
          { ownership: { kind: "conversation" } },
        ),
      BACKGROUND_CONTEXT,
    )
    .then(async (mission) => {
      // The binding is what the snapshot reads the mission through; `startMission` writes it in the
      // same commit as the task, and this case creates the task itself to hold its workers.
      await session.root.commit(
        (tx) =>
          tx.doc(MissionBindingDoc, session.root.id).then((binding) => {
            binding.taskId = missionKey(mission);
          }),
        BACKGROUND_CONTEXT,
      );
      return mission;
    });

const live = (session: Opened): Promise<SessionSnapshot> =>
  Effect.runPromise(readLiveSnapshot(session, session.ref));

/** What `pi.usage` says a conversation spent, read off the harness: the ledger, not a projection of it. */
const ledgerCost = async (
  session: Opened,
  conversationId: string,
): Promise<number> => {
  const doc = await session.harness.snapshot(
    UsageDoc,
    Number(conversationId) as ConversationId,
    BACKGROUND_CONTEXT,
  );
  const buckets = [
    ...Object.values(doc?.models ?? {}),
    ...Object.values(doc?.tools ?? {}),
  ];
  return buckets.reduce((total, usage) => total + usage.cost.total, 0);
};

describe("a mission's per-worker cost", () => {
  it("reports each worker's own spend, and the workers add up to the session's total", async () => {
    const session = await open();
    const mission = await startMission(session, [
      { id: "a", prompt: "do part a" },
      { id: "b", prompt: "do part b" },
    ]);
    session.harness.resume();
    const settled = await session.harness.waitForTask(
      mission,
      BACKGROUND_CONTEXT,
    );
    expect(settled.state.outcome.status).toBe("completed");

    const before = await live(session);
    const [a, b] = before.mission?.workers ?? [];
    if (a === undefined || b === undefined)
      throw new Error("the snapshot lists fewer than two workers");
    // Each worker ran its prompt as a bash call and its reply: two requests apiece.
    expect(session.calls()).toBe(4);

    // Speak to the second worker's conversation once more, so the two workers' spends differ.
    const bConversation = await session.harness.conversation(
      Number(b.conversationId) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (bConversation === undefined)
      throw new Error("the worker's conversation is gone");
    const more = await Effect.runPromise(
      submitMessage(bConversation, { content: "and one more thing" }),
    );
    await more.submission.wait(BACKGROUND_CONTEXT);
    const extra = session.calls() - 4;
    expect(extra).toBeGreaterThan(0);

    const after = await live(session);
    const workers = after.mission?.workers ?? [];
    // In the order the mission's input named them, keyed by the mission's own worker ids.
    expect(workers.map((worker) => worker.id)).toEqual(["a", "b"]);
    expect(workers.map((worker) => worker.taskId)).toEqual(
      before.mission?.workers?.map((worker) => worker.taskId),
    );
    const [costA, costB] = workers.map((worker) => worker.usage.costTotal);
    expect(costA).toBeCloseTo(2 * COST, 10);
    expect(costB).toBeCloseTo((2 + extra) * COST, 10);
    expect(costA).not.toBeCloseTo(costB ?? 0, 6);

    // The numbers are the ledgers': `pi.usage` of the conversation each worker owns, read apart
    // from the projection, and the request count the faux provider served.
    for (const worker of workers) {
      if (worker.conversationId === undefined)
        throw new Error(`worker ${worker.id} owns no conversation`);
      expect(worker.usage.costTotal).toBeCloseTo(
        await ledgerCost(session, worker.conversationId),
        10,
      );
    }
    expect((costA ?? 0) + (costB ?? 0)).toBeCloseTo(session.calls() * COST, 10);

    // The workers' costs reconcile with the session's: the root spent nothing, so they are all of it.
    expect(
      workers.reduce((sum, worker) => sum + worker.usage.costTotal, 0),
    ).toBeCloseTo(usageCostTotal(after.usage), 10);
    // A worker's tokens are attributed with its cost, not only the cost.
    expect(workers.every((worker) => worker.usage.totalTokens > 0)).toBe(true);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("reports a worker that ran nothing as zero rather than leaving it out", async () => {
    // The faux model naps before every answer, and the mission is aborted during the nap: each
    // worker owns a conversation and was never answered in it.
    const session = await open({ sleepMs: 60_000 });
    const mission = await startMission(session, [
      { id: "a", prompt: "do part a" },
      { id: "b", prompt: "do part b" },
    ]);
    session.harness.resume();
    for (let waited = 0; ; waited += 5) {
      const workers = (await live(session)).mission?.workers ?? [];
      if (
        workers.length === 2 &&
        workers.every((worker) => worker.conversationId !== undefined)
      )
        break;
      if (waited > 10_000) throw new Error("the workers never opened");
      await Effect.runPromise(Effect.sleep("5 millis"));
    }
    await session.root.abort(BACKGROUND_CONTEXT);
    const settled = await session.harness.waitForTask(
      mission,
      BACKGROUND_CONTEXT,
    );
    expect(settled.state.outcome.status).toBe("aborted");

    const after = await live(session);
    expect(after.mission?.workers?.map((worker) => worker.id)).toEqual([
      "a",
      "b",
    ]);
    for (const worker of after.mission?.workers ?? [])
      expect(worker.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        costTotal: 0,
      });
    // Their requests were interrupted mid-nap, and an interrupted request is never charged.
    expect(usageCostTotal(after.usage)).toBe(0);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("lists a worker that has no conversation yet, with zero spend and no conversation id", async () => {
    // The roster is written by the fan-out before a worker's first commit creates its conversation;
    // read in between, the worker is a task with nothing it could have spent in.
    const session = await open();
    await session.root.commit(
      (tx) =>
        Promise.all([
          tx.doc(MissionBindingDoc, session.root.id),
          tx.doc(MissionDoc, session.root.id, "9", "9"),
        ]).then(([binding, doc]) => {
          binding.taskId = "9";
          doc.phase = "implement";
          doc.entered = ["plan", "implement"];
          doc.definitionVersion = 2;
          doc.workers = [{ id: "a", taskId: "10", conversationId: "" }];
        }),
      BACKGROUND_CONTEXT,
    );
    const snapshot = await live(session);
    expect(snapshot.mission?.workers).toEqual([
      {
        id: "a",
        taskId: "10",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costTotal: 0,
        },
      },
    ]);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("reads the attribution from the log: a reopened harness and a fold report the same workers", async () => {
    const first = await open();
    const mission = await startMission(first, [
      { id: "a", prompt: "do part a" },
      { id: "b", prompt: "do part b" },
    ]);
    first.harness.resume();
    await first.harness.waitForTask(mission, BACKGROUND_CONTEXT);
    const before = await live(first);
    expect(before.mission?.workers).toHaveLength(2);
    expect(
      before.mission?.workers?.every((worker) => worker.usage.costTotal > 0),
    ).toBe(true);
    await Effect.runPromise(closeHarness(first.harness));

    // A second process over the same log, with a model that has served nothing: whatever it
    // reports, it read from the log.
    const second = await open({}, first.inner, first.ref.workspace.path);
    const reopened = await live(second);
    expect(second.calls()).toBe(0);
    expect(reopened.mission?.workers).toEqual(before.mission?.workers);
    // Nobody owns the log here: the fold has no harness, only storage.
    const folded = await Effect.runPromise(
      readHistoricalSnapshot(first.inner, first.ref),
    );
    expect(folded.mission?.workers).toEqual(before.mission?.workers);
    expect(
      (folded.mission?.workers ?? []).reduce(
        (sum, worker) => sum + worker.usage.costTotal,
        0,
      ),
    ).toBeCloseTo(usageCostTotal(folded.usage), 10);
    await Effect.runPromise(closeHarness(second.harness));
  });

  it("reports no workers for a mission that fanned out to none", async () => {
    const session = await open();
    const mission = await startMission(session, []);
    session.harness.resume();
    await session.harness.waitForTask(mission, BACKGROUND_CONTEXT);
    const snapshot = await live(session);
    expect(snapshot.mission?.phase).toBe("verify");
    expect(snapshot.mission?.workers).toBeUndefined();
    await Effect.runPromise(closeHarness(session.harness));
  });
});
