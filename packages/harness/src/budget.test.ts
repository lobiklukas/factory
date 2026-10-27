/**
 * The per-session budget cap (LOB-163): a run stops at the limit, and says so.
 *
 * Every case runs a real Pi Durable harness — the hook is a `beforeRequest` on the generation task,
 * and the stop is an abort of the root conversation, so nothing short of a harness can show that the
 * request was never sent. The model is pi-ai's faux provider priced with `fauxCost` (the faux reports
 * a cost of zero on its own), so every answer adds a known amount to `pi.usage`, and its `callCount`
 * is the witness for "the request was never sent": a count the hook reported itself would be the
 * hook grading its own work.
 *
 * The faux script is two requests a run: a `bash` call, then a reply quoting its output. At $0.01 a
 * request, a $0.01 cap is reached by the first answer, so the run must stop before the reply — after
 * the tool ran, with nothing after it but the stop. A $0.05 cap is never reached, and the run must
 * answer as an uncapped one does.
 *
 * No database: the storage is Pi Durable's in-memory implementation, which a fold reads directly.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ChordContext } from "@earendil-works/chord";
import {
  MemoryStorage,
  UsageDoc,
  type Storage,
  type StorageWrite,
  type TaskId,
} from "@earendil-works/pi-durable";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import type { SessionEvent, SessionSnapshot } from "@repo/domain/Session";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { describeBudgetStop, writeBudget } from "./budget";
import { createFauxModelAccess } from "./models";
import { MISSION_TASKS, MissionTask, type MissionResult } from "./mission";
import {
  BUDGET_STOPPED_ENTRY_KIND,
  projectUsageDoc,
  usageCostTotal,
} from "./projection";
import { readReplaySource, replaySession } from "./replay";
import {
  closeHarness,
  forkSession,
  isBusy,
  liveSessionEvents,
  openSession,
  readBudgetSource,
  readHistoricalSnapshot,
  readLiveSnapshot,
  submitMessage,
  writeRepoBinding,
  type OpenSession,
  type SessionRef,
} from "./session";

const COST = 0.01;

const ref = (path: string): SessionRef => ({
  id: SessionIdSchema.make(`ses_${"0".repeat(26)}`),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path, commands: {}, commandsSource: "none" },
});

type Opened = OpenSession & {
  readonly storage: Storage;
  readonly calls: () => number;
  readonly ref: SessionRef;
};

/** A session on a priced faux model, with `cap` committed the way `createSession` commits it. */
const open = async (cap: number | undefined): Promise<Opened> => {
  const storage = new MemoryStorage();
  const cwd = mkdtempSync(join(tmpdir(), "factory-budget-"));
  const { access, faux } = createFauxModelAccess({ fauxCost: COST });
  const session = await Effect.runPromise(
    openSession({ storage, model: access, cwd }),
  );
  if (cap !== undefined)
    await Effect.runPromise(writeBudget(session.root, cap));
  return {
    ...session,
    storage,
    calls: () => faux.state.callCount,
    ref: ref(cwd),
  };
};

/** Send one message and wait for its run to settle; answer how it settled. */
const run = async (session: Opened, content: string) => {
  const submitted = await Effect.runPromise(
    submitMessage(session.root, { content }),
  );
  return submitted.submission.wait(BACKGROUND_CONTEXT);
};

const snapshot = (session: Opened): Promise<SessionSnapshot> =>
  Effect.runPromise(
    readLiveSnapshot(
      { harness: session.harness, root: session.root },
      session.ref,
    ),
  );

const kinds = (snapshot: SessionSnapshot): readonly string[] =>
  snapshot.entries.flatMap((entry) =>
    entry.kind === "system" ? [] : [entry.kind],
  );

const spent = (snapshot: SessionSnapshot): number =>
  [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
    (total, bucket) => total + bucket.usage.costTotal,
    0,
  );

describe("the faux model, priced", () => {
  it("charges every answer what `fauxCost` says, into pi.usage", async () => {
    const session = await open(undefined);
    const settled = await run(session, "go");
    expect(settled.status).toBe("done");
    const after = await snapshot(session);
    // Two requests, a bash call and the reply, at a cent each.
    expect(session.calls()).toBe(2);
    expect(spent(after)).toBeCloseTo(2 * COST, 10);
    // No cap, no budget: the field is absent rather than an infinite cap.
    expect(after.budget).toBeUndefined();
    await Effect.runPromise(closeHarness(session.harness));
  });
});

