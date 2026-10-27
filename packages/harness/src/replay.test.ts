/**
 * Replaying a recorded session's task on another model (LOB-198), over a real Postgres log.
 *
 * The claims here are about two logs again, but a replay is not a fork: the replay's transcript
 * starts empty and fills with its own run, so what it takes from the source is the *task*. The
 * interesting half is therefore the direction of the arrow — the source is read and never written —
 * which is what the replay case checks byte for byte. The comparison (LOB-199) is the one write a
 * replay makes back to its source, and the cases after it check that it is a document and nothing
 * else.
 *
 * Deterministic and offline (the faux provider), but it needs Postgres:
 * `docker compose up -d --wait postgres`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplayRun, SessionId } from "@repo/domain/Session";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import {
  createFauxModelAccess,
  createModelAccess,
  modelAccessFor,
  modelKey,
  type ModelAccess,
} from "./models";
import { projectReplayComparisons } from "./projection";
import {
  compareReplay,
  readReplayRun,
  readReplaySource,
  replaySession,
  writeReplayComparison,
} from "./replay";
import {
  closeHarness,
  openSession,
  readSessionLog,
  submitMessage,
  writeRepoBinding,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;

/**
 * Two faux models, so "the same task on a different model" is a difference this file can make: the
 * faux backend publishes one model unless it is told otherwise (LOB-198).
 */
const models = createModelAccess("faux", {
  fauxModels: ["faux-1", "faux-2"],
});

const workdir = mkdtempSync(join(tmpdir(), "factory-replay-"));
const repo = "lobiklukas/factory";

