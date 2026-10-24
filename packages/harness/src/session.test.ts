/**
 * The integration the design depends on and nothing had proven: a `Harness` over
 * `PostgresStorage`, one real turn with a tool call, and a reopen that replays the transcript.
 *
 * Deterministic and offline: the model is pi-ai's faux provider, so the gate needs no API key.
 * It does need Postgres (`docker compose up -d --wait postgres`), because the point is the log.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelAccess } from "./models";
import { projectView } from "./projection";
import {
  closeHarness,
  forkSession,
  isBusy,
  openSession,
  readSessionLog,
  submitMessage,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");

const workdir = mkdtempSync(join(tmpdir(), "factory-harness-"));
const logId = `harness-test-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

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

const openStorage = () =>
  PostgresStorage.open(sql, { logId, mode: "owner" }, context);

/** One turn through the session, returning the settled transcript. */
const turn = (
  storage: Awaited<ReturnType<typeof openStorage>>,
  message: string,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { harness, root } = yield* openSession({
        storage,
        model,
        cwd: workdir,
      });
      const submitted = yield* submitMessage(root, {
        content: message,
        requestId: `request-${message}`,
      });
      expect(submitted.queued).toBe(false);
      // The live document says a run is in flight, which is what a UI labels as busy.
      expect(yield* isBusy(harness, root)).toBe(true);
      const settled = yield* Effect.promise(() =>
        submitted.submission.wait(context),
      );
      expect(settled.status).toBe("done");
      expect(yield* isBusy(harness, root)).toBe(false);

      const view = yield* Effect.promise(() => root.viewState(context));
      const projection = projectView(view.value);
      view.dispose();
      yield* closeHarness(harness);
      return projection;
    }),
  );

describe("a session over PostgresStorage", () => {
  it("runs a turn with a tool call and replays it after a reopen", async () => {
    // 1. Drive one turn over the log.
    const first = await turn(await openStorage(), "hello");

    const user = first.entries.find((entry) => entry.kind === "user");
    expect(user?.text).toBe("hello");

    const toolResult = first.entries.find(
      (entry) => entry.kind === "toolResult",
    );
    expect(toolResult?.toolName).toBe("bash");
    expect(toolResult?.text).toContain("faux-ok");
    expect(toolResult?.isError).toBe(false);

    // The faux script answers with the tool's own output, so this text can only exist if the
    // bash call really ran and its result really came back into the transcript.
    const answers = first.entries.filter((entry) => entry.kind === "assistant");
    expect(answers.length).toBe(2);
    expect(answers[0]?.toolCalls).toEqual([
      { id: expect.any(String), name: "bash" },
    ]);
    expect(answers.at(-1)?.text).toBe("faux-ok (re: hello)");

    expect(first.status).toBe("idle");

    // 2. It is a log, not just memory.
    const rows = await runtime.runPromise(
      sql<{ count: number }>`
        SELECT count(*)::int AS count FROM commits WHERE log_id = ${logId}
      `,
    );
    expect(rows[0]?.count ?? 0).toBeGreaterThan(0);

    // 3. A fresh owner-mode instance replays the same transcript. This is the part that was
    //    never proven: the fold and the live view must agree, or D8 has two different truths.
    const reopened = await openStorage();
    const replayed = await runtime.runPromise(readSessionLog(reopened));
    expect(replayed.entries).toEqual(first.entries);

    // 4. The reopened harness continues the same conversation rather than starting a new one.
    const second = await turn(reopened, "again");
    expect(second.entries.length).toBeGreaterThan(first.entries.length);
    const continued = second.entries
      .filter((entry) => entry.kind === "assistant")
      .at(-1);
    expect(continued?.text).toBe("faux-ok (re: again)");
    expect(second.entries.slice(0, first.entries.length)).toEqual(
      first.entries,
    );
  }, 120_000);
});

/**
 * A fork copies the parent's entries, so the interesting part is not the entries — it is the head
 * marker a `reset` writes: entry ids are minted per log, so the copy has to rewrite the marker to
 * the copy of the entry it names, and a copy that drops it makes the fork's active transcript reach
 * back past the parent's own context. This case therefore resets the parent in the middle, so that
 * the parent's transcript and its *log* differ: a fork that copied the entries but not the marker
 * would show `before the reset` where the parent shows nothing.
 */
describe("forking a session", () => {
  it("copies the parent's transcript through the fork point, head marker included", async () => {
    const parentLog = `${logId}-fork-parent`;
    const childLog = `${logId}-fork-child`;
    const owner = (id: string) =>
      PostgresStorage.open(sql, { logId: id, mode: "owner" }, context);
    const reader = (id: string) =>
      PostgresStorage.open(sql, { logId: id, mode: "reader" }, context);

    await runtime.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage: yield* Effect.promise(() => owner(parentLog)),
          model,
          cwd: workdir,
        });
        const before = yield* submitMessage(root, {
          content: "before the reset",
          requestId: "before the reset",
        });
        yield* Effect.promise(() => before.submission.wait(context));
        // A reset starts a new context and carries the handoff as a user message (Pi Durable's
        // `Conversation.reset`).
        yield* Effect.promise(() => root.reset("handoff note", context));
        const after = yield* submitMessage(root, {
          content: "after the reset",
          requestId: "after the reset",
        });
        yield* Effect.promise(() => after.submission.wait(context));
        yield* closeHarness(harness);
      }),
    );

    const parentFold = await runtime.runPromise(
      Effect.gen(function* () {
        const opened = yield* Effect.promise(() => reader(parentLog));
        return yield* readSessionLog(opened);
      }),
    );
    // The premise: the parent's active transcript begins at the reset, so the entries before it are
    // in its log and not in its transcript.
    expect(
      parentFold.entries.filter((entry) => entry.kind === "reset"),
    ).toHaveLength(1);
    expect(
      parentFold.entries.some((entry) => entry.text === "before the reset"),
    ).toBe(false);

    const forked = await runtime.runPromise(
      Effect.gen(function* () {
        const child = yield* Effect.promise(() => owner(childLog));
        const opened = yield* forkSession({
          parent: yield* Effect.promise(() => reader(parentLog)),
          child,
          lineage: parentLog,
          model,
          cwd: workdir,
        });
        yield* closeHarness(opened.harness);
        const reread = yield* Effect.promise(() => reader(childLog));
        const log = yield* readSessionLog(reread);
        yield* Effect.promise(() => reread.dispose());
        return { at: opened.at, log };
      }),
    );

    // The fork's active transcript is the parent's, entry for entry — which is only true if the
    // head marker was copied and rewritten to the fork's own entry id.
    expect(forked.log.entries.map((entry) => entry.text)).toEqual(
      parentFold.entries.map((entry) => entry.text),
    );
    expect(forked.log.forkedFrom).toBe(parentLog);
    expect(forked.at).not.toBe("");
  }, 120_000);
});
