/**
 * A reopen continues the run a dead process left behind (LOB-25): `openSession` resumes the
 * submissions its log holds unsettled, so nobody has to call `Harness.resume()` by hand — and nobody
 * has to send the session another message — for an interrupted run to carry on.
 *
 * The first "process" is a harness over a storage that dies once the run's tool call has started:
 * every commit after that is refused, as if the process were gone, and its close releases nothing.
 * The second is a fresh harness over the same log, opened the way the control plane opens one.
 *
 * Every wait below reads committed state (`isBusy` reads `pi.live`, `inspect` scans submissions)
 * rather than calling `waitForIdle` or `Submission.wait()`: those enable Pi Durable's scheduler
 * themselves, so a wait on them would pass whether or not the open resumed anything. The witness is
 * `inspect().scheduling` and a run that settles with nobody asking.
 *
 * No database: the storage is Pi Durable's in-memory implementation. The kill of a real process,
 * over Postgres and through the control plane, is `packages/core`'s ("a run across a kill").
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context as ChordContext } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createFauxModelAccess } from "./models";
import {
  closeHarness,
  isBusy,
  openSession,
  readLiveSnapshot,
  resumePending,
  submitMessage,
  type OpenSession,
  type SessionRef,
} from "./session";

const context = BACKGROUND_CONTEXT;

const ref = (path: string): SessionRef => ({
  id: SessionIdSchema.make(`ses_${"0".repeat(26)}`),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path, commands: {}, commandsSource: "none" },
});

/**
 * A storage over `inner` that dies when `dead()` turns true: every commit after it is refused and
 * its close does nothing, so the harness over it stops where it stood and `inner` stays open for the
 * next one — what a SIGKILL leaves, minus the process.
 */