describe("a budget cap", () => {
  it("stops the run before the request that would spend past the limit", async () => {
    const session = await open(COST);
    const settled = await run(session, "go");

    // The run was stopped, not answered: an aborted run settles unanswered.
    expect(settled.status).toBe("unanswered");
    // The first answer reached the cap; the reply's request was never sent.
    expect(session.calls()).toBe(1);
    const after = await snapshot(session);
    expect(spent(after)).toBeCloseTo(COST, 10);
    // The tool the first answer called still ran; what follows it is the stop, and no reply.
    expect(kinds(after)).toEqual(["user", "assistant", "toolResult", "budget"]);
    expect(await Effect.runPromise(isBusy(session.harness, session.root))).toBe(
      false,
    );
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("reports the stop: a transcript line and the snapshot's budget", async () => {
    const session = await open(COST);
    await run(session, "go");
    const after = await snapshot(session);

    const stop = after.entries.find((entry) => entry.kind === "budget");
    expect(stop?.text).toBe(describeBudgetStop({ spent: COST, cap: COST }));
    expect(stop?.text).toContain("$0.0100 of its $0.0100 cap");
    expect(after.budget?.cap).toBe(COST);
    expect(after.budget?.spent).toBeCloseTo(COST, 10);
    expect(after.budget?.stopped?.cap).toBe(COST);
    expect(after.budget?.stopped?.spent).toBeCloseTo(COST, 10);
    expect(after.budget?.stopped?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("stops a later run before its first request, spending nothing", async () => {
    const session = await open(COST);
    await run(session, "go");
    const settled = await run(session, "go on");

    expect(settled.status).toBe("unanswered");
    expect(session.calls()).toBe(1);
    const after = await snapshot(session);
    expect(spent(after)).toBeCloseTo(COST, 10);
    expect(kinds(after)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "budget",
      "user",
      "budget",
    ]);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("lets a run under the cap answer as an uncapped one does", async () => {
    const session = await open(5 * COST);
    const settled = await run(session, "go");

    expect(settled.status).toBe("done");
    expect(session.calls()).toBe(2);
    const after = await snapshot(session);
    expect(kinds(after)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(after.budget?.cap).toBe(5 * COST);
    expect(after.budget?.spent).toBeCloseTo(2 * COST, 10);
    expect(after.budget?.stopped).toBeUndefined();
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("stops at a cap reached exactly, not only one overshot", async () => {
    // Two answers spend $0.02: a cap of exactly that lets both through, and the next run stops at
    // its first request — `spent >= cap`, so an equal spend is a reached cap.
    const session = await open(2 * COST);
    expect((await run(session, "go")).status).toBe("done");
    expect((await run(session, "go on")).status).toBe("unanswered");
    expect(session.calls()).toBe(2);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("is folded the same way once nobody owns the session", async () => {
    const session = await open(COST);
    await run(session, "go");
    const live = await snapshot(session);
    // Read straight from the log, past the harness: the fold's reader is the storage alone, which is
    // the path a released session is served by (D8). Closing the harness would close the memory
    // storage with it.
    const folded = await Effect.runPromise(
      readHistoricalSnapshot(session.storage, session.ref),
    );
    await Effect.runPromise(closeHarness(session.harness));
    expect(folded.session.mode).toBe("historical");
    expect(folded.budget).toEqual(live.budget);
    expect(folded.budget?.stopped).toBeDefined();
    expect(kinds(folded)).toEqual(kinds(live));
  });
});

/** A session on the priced faux model whose harness runs missions, the way the control plane opens one. */
const openWithMissions = async (cap: number | undefined): Promise<Opened> => {
  const storage = new MemoryStorage();
  const cwd = mkdtempSync(join(tmpdir(), "factory-budget-mission-"));
  const { access, faux } = createFauxModelAccess({ fauxCost: COST });
  const session = await Effect.runPromise(
    openSession({ storage, model: access, cwd, tasks: MISSION_TASKS }),
  );
  if (cap !== undefined)
    await Effect.runPromise(writeBudget(session.root, cap));
  return {
    ...session,
    storage,
    calls: () => faux.state.callCount,
    ref: ref(cwd),
  };
};

/** Start a mission with one worker and no check, and wait for it to settle. */
const runMission = async (session: Opened) => {
  const mission: TaskId<MissionResult> = await session.root.commit(
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
          workers: [{ id: "a", prompt: "go" }],
        },
        { ownership: { kind: "conversation" } },
      ),
    BACKGROUND_CONTEXT,
  );
  session.harness.resume();
  return session.harness.waitForTask(mission, BACKGROUND_CONTEXT);
};

/**
 * A mission's worker talks in a conversation of its own (LOB-193), so its requests are charged to
 * that conversation's `pi.usage`, not the root's. The cap is the session's, and so is the spend the
 * session reports: both have to count the worker's ledger, or a capped session overspends through
 * its workers and reports none of it.
 */
describe("a budget across a mission's workers", () => {
  it("stops a worker's run at the session's cap, though the root spent nothing", async () => {
    // The worker's first answer costs a cent and reaches a one-cent cap that the root, which sent
    // no request at all, is nowhere near: a check of the root's ledger alone would let the reply's
    // request through, and the worker would complete.
    const session = await openWithMissions(COST);
    const settled = await runMission(session);

    expect(session.calls()).toBe(1);
    // The stop aborts the root, whose scope holds the mission and, bottom-up, its worker.
    expect(settled.state.outcome.status).toBe("aborted");
    const after = await snapshot(session);
    expect(
      after.entries.filter((entry) => entry.kind === "budget"),
    ).toHaveLength(1);
    expect(after.budget?.stopped?.spent).toBeCloseTo(COST, 10);
    expect(spent(after)).toBeCloseTo(COST, 10);
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("reports the worker's spend as the session's, live and folded", async () => {
    const session = await openWithMissions(undefined);
    // Attached before the mission starts: the root's view never changes while the worker spends,
    // so a `usage` event that carries the worker's spend can only come from the session-wide read.
    const events: SessionEvent[] = [];
    const attached = Effect.runFork(
      liveSessionEvents(session, session.ref).pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      ),
    );
    const settled = await runMission(session);
    expect(settled.state.outcome.status).toBe("completed");
    const reported = (): number | undefined => {
      const last = events.findLast((event) => event._tag === "usage");
      return last?._tag === "usage" ? usageCostTotal(last.usage) : undefined;
    };
    for (let waited = 0; (reported() ?? 0) < 2 * COST - 1e-9; waited += 5) {
      if (waited > 10_000)
        throw new Error("no usage event reported the worker's spend");
      await Effect.runPromise(Effect.sleep("5 millis"));
    }
    await Effect.runPromise(Fiber.interrupt(attached));
    expect(reported()).toBeCloseTo(2 * COST, 10);
    // Two requests in the worker's conversation, none in the root's.
    expect(session.calls()).toBe(2);
    const root = await session.harness.snapshot(
      UsageDoc,
      session.root.id,
      BACKGROUND_CONTEXT,
    );
    expect(usageCostTotal(projectUsageDoc(root))).toBe(0);

    const live = await snapshot(session);
    expect(spent(live)).toBeCloseTo(2 * COST, 10);
    const folded = await Effect.runPromise(
      readHistoricalSnapshot(session.storage, session.ref),
    );
    expect(folded.usage).toEqual(live.usage);
    // A fork carries what the cap would have counted.
    const source = await Effect.runPromise(readBudgetSource(session.storage));
    expect(source.spent).toBeCloseTo(2 * COST, 10);
    await Effect.runPromise(closeHarness(session.harness));
  });
});

/**
 * A storage over `inner` that dies once a commit recording a budget stop has landed: every commit
 * after it is refused, as if the process went down between recording the stop and the abort that
 * follows it. Closing it leaves `inner` open, so a second harness can recover from the same log.
 */
const dyingAfterStop = (inner: MemoryStorage): Storage => {
  let dead = false;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commit") {
        return (writes: readonly StorageWrite[], context: ChordContext) => {
          if (dead)
            return Promise.reject(new Error("crash: the process is gone"));
          return target.commit(writes, context).then((seq) => {
            if (JSON.stringify(writes).includes(BUDGET_STOPPED_ENTRY_KIND))
              dead = true;
            return seq;
          });
        };
      }
      if (property === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

describe("a budget stop across a recovery", () => {
  it("is recorded once: the recovered request re-checks and finds its stop", async () => {
    const inner = new MemoryStorage();
    const cwd = mkdtempSync(join(tmpdir(), "factory-budget-"));
    const first = createFauxModelAccess({ fauxCost: COST });
    const dying = dyingAfterStop(inner);
    const opened = await Effect.runPromise(
      openSession({ storage: dying, model: first.access, cwd }),
    );
    await Effect.runPromise(writeBudget(opened.root, COST));
    await Effect.runPromise(submitMessage(opened.root, { content: "go" }));
    // The stop landed and the process "died" before its abort could commit.
    await expect
      .poll(
        () =>
          Effect.runPromise(readHistoricalSnapshot(inner, ref(cwd))).then(
            (folded) => folded.budget?.stopped !== undefined,
          ),
        { timeout: 10_000, interval: 20 },
      )
      .toBe(true);
    await Effect.runPromise(closeHarness(opened.harness)).catch(
      () => undefined,
    );

    const second = createFauxModelAccess({ fauxCost: COST });
    const recovered = await Effect.runPromise(
      openSession({ storage: inner, model: second.access, cwd }),
    );
    recovered.harness.resume();
    await recovered.harness.waitForIdle(BACKGROUND_CONTEXT);
    const after = await Effect.runPromise(
      readLiveSnapshot(recovered, ref(cwd)),
    );
    await Effect.runPromise(closeHarness(recovered.harness));

    // The first process's abort was refused, and it still held the request rather than send it: a
    // stop that cannot be committed fails closed. Its one request is the answer that reached the cap.
    expect(first.faux.state.callCount).toBe(1);
    // The recovery sent nothing, and the one stop the log holds is the first process's.
    expect(second.faux.state.callCount).toBe(0);
    expect(
      after.entries.filter((entry) => entry.kind === "budget"),
    ).toHaveLength(1);
    expect(after.live.busy).toBe(false);
  });
});

/**
 * A storage over `inner` that refuses the first commit `matches` picks once `armed` is set, and lets
 * every other commit through — though Pi Durable poisons the harness on that one refusal, so nothing
 * after it commits anyway. `refused` is the witness the test waits on.
 */
const refusingOne = (
  inner: MemoryStorage,
  matches: (writes: readonly StorageWrite[]) => boolean,
) => {
  const state = { armed: false, refused: false };
  const storage: Storage = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commit") {
        return (writes: readonly StorageWrite[], context: ChordContext) => {
          if (state.armed && !state.refused && matches(writes)) {
            state.refused = true;
            return Promise.reject(new Error("the log refused this commit"));
          }
          return target.commit(writes, context);
        };
      }
      if (property === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage, state };
};

const holdsTheRequest = async (
  matches: (writes: readonly StorageWrite[]) => boolean,
) => {
  const inner = new MemoryStorage();
  const cwd = mkdtempSync(join(tmpdir(), "factory-budget-"));
  const { access, faux } = createFauxModelAccess({ fauxCost: COST });
  const { storage, state } = refusingOne(inner, matches);
  const session = await Effect.runPromise(
    openSession({ storage, model: access, cwd }),
  );
  await Effect.runPromise(writeBudget(session.root, COST));
  state.armed = true;
  await Effect.runPromise(submitMessage(session.root, { content: "go" }));
  await expect
    .poll(() => state.refused, { timeout: 10_000, interval: 20 })
    .toBe(true);
  // Long enough for a request let through to have been sent: the faux answers at once.
  await Effect.runPromise(Effect.sleep("300 millis"));
  expect(faux.state.callCount).toBe(1);
  // Closing the harness is what ends the hold, and the request is still never sent.
  await Effect.runPromise(closeHarness(session.harness)).catch(() => undefined);
  expect(faux.state.callCount).toBe(1);
};

describe("a budget stop whose commit the log refuses", () => {
  it("holds the request when the stop cannot be recorded, rather than send it", async () => {
    await holdsTheRequest((writes) =>
      JSON.stringify(writes).includes(BUDGET_STOPPED_ENTRY_KIND),
    );
  });

  it("holds the request when the abort cannot be committed, rather than send it", async () => {
    // The first commit after the stop is recorded is the abort's marking: refuse that one.
    let recorded = false;
    await holdsTheRequest((writes) => {
      if (JSON.stringify(writes).includes(BUDGET_STOPPED_ENTRY_KIND)) {
        recorded = true;
        return false;
      }
      return recorded;
    });
  });
});

/** A capped session, run until the cap stopped it: the parent every fork and replay case starts from. */
const stoppedParent = async (cap: number | undefined) => {
  const parent = await open(cap);
  await Effect.runPromise(
    writeRepoBinding(parent.root, {
      repo: "lobiklukas/factory",
      baseRef: "main",
    }),
  );
  await run(parent, "go");
  return parent;
};

describe("a budget across a fork", () => {
  const forkOf = async (parent: Opened, defaultBudget?: number) => {
    const child = new MemoryStorage();
    const cwd = mkdtempSync(join(tmpdir(), "factory-budget-fork-"));
    const { access, faux } = createFauxModelAccess({ fauxCost: COST });
    const forked = await Effect.runPromise(
      forkSession({
        parent: parent.storage,
        child,
        lineage: String(parent.ref.id),
        model: access,
        cwd,
        ...(defaultBudget === undefined ? {} : { defaultBudget }),
      }),
    );
    const session: Opened = {
      ...forked,
      storage: child,
      calls: () => faux.state.callCount,
      ref: ref(cwd),
    };
    return session;
  };

  it("keeps the parent's cap and spend: a fork of a stopped session is stopped too", async () => {
    const parent = await stoppedParent(COST);
    const fork = await forkOf(parent, 100 * COST);
    await Effect.runPromise(closeHarness(parent.harness));

    const before = await snapshot(fork);
    // The parent's cap, not the default: a capped session's fork is held to the same ceiling.
    expect(before.budget?.cap).toBe(COST);
    expect(before.budget?.spent).toBeCloseTo(COST, 10);
    // The parent's stop is in the copied transcript; the fork has not been stopped itself yet.
    expect(before.budget?.stopped).toBeUndefined();

    const settled = await run(fork, "keep going");
    expect(settled.status).toBe("unanswered");
    expect(fork.calls()).toBe(0);
    const after = await snapshot(fork);
    expect(after.budget?.stopped?.spent).toBeCloseTo(COST, 10);
    await Effect.runPromise(closeHarness(fork.harness));
  });

  it("gives an uncapped parent's fork the default cap, carrying the parent's spend", async () => {
    const parent = await stoppedParent(undefined);
    const fork = await forkOf(parent, 2 * COST);
    await Effect.runPromise(closeHarness(parent.harness));

    const before = await snapshot(fork);
    expect(before.budget?.cap).toBe(2 * COST);
    // The parent's two answers count: a fork starting from nothing would have the whole default
    // left; this one has reached it, and its first request is never sent.
    expect(before.budget?.spent).toBeCloseTo(2 * COST, 10);
    const settled = await run(fork, "keep going");
    expect(settled.status).toBe("unanswered");
    expect(fork.calls()).toBe(0);
    await Effect.runPromise(closeHarness(fork.harness));
  });

  it("leaves an uncapped parent's fork uncapped when there is no default", async () => {
    const parent = await stoppedParent(undefined);
    const fork = await forkOf(parent);
    await Effect.runPromise(closeHarness(parent.harness));
    expect((await snapshot(fork)).budget).toBeUndefined();
    await Effect.runPromise(closeHarness(fork.harness));
  });
});

describe("a budget across a replay", () => {
  const replayOf = async (source: Opened, defaultBudget?: number) => {
    const origin = await Effect.runPromise(readReplaySource(source.storage));
    const target = new MemoryStorage();
    const cwd = mkdtempSync(join(tmpdir(), "factory-budget-replay-"));
    const { access, faux } = createFauxModelAccess({ fauxCost: COST });
    const replayed = await Effect.runPromise(
      replaySession({
        source: origin,
        sourceId: String(source.ref.id),
        replayId: `ses_${"1".repeat(26)}`,
        target,
        model: access,
        cwd,
        ...(defaultBudget === undefined ? {} : { defaultBudget }),
      }),
    );
    const settled =
      await replayed.submission.submission.wait(BACKGROUND_CONTEXT);
    const session: Opened = {
      ...replayed,
      storage: target,
      calls: () => faux.state.callCount,
      ref: ref(cwd),
    };
    return { session, settled };
  };

  it("keeps the source's cap at no spend, so the replayed run is held to it from its first request", async () => {
    const source = await stoppedParent(COST);
    const { session, settled } = await replayOf(source, 100 * COST);
    await Effect.runPromise(closeHarness(source.harness));

    // A fresh run under the source's cap: its first answer reaches it, its reply is never sent.
    expect(settled.status).toBe("unanswered");
    expect(session.calls()).toBe(1);
    const after = await snapshot(session);
    expect(after.budget?.cap).toBe(COST);
    expect(after.budget?.spent).toBeCloseTo(COST, 10);
    expect(after.budget?.stopped).toBeDefined();
    await Effect.runPromise(closeHarness(session.harness));
  });

  it("gives an uncapped source's replay the default cap", async () => {
    const source = await stoppedParent(undefined);
    const { session, settled } = await replayOf(source, COST);
    await Effect.runPromise(closeHarness(source.harness));

    expect(settled.status).toBe("unanswered");
    expect(session.calls()).toBe(1);
    expect((await snapshot(session)).budget?.cap).toBe(COST);
    await Effect.runPromise(closeHarness(session.harness));
  });
});
