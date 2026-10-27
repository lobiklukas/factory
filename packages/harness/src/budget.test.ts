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
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import type { SessionSnapshot } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { describeBudgetStop, writeBudget } from "./budget";
import { createFauxModelAccess } from "./models";
import { BUDGET_STOPPED_ENTRY_KIND } from "./projection";
import {
  closeHarness,
  isBusy,
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

    // The recovery sent nothing, and the one stop the log holds is the first process's.
    expect(second.faux.state.callCount).toBe(0);
    expect(
      after.entries.filter((entry) => entry.kind === "budget"),
    ).toHaveLength(1);
    expect(after.live.busy).toBe(false);
  });
});
