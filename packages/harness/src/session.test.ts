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
import type { Message } from "@earendil-works/pi-ai";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
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
  readLiveSnapshot,
  readPromptSections,
  readSessionLog,
  resetSession,
  submitMessage,
  type SessionRef,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");

const workdir = mkdtempSync(join(tmpdir(), "factory-harness-"));
const logId = `harness-test-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

/** The control plane's view of this log, for the tests that read a snapshot rather than a fold. */
const ref: SessionRef = {
  id: SessionIdSchema.make(`ses_${"0".repeat(26)}`),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path: workdir, commands: {}, commandsSource: "none" },
};

/** Model messages as text, so a context can be compared to what was written into it. */
const messageTexts = (messages: readonly Message[]): readonly string[] =>
  messages.map((message) =>
    typeof message.content === "string"
      ? message.content
      : message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join(""),
  );

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

const openStorage = (id: string = logId) =>
  PostgresStorage.open(sql, { logId: id, mode: "owner" }, context);

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

  /**
   * LOB-181: a reset is a new model context, not a lost transcript.
   *
   * The two halves are the point and they pull in opposite directions: `ContextView.messages` — what
   * the next provider request carries — must hold the handoff alone, while the transcript must still
   * hold the turns before it, with the `reset` entry between them. Mutation checked: dropping the
   * full-log scan in `readConversationEntries` / `readAllEntries` (back to the newest head marker)
   * leaves the transcript starting at the reset entry, and both transcript assertions go red.
   */
  it("a reset starts a fresh context and keeps the past in the transcript", async () => {
    const handoff = "we were fixing the flaky login test; continue from there";
    const resetLog = `${logId}-reset`;
    const storage = await openStorage(resetLog);

    const live = await runtime.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const submitted = yield* submitMessage(root, {
          content: "before the reset",
          requestId: "reset-before",
        });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const before = yield* readLiveSnapshot(root, ref);
        expect(before.entries.map((entry) => entry.kind)).toContain("user");

        yield* resetSession(root, handoff);

        // What the model sees: the handoff, and nothing from before it.
        const opened = yield* Effect.promise(() => root.context(context));
        expect(messageTexts(opened.messages)).toEqual([handoff]);

        // What a reader sees: the whole transcript, with the reset marked where it happened.
        const after = yield* readLiveSnapshot(root, ref);
        const kinds = after.entries.map((entry) => entry.kind);
        expect(kinds.slice(0, before.entries.length)).toEqual(
          before.entries.map((entry) => entry.kind),
        );
        expect(kinds).toContain("reset");
        expect(
          after.entries.find((entry) => entry.kind === "reset")?.text,
        ).toBe(handoff);
        expect(after.entries.length).toBe(before.entries.length + 1);

        yield* closeHarness(harness);
        return after;
      }),
    );

    // The fold is the other read path (D8), and it has to agree — including the history.
    const folded = await runtime.runPromise(
      readSessionLog(await openStorage(resetLog)),
    );
    expect(folded.entries).toEqual(live.entries);
  }, 120_000);

  /**
   * LOB-181: a reset with no handoff still starts a context (an empty one) and still marks the
   * boundary, so "reset" and "reset with notes" are one behaviour with one shape.
   */
  it("a reset with no handoff leaves an empty context and marks the entry", async () => {
    const storage = await openStorage(`${logId}-bare-reset`);
    const { emptyContext, entries } = await runtime.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const submitted = yield* submitMessage(root, {
          content: "a turn to forget",
          requestId: "bare-reset-before",
        });
        yield* Effect.promise(() => submitted.submission.wait(context));

        yield* resetSession(root, undefined);

        const opened = yield* Effect.promise(() => root.context(context));
        const after = yield* readLiveSnapshot(root, ref);
        yield* closeHarness(harness);
        return {
          emptyContext: messageTexts(opened.messages),
          entries: after.entries,
        };
      }),
    );

    expect(emptyContext).toEqual([]);
    const resetEntry = entries.find((entry) => entry.kind === "reset");
    expect(resetEntry?.text).toBe("");
    // The turn before it is still readable, which is what makes the entry a boundary.
    expect(entries.some((entry) => entry.text === "a turn to forget")).toBe(
      true,
    );
  }, 120_000);
});

/**
 * A fork copies the parent's entries, so the interesting part is not the entries — it is the head
 * marker a `reset` writes: entry ids are minted per log, so the copy has to rewrite the marker to
 * the copy of the entry it names, and a copy that drops it makes the fork's model context reach
 * back past what the parent's own context carries. This case therefore resets the parent in the
 * middle, so that the parent's transcript and its *context* differ (LOB-181: a head marker bounds
 * the context, not the transcript): a fork that copied the entries but not the marker would show
 * `before the reset` in its context where the parent shows nothing.
 */
describe("forking a session", () => {
  it("copies the parent's transcript through the fork point, head marker included", async () => {
    const parentLog = `${logId}-fork-parent`;
    const childLog = `${logId}-fork-child`;
    const owner = (id: string) =>
      PostgresStorage.open(sql, { logId: id, mode: "owner" }, context);
    const reader = (id: string) =>
      PostgresStorage.open(sql, { logId: id, mode: "reader" }, context);

    const parentContext = await runtime.runPromise(
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
        // What the parent's model is sent, which is what the copied head marker has to reproduce.
        const opened = yield* Effect.promise(() => root.context(context));
        yield* closeHarness(harness);
        return messageTexts(opened.messages);
      }),
    );

    const parentFold = await runtime.runPromise(
      Effect.gen(function* () {
        const opened = yield* Effect.promise(() => reader(parentLog));
        return yield* readSessionLog(opened);
      }),
    );
    // The premise: the parent's *context* begins at the reset, so the turn before it is still in the
    // transcript and no longer in what the model is sent.
    expect(
      parentFold.entries.filter((entry) => entry.kind === "reset"),
    ).toHaveLength(1);
    expect(
      parentFold.entries.some((entry) => entry.text === "before the reset"),
    ).toBe(true);
    expect(parentContext).not.toContain("before the reset");
    expect(parentContext).toContain("handoff note");

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
        const view = yield* Effect.promise(() => opened.root.context(context));
        yield* closeHarness(opened.harness);
        const reread = yield* Effect.promise(() => reader(childLog));
        const log = yield* readSessionLog(reread);
        yield* Effect.promise(() => reread.dispose());
        return { at: opened.at, log, context: messageTexts(view.messages) };
      }),
    );

    // The fork's transcript is the parent's, entry for entry — the prefix the issue asks for.
    expect(forked.log.entries.map((entry) => entry.text)).toEqual(
      parentFold.entries.map((entry) => entry.text),
    );
    // And its context is the parent's too, which is only true if the head marker was copied and
    // rewritten to the fork's own entry id.
    expect(forked.context).toEqual(parentContext);
    expect(forked.log.forkedFrom).toBe(parentLog);
    expect(forked.at).not.toBe("");
  }, 120_000);
});

/** The body a run is told, with no trailing newline so the rendered tag is exact. */
const SPECIFY_BODY =
  "# Specify\n\nClarify the goal, scope, acceptance criteria, and risks.";
const REVIEW_BODY = "# Review\n\nReport evidenced findings.";

describe("a run's column decides its prompt", () => {
  it("commits each skill body as one prompt section, in the column's order", async () => {
    const skillsLogId = `harness-skills-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

    const sections = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          PostgresStorage.owner(sql, skillsLogId),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
          run: {
            column: "specifying",
            skills: [
              { name: "specify", body: SPECIFY_BODY },
              { name: "review", body: REVIEW_BODY },
            ],
          },
        });
        const submitted = yield* submitMessage(root, { content: "begin" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const prompts = yield* readPromptSections(storage);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return prompts;
      }),
    );

    // The sections are Pi Durable's tagged form, which is what the model is actually sent: the
    // committed `pi.system` entry replays these before the first request of the run.
    expect(sections["skill_specify"]).toBe(
      `<skill_specify>\n${SPECIFY_BODY}\n</skill_specify>`,
    );
    expect(sections["skill_review"]).toBe(
      `<skill_review>\n${REVIEW_BODY}\n</skill_review>`,
    );
    // Nothing the column did not name is injected, and the order is the column's.
    expect(Object.keys(sections)).toEqual(["skill_specify", "skill_review"]);
  }, 120_000);

  it("injects nothing when the run's column names no skills", async () => {
    const plainLogId = `harness-plain-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

    const sections = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          PostgresStorage.owner(sql, plainLogId),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const submitted = yield* submitMessage(root, { content: "begin" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const prompts = yield* readPromptSections(storage);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return prompts;
      }),
    );

    expect(sections).toEqual({});
  }, 120_000);
});