const dying = (inner: MemoryStorage, dead: () => boolean): Storage =>
  new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commit") {
        return (writes: readonly StorageWrite[], chord: ChordContext) =>
          dead()
            ? Promise.reject(new Error("killed: the process is gone"))
            : target.commit(writes, chord);
      }
      if (property === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** Poll `check` until it holds, or fail naming `what`. */
const eventually = (
  what: string,
  check: () => Promise<boolean> | boolean,
): Promise<void> =>
  expect
    .poll(check, { timeout: 20_000, interval: 20, message: what })
    .toBe(true);

/** The tool call's runs, counted into the working directory by the command itself. */
const runsIn = (cwd: string): number =>
  existsSync(join(cwd, "runs"))
    ? readFileSync(join(cwd, "runs"), "utf8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;

/**
 * Start a run in a first process whose tool call holds until `release` exists, kill that process
 * once the call has started, and answer what the reopen needs: the log, the submission, the root.
 */
const killMidRun = async () => {
  const inner = new MemoryStorage();
  const cwd = mkdtempSync(join(tmpdir(), "factory-resume-"));
  let dead = false;
  const holds = `echo run >> ${join(cwd, "runs")}; while [ ! -f ${join(cwd, "release")} ]; do sleep 0.01; done`;
  const first = await Effect.runPromise(
    openSession({
      storage: dying(inner, () => dead),
      model: createFauxModelAccess({ fauxCommand: holds }).access,
      cwd,
    }),
  );
  const submitted = await Effect.runPromise(
    submitMessage(first.root, { content: "go", requestId: "the-request" }),
  );
  await eventually("the tool call to start", () => runsIn(cwd) === 1);
  dead = true;
  return { inner, cwd, first, submitted };
};

/** Let the first process's held command end, and drop the harness it left behind. */
const bury = async (cwd: string, first: OpenSession) => {
  writeFileSync(join(cwd, "release"), "");
  await Effect.runPromise(closeHarness(first.harness)).catch(() => undefined);
  await Effect.runPromise(first.releaseEnvironment);
};

describe("a reopen after a kill", () => {
  it("continues the run as the same submission, and runs its tool call once", async () => {
    const { inner, cwd, first, submitted } = await killMidRun();
    const second = createFauxModelAccess({ fauxCommand: "echo second" });
    try {
      const reopened = await Effect.runPromise(
        openSession({ storage: inner, model: second.access, cwd }),
      );
      // The open is the resume: it names the submission it continued, and the scheduler runs
      // without anybody having asked for progress.
      expect(reopened.resumed).toEqual([submitted.submissionId]);
      expect(reopened.root.id).toBe(first.root.id);
      expect((await reopened.harness.inspect(context)).scheduling).toBe(
        "running",
      );
      await eventually(
        "the resumed run to settle",
        async () =>
          !(await Effect.runPromise(isBusy(reopened.harness, reopened.root))),
      );

      const after = await reopened.harness.inspect(context);
      const snapshot = await Effect.runPromise(
        readLiveSnapshot(reopened, ref(cwd)),
      );
      // A retry of the same request after the reopen finds the run that answered it rather than
      // starting another.
      const retried = await Effect.runPromise(
        submitMessage(reopened.root, {
          content: "go",
          requestId: "the-request",
        }),
      );
      const settled = await reopened.harness.submission(
        submitted.submission.id,
        context,
      );
      const record = await settled?.status(context);
      const retriedSnapshot = await Effect.runPromise(
        readLiveSnapshot(reopened, ref(cwd)),
      );
      await Effect.runPromise(closeHarness(reopened.harness));
      await Effect.runPromise(reopened.releaseEnvironment);

      // Nothing is left unsettled, and what settled is the one submission the client sent.
      expect(after.submissions).toEqual([]);
      expect(record?.status).toBe("done");
      expect(retried.submissionId).toBe(submitted.submissionId);
      const users = (entries: typeof snapshot.entries) =>
        entries.filter((entry) => entry.kind === "user");
      expect(users(snapshot.entries)).toHaveLength(1);
      expect(users(retriedSnapshot.entries)).toHaveLength(1);
      // The tool call the kill interrupted is settled as interrupted, not run a second time: its
      // command counted one run, and the answer that follows it is the resumed run's.
      expect(runsIn(cwd)).toBe(1);
      const results = snapshot.entries.filter(
        (entry) => entry.kind === "toolResult",
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.text).toContain("interrupted");
      expect(snapshot.entries.at(-1)?.kind).toBe("assistant");
      expect(snapshot.live.busy).toBe(false);
      // The second process made the run's one remaining request; the retry made none.
      expect(second.faux.state.callCount).toBe(1);
    } finally {
      await bury(cwd, first);
    }
  }, 60_000);

  it("opens paused when told not to resume, and `resumePending` is the deliberate call", async () => {
    const { inner, cwd, first, submitted } = await killMidRun();
    try {
      const reopened = await Effect.runPromise(
        openSession({
          storage: inner,
          model: createFauxModelAccess({ fauxCommand: "echo second" }).access,
          cwd,
          resume: false,
        }),
      );
      expect(reopened.resumed).toEqual([]);
      const paused = await reopened.harness.inspect(context);
      expect(paused.scheduling).toBe("paused");
      // Still placed, still the run: a paused open neither settles nor drops it.
      expect(paused.submissions.map((record) => String(record.id))).toEqual([
        submitted.submissionId,
      ]);
      expect(
        await Effect.runPromise(isBusy(reopened.harness, reopened.root)),
      ).toBe(true);

      const resumed = await Effect.runPromise(resumePending(reopened.harness));
      expect(resumed).toEqual([submitted.submissionId]);
      await eventually(
        "the resumed run to settle",
        async () =>
          !(await Effect.runPromise(isBusy(reopened.harness, reopened.root))),
      );
      expect((await reopened.harness.inspect(context)).submissions).toEqual([]);
      await Effect.runPromise(closeHarness(reopened.harness));
      await Effect.runPromise(reopened.releaseEnvironment);
    } finally {
      await bury(cwd, first);
    }
  }, 60_000);

  it("resumes nothing over a log whose runs all settled", async () => {
    const storage = new MemoryStorage();
    const kept = dying(storage, () => false);
    const cwd = mkdtempSync(join(tmpdir(), "factory-resume-settled-"));
    const first = await Effect.runPromise(
      openSession({
        storage: kept,
        model: createFauxModelAccess({ fauxCommand: "echo ok" }).access,
        cwd,
      }),
    );
    // Nothing to continue in a log that has never run anything either.
    expect(first.resumed).toEqual([]);
    const sent = await Effect.runPromise(
      submitMessage(first.root, { content: "go" }),
    );
    await sent.submission.wait(context);
    await Effect.runPromise(closeHarness(first.harness));
    await Effect.runPromise(first.releaseEnvironment);

    const reopened = await Effect.runPromise(
      openSession({
        storage,
        model: createFauxModelAccess({ fauxCommand: "echo ok" }).access,
        cwd,
      }),
    );
    const inspection = await reopened.harness.inspect(context);
    await Effect.runPromise(closeHarness(reopened.harness));
    await Effect.runPromise(reopened.releaseEnvironment);
    expect(reopened.resumed).toEqual([]);
    expect(inspection.scheduling).toBe("paused");
  }, 60_000);
});
