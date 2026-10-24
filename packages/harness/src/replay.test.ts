/**
 * Replaying a recorded session's task on another model (LOB-198), over a real Postgres log.
 *
 * The claims here are about two logs again, but a replay is not a fork: the replay's transcript
 * starts empty and fills with its own run, so what it takes from the source is the *task*. The
 * interesting half is therefore the direction of the arrow — the source is read and never written —
 * which is what the last case checks byte for byte.
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
import { createModelAccess, modelAccessFor, modelKey } from "./models";
import { readReplaySource, replaySession } from "./replay";
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

/** A source session: a repo binding, one turn, and the model its log then records. */
const recordedSession = (id: string, prompt: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() => openStorage(id));
      const { harness, root } = yield* openSession({
        storage,
        model: models,
        cwd: workdir,
      });
      yield* writeRepoBinding(root, { repo, baseRef: "main" });
      const submitted = yield* submitMessage(root, { content: prompt });
      yield* Effect.promise(() => submitted.submission.wait(context));
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