/** A log id nobody else uses, so two runs of this file cannot share a session. */
const newLogId = (name: string) =>
  `replay-${name}-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

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

const openStorage = (id: string, mode: "owner" | "reader" = "owner") =>
  PostgresStorage.open(sql, { logId: id, mode }, context);

/**
 * A source session: a repo binding, one turn per prompt, and the model its log then records. The
 * first prompt is the task a replay takes; any after it are follow-ups only the source ran.
 */
const recordedSession = (
  id: string,
  prompt: string,
  followUps: readonly string[] = [],
  model: ModelAccess = models,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() => openStorage(id));
      const { harness, root } = yield* openSession({
        storage,
        model,
        cwd: workdir,
      });
      yield* writeRepoBinding(root, { repo, baseRef: "main" });
      for (const content of [prompt, ...followUps]) {
        const submitted = yield* submitMessage(root, { content });
        yield* Effect.promise(() => submitted.submission.wait(context));
      }
      // Closing the harness closes the log it owns, so a caller reads through a reader of its own.
      yield* closeHarness(harness);
    }),
  );

describe("reading what a replay needs", () => {
  it("reads the prompt, the binding and the model the log recorded", async () => {
    const id = newLogId("source");
    await recordedSession(id, "fix the flaky login test");
    const source = await runtime.runPromise(
      Effect.gen(function* () {
        const reader = yield* Effect.promise(() => openStorage(id, "reader"));
        return yield* readReplaySource(reader);
      }),
    );

    expect(source.prompt).toBe("fix the flaky login test");
    expect(source.binding).toEqual({ repo, baseRef: "main" });
    // The only place a log names a model is its spend, keyed `provider/modelId`.
    expect(source.model).toBe("faux/faux-1");
  }, 120_000);

  it("refuses a session bound to no repo instead of replaying into a scratch directory", async () => {
    const id = newLogId("unbound");
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => openStorage(id));
        const { harness, root } = yield* openSession({
          storage,
          model: models,
          cwd: workdir,
        });
        const submitted = yield* submitMessage(root, { content: "hello" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        yield* closeHarness(harness);
      }),
    );

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const reader = yield* Effect.promise(() => openStorage(id, "reader"));
        return yield* Effect.exit(readReplaySource(reader));
      }),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") throw new Error("unreachable");
    const failure = outcome.cause;
    expect(String(failure)).toContain("no repo");
  }, 120_000);

  it("refuses a session with no prompt to replay", async () => {
    const id = newLogId("empty");
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => openStorage(id));
        const { harness, root } = yield* openSession({
          storage,
          model: models,
          cwd: workdir,
        });
        yield* writeRepoBinding(root, { repo, baseRef: "main" });
        yield* closeHarness(harness);
      }),
    );

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const reader = yield* Effect.promise(() => openStorage(id, "reader"));
        return yield* readReplaySource(reader);
      }).pipe(Effect.exit),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") throw new Error("unreachable");
    expect(String(outcome.cause)).toContain("no prompt");
  }, 120_000);
});

describe("replaying a session", () => {
  it("runs the same prompt on another model and leaves the source untouched", async () => {
    const sourceId = newLogId("source");
    const replayId = newLogId("replay");
    await recordedSession(sourceId, "fix the flaky login test");

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sourceReader = yield* Effect.promise(() =>
          openStorage(sourceId, "reader"),
        );
        const source = yield* readReplaySource(sourceReader);
        const before = yield* readSessionLog(sourceReader);
        const target = modelAccessFor(models, "faux/faux-2");
        if (target === undefined) throw new Error("unreachable");
        // The premise of the second assertion below, checked rather than assumed.
        expect(modelKey(target)).not.toBe(modelKey(models));

        const replayStorage = yield* Effect.promise(() =>
          openStorage(replayId),
        );
        const replay = yield* replaySession({
          source,
          sourceId,
          replayId,
          target: replayStorage,
          model: target,
          title: "fix the flaky login test",
          cwd: workdir,
        });
        yield* Effect.promise(() => replay.submission.submission.wait(context));
        // Read the replay's log before the harness closes the log it owns.
        const replayLog = yield* readSessionLog(replayStorage);
        yield* closeHarness(replay.harness);
        const after = yield* readSessionLog(sourceReader);
        return { replayLog, before, after };
      }),
    );

    // The task the replay ran is the source's first user entry, and its own transcript is its own:
    // the second entry is the replay's answer, not a copy of the source's.
    const firstUser = result.replayLog.entries.find(
      (entry) => entry.kind === "user",
    );
    expect(firstUser?.text).toBe("fix the flaky login test");
    expect(result.replayLog.entries.map((entry) => entry.kind)).not.toEqual(
      result.before.entries.map((entry) => entry.kind),
    );

    // The link names both sessions, and the two models, from the replay's own log.
    expect(result.replayLog.replay).toEqual({
      source: sourceId,
      model: "faux/faux-2",
      from: "faux/faux-1",
    });
    expect(result.replayLog.binding).toEqual({ repo, baseRef: "main" });

    // And the run really was on the other model: spend is keyed by model.
    expect(result.replayLog.usage.models.map((entry) => entry.key)).toEqual([
      "faux/faux-2",
    ]);

    // The source log is unchanged: same entries, same spend, same lineage — nothing at all.
    expect(result.after).toEqual(result.before);
  }, 120_000);
});

/** A session id for a run of this file: the comparison names its sides by `SessionId`. */
const runId = (logId: string): SessionId => SessionIdSchema.make(logId);

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A fresh, well-formed session id, so a log of this file can be one side of a comparison. */
const newSessionLogId = (): string =>
  `ses_${Array.from(
    { length: 26 },
    () =>
      ID_ALPHABET[
        Effect.runSync(Random.nextIntBetween(0, ID_ALPHABET.length - 1))
      ],
  ).join("")}`;

describe("comparing a replay with its source", () => {
  const run = (overrides: Partial<ReplayRun>): ReplayRun => ({
    session: runId(`ses_${"1".repeat(26)}`),
    model: "faux/faux-1",
    outcome: "answered",
    turns: 0,
    cost: 0,
    ...overrides,
  });

  it("names the other side on each, with deltas that are exact opposites", () => {
    const source = run({ turns: 5, cost: 0.3 });
    const replay = run({
      session: runId(`ses_${"2".repeat(26)}`),
      model: "faux/faux-2",
      turns: 2,
      cost: 0.1,
    });
    const compared = compareReplay({
      source,
      replay,
      at: "2026-10-27T00:00:00.000Z",
    });

    expect(compared.replay.role).toBe("replay");
    expect(compared.replay.self).toEqual(replay);
    expect(compared.replay.counterpart).toEqual(source);
    expect(compared.source.role).toBe("source");
    expect(compared.source.self).toEqual(source);
    expect(compared.source.counterpart).toEqual(replay);
    // Each delta is its own side minus the other, so the replay's is negative here and the source's
    // positive — the same magnitudes, which a delta computed once and copied would not make.
    expect(compared.replay.delta.turns).toBe(-3);
    expect(compared.source.delta.turns).toBe(3);
    expect(compared.replay.delta.cost).toBe(0.1 - 0.3);
    expect(compared.source.delta.cost).toBe(-(0.1 - 0.3));
  });

  it("projects no comparison from no document, and drops one that does not decode", () => {
    expect(projectReplayComparisons(undefined)).toEqual([]);
    // A document LOB-198 wrote: the link and nothing else.
    expect(
      projectReplayComparisons({
        source: "ses_a",
        replay: "ses_b",
        model: "faux/faux-2",
        from: "faux/faux-1",
      }),
    ).toEqual([]);
    const compared = compareReplay({
      source: run({}),
      replay: run({ session: runId(`ses_${"2".repeat(26)}`) }),
      at: "2026-10-27T00:00:00.000Z",
    });
    const later = compareReplay({
      source: run({}),
      replay: run({ session: runId(`ses_${"3".repeat(26)}`) }),
      at: "2026-10-27T00:00:01.000Z",
    });
    expect(
      projectReplayComparisons({
        comparisons: {
          [`ses_${"3".repeat(26)}`]: later.source,
          [`ses_${"2".repeat(26)}`]: compared.source,
          ses_broken: { role: "source", at: 7 },
        },
      }),
    ).toEqual([compared.source, later.source]);
  });
});

describe("committing the comparison to both logs", () => {
  /** What each answer costs, so the two runs' spend differs by how many answers each made. */
  const COST = 0.01;
  const priced = createFauxModelAccess({
    fauxModels: ["faux-1", "faux-2"],
    fauxCost: COST,
  }).access;

  it("measures each run, commits a document naming the other to each log, and changes nothing else", async () => {
    const sourceId = newSessionLogId();
    const replayId = newSessionLogId();
    // The source took a follow-up the replay never runs, so it made more requests and spent more.
    await recordedSession(
      sourceId,
      "fix the flaky login test",
      ["and the logout one"],
      priced,
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sourceReader = yield* Effect.promise(() =>
          openStorage(sourceId, "reader"),
        );
        const source = yield* readReplaySource(sourceReader);
        const before = yield* readSessionLog(sourceReader);
        const target = modelAccessFor(priced, "faux/faux-2");
        if (target === undefined) throw new Error("unreachable");
        const replayStorage = yield* Effect.promise(() =>
          openStorage(replayId),
        );
        const replay = yield* replaySession({
          source,
          sourceId,
          replayId,
          target: replayStorage,
          model: target,
          cwd: workdir,
        });
        yield* Effect.promise(() => replay.submission.submission.wait(context));

        const replayReader = yield* Effect.promise(() =>
          openStorage(replayId, "reader"),
        );
        const replayRun = yield* readReplayRun(
          replayReader,
          runId(replayId),
          modelKey(target),
        );
        const sourceRun = yield* readReplayRun(
          sourceReader,
          runId(sourceId),
          source.model ?? "",
        );
        const compared = compareReplay({
          source: sourceRun,
          replay: replayRun,
          at: "2026-10-27T00:00:00.000Z",
        });
        // Twice on the replay: recording the same pair again rewrites its entry, it adds none.
        yield* writeReplayComparison(replay.root, compared.replay);
        yield* writeReplayComparison(replay.root, compared.replay);
        yield* closeHarness(replay.harness);

        // The source is written through an owner of its own, as the control plane opens one.
        const sourceOwner = yield* Effect.promise(() => openStorage(sourceId));
        const opened = yield* openSession({
          storage: sourceOwner,
          model: priced,
          cwd: workdir,
        });
        yield* writeReplayComparison(opened.root, compared.source);
        yield* closeHarness(opened.harness);

        const after = yield* readSessionLog(
          yield* Effect.promise(() => openStorage(sourceId, "reader")),
        );
        const replayLog = yield* readSessionLog(
          yield* Effect.promise(() => openStorage(replayId, "reader")),
        );
        return { before, after, replayLog, replayRun, sourceRun, compared };
      }),
    );

    // Each run measured from its own log: both answered, on the models the link names, and the
    // source made more requests (two prompts) and spent a known amount more for each.
    expect(result.replayRun).toMatchObject({
      session: replayId,
      model: "faux/faux-2",
      outcome: "answered",
    });
    expect(result.sourceRun).toMatchObject({
      session: sourceId,
      model: "faux/faux-1",
      outcome: "answered",
    });
    expect(result.replayRun.turns).toBeGreaterThan(0);
    expect(result.sourceRun.turns).toBeGreaterThan(result.replayRun.turns);
    expect(result.replayRun.cost).toBeCloseTo(
      result.replayRun.turns * COST,
      10,
    );
    expect(result.sourceRun.cost).toBeCloseTo(
      result.sourceRun.turns * COST,
      10,
    );

    // Both logs carry the comparison naming the other, once each, with opposite deltas.
    expect(result.replayLog.replayComparisons).toEqual([
      result.compared.replay,
    ]);
    expect(result.after.replayComparisons).toEqual([result.compared.source]);
    const [onReplay] = result.replayLog.replayComparisons;
    const [onSource] = result.after.replayComparisons;
    if (onReplay === undefined || onSource === undefined)
      throw new Error("unreachable");
    expect(onReplay.counterpart.session).toBe(sourceId);
    expect(onSource.counterpart.session).toBe(replayId);
    expect(onReplay.delta.turns).toBeLessThan(0);
    expect(onReplay.delta.turns + onSource.delta.turns).toBe(0);
    expect(onReplay.delta.cost).toBeLessThan(0);
    expect(onReplay.delta.cost + onSource.delta.cost).toBe(0);

    // The replay's link is untouched by the comparison, and the source never reads as a replay.
    expect(result.replayLog.replay).toEqual({
      source: sourceId,
      model: "faux/faux-2",
      from: "faux/faux-1",
    });
    expect(result.after.replay).toBeUndefined();
    // The source's recorded run is what it was: only the comparison differs.
    expect({ ...result.after, replayComparisons: [] }).toEqual(result.before);
  }, 120_000);
});
