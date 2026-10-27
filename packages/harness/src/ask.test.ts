/**
 * The ask on the task, at the harness seam (LOB-73; docs/board.md B7).
 *
 * The card and its thread are the control plane's; what is proven here is what the harness does with
 * the two things it is handed — the `ask` callback and the thread — without a board: that asking
 * ends the run with no further model request, that a refused ask does not, and that the thread
 * reaches the committed `pi.system` entry verbatim. `packages/core`'s session suite drives the same
 * path through a real card, and `.pi/skills/verify-board/ask.sh` through two processes.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { TaskComment } from "@repo/domain/Task";
import { TaskId } from "@repo/domain/Task";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_COMMENT_CHARS } from "@repo/domain/Task";
import {
  ASK_TOOL,
  describeAsk,
  describeCrowdedAsk,
  omittedMarker,
  renderThread,
  THREAD_CHAR_CAP,
  THREAD_SECTION_KEY,
  type AskOptions,
  type AskReceipt,
} from "./ask";
import { createFauxModelAccess } from "./models";
import {
  closeHarness,
  isBusy,
  openSession,
  readPromptSections,
  readSessionLog,
  submitMessage,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const workdir = mkdtempSync(join(tmpdir(), "factory-harness-ask-"));
const QUESTION = "Which Postgres major does this target?";
const TASK = TaskId.make(`tsk_${"0".repeat(26)}`);

let sql: SqlClient;

beforeAll(async () => {
  sql = await runtime.runPromise(SqlClient);
}, 60_000);

afterAll(() => runtime.dispose());

const freshLogId = () =>
  `harness-ask-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

const comment = (
  kind: TaskComment["kind"],
  actor: string,
  body: string,
  revision: number,
): TaskComment => ({
  taskId: TASK,
  kind,
  actor,
  body,
  revision,
  createdAt: "2026-10-27T00:00:00.000Z",
});

/**
 * One run of a session opened with `ask` and `thread`, the faux scripted to ask, settled; with what
 * the model was asked, what the log holds, and whether the conversation is still busy.
 */
const runOnce = (options: {
  readonly ask?: AskOptions;
  readonly thread?: readonly TaskComment[];
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const faux = createFauxModelAccess({ fauxAsk: QUESTION });
      const thread = options.thread ?? [];
      const storage = yield* Effect.promise(() =>
        PostgresStorage.owner(sql, freshLogId()),
      );
      const { harness, root } = yield* openSession({
        storage,
        model: faux.access,
        cwd: workdir,
        ...(options.ask === undefined ? {} : { ask: options.ask }),
        ...(options.thread === undefined
          ? {}
          : { thread: () => Promise.resolve(thread) }),
      });
      const submitted = yield* submitMessage(root, { content: "specify it" });
      yield* Effect.promise(() =>
        submitted.submission.wait(BACKGROUND_CONTEXT),
      );
      const busy = yield* isBusy(harness, root);
      const log = yield* readSessionLog(storage);
      const sections = yield* readPromptSections(storage);
      yield* closeHarness(harness);
      yield* Effect.promise(() => storage.dispose());
      return {
        busy,
        requests: faux.faux.state.callCount,
        entries: log.entries,
        sections,
      };
    }),
  );

describe("renderThread", () => {
  it("quotes every comment verbatim, oldest first, under who wrote it", () => {
    const answer = "Postgres 16.\n  Keep port 5442.  ";
    const text = renderThread([
      comment("question", "ses_run", QUESTION, 2),
      comment("answer", "person:lukas", answer, 4),
    ]);
    expect(text).toBeDefined();
    expect(text).toContain(
      `[question] ses_run at revision 2:\n${QUESTION}\n\n[answer] person:lukas at revision 4:\n${answer}`,
    );
    expect(text?.endsWith(answer)).toBe(true);
  });

  it("is no section at all for a card with no comments", () => {
    expect(renderThread([])).toBeUndefined();
  });

  it("drops the oldest comments past its budget, says how many, and keeps the newest two whole", () => {
    const long = (fill: string) => fill.repeat(MAX_COMMENT_CHARS);
    const thread = [
      comment("note", "person:lukas", "the oldest note", 1),
      comment("note", "person:lukas", long("n"), 2),
      comment("question", "ses_run", long("q"), 3),
      comment("answer", "person:lukas", long("a"), 4),
    ];
    const text = renderThread(thread) ?? "";
    expect(text).toContain(omittedMarker(2));
    expect(text).not.toContain("the oldest note");
    expect(text).toContain(`\n${long("q")}\n\n[answer]`);
    expect(text.endsWith(`\n${long("a")}`)).toBe(true);
    // Within budget, nothing is dropped and no marker stands in.
    const short = renderThread(thread.slice(0, 1)) ?? "";
    expect(short).toContain("the oldest note");
    expect(short).not.toContain("omitted");
    // The two newest stay even when they alone are over a smaller budget.
    const tight = renderThread(thread, 10) ?? "";
    expect(tight).toContain(omittedMarker(2));
    expect(tight.length).toBeGreaterThan(THREAD_CHAR_CAP / 2);
  });
});

describe("the ask tool in a run", () => {
  it("records the question and ends the run with no further model request", async () => {
    const calls: Array<{ question: string; callId: string }> = [];
    const receipt: AskReceipt = {
      taskId: TASK,
      column: "specifying",
      revision: 4,
    };
    const outcome = await runOnce({
      ask: {
        ask: (request) => {
          calls.push({ ...request });
          return Promise.resolve(receipt);
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toBe(QUESTION);
    expect(calls[0]?.callId).not.toBe("");
    // The `bash` turn and the ask: nothing after it, so nothing holds the run open.
    expect(outcome.requests).toBe(2);
    expect(outcome.busy).toBe(false);
    const result = outcome.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === ASK_TOOL,
    );
    expect(result?.text).toBe(describeAsk(receipt));
    expect(outcome.entries.at(-1)).toBe(result);
  }, 120_000);

  it("does not end a run whose question could not be recorded", async () => {
    const outcome = await runOnce({
      ask: {
        ask: () => Promise.reject(new Error("task is already blocked")),
      },
    });

    // The refusal is the model's to read, and the run goes on to a reply: a question nobody holds
    // must not park a run nobody will be told to answer.
    const result = outcome.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === ASK_TOOL,
    );
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("task is already blocked");
    expect(outcome.requests).toBe(3);
    expect(outcome.entries.at(-1)?.kind).toBe("assistant");
    expect(outcome.busy).toBe(false);
  }, 120_000);

  it("refuses an ask that shares its round, so the card is never blocked under a run that goes on", async () => {
    // Pi Durable ends a run only when every call of the round asks to: an `ask` beside a `bash`
    // would block the card and the run would make another request anyway. Scripted here: the
    // crowded round, then the model's retry with `ask` alone, then a reply nobody should reach.
    const calls: string[] = [];
    const faux = createFauxModelAccess({});
    const script = [
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "echo crowded" }),
          fauxToolCall(ASK_TOOL, { question: QUESTION }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall(ASK_TOOL, { question: QUESTION }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("kept going after the ask"),
    ];
    faux.faux.setResponses(script);
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          PostgresStorage.owner(sql, freshLogId()),
        );
        const { harness, root } = yield* openSession({
          storage,
          model: faux.access,
          cwd: workdir,
          ask: {
            ask: (request) => {
              calls.push(request.callId);
              return Promise.resolve({
                taskId: TASK,
                column: "specifying",
                revision: 3,
              });
            },
          },
        });
        const submitted = yield* submitMessage(root, { content: "go" });
        yield* Effect.promise(() =>
          submitted.submission.wait(BACKGROUND_CONTEXT),
        );
        const busy = yield* isBusy(harness, root);
        const log = yield* readSessionLog(storage);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return { busy, entries: log.entries };
      }),
    );

    const asks = outcome.entries.filter(
      (entry) => entry.kind === "toolResult" && entry.toolName === ASK_TOOL,
    );
    // The crowded ask recorded nothing and told the model why; the lone one parked the run.
    expect(asks).toHaveLength(2);
    expect(asks[0]?.isError).toBe(true);
    expect(asks[0]?.text).toContain(describeCrowdedAsk(2));
    expect(calls).toHaveLength(1);
    expect(asks[1]?.isError).toBeFalsy();
    // Two requests and no third: the run ended on the lone ask's result, not on a reply.
    expect(faux.faux.state.callCount).toBe(2);
    expect(outcome.entries.at(-1)).toBe(asks[1]);
    expect(outcome.busy).toBe(false);
  }, 120_000);

  it("is not offered to a session opened without an ask", async () => {
    const outcome = await runOnce({});
    expect(outcome.entries.some((entry) => entry.toolName === ASK_TOOL)).toBe(
      false,
    );
    expect(outcome.entries.at(-1)?.text).toBe("faux-ok (re: specify it)");
  }, 120_000);
});

describe("the thread in a run's prompt", () => {
  it("commits the thread as the task_thread section, so the next run is told the answer", async () => {
    const answer = "Postgres 16.\n  Keep port 5442 — it is shared.  ";
    const thread = [
      comment("question", "ses_run", QUESTION, 2),
      comment("answer", "person:lukas", answer, 4),
    ];
    let asked = 0;
    const outcome = await runOnce({
      thread,
      ask: {
        ask: () => {
          asked += 1;
          return Promise.resolve({
            taskId: TASK,
            column: "specifying",
            revision: 7,
          });
        },
      },
    });

    expect(outcome.sections[THREAD_SECTION_KEY]).toBe(
      `<${THREAD_SECTION_KEY}>\n${renderThread(thread) ?? ""}\n</${THREAD_SECTION_KEY}>`,
    );
    // Holding the thread, the scripted run does not ask again.
    expect(asked).toBe(0);
    expect(outcome.entries.at(-1)?.text).toBe("faux-ok (re: specify it)");
  }, 120_000);

  it("reads the thread before every request, so a live harness is told an answer that lands later", async () => {
    // The parked run's owner stays open; a person answers, then messages that same session.
    let thread: readonly TaskComment[] = [];
    const answer = "Postgres 16.";
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const faux = createFauxModelAccess({});
        const storage = yield* Effect.promise(() =>
          PostgresStorage.owner(sql, freshLogId()),
        );
        const { harness, root } = yield* openSession({
          storage,
          model: faux.access,
          cwd: workdir,
          thread: () => Promise.resolve(thread),
        });
        const send = (content: string) =>
          Effect.gen(function* () {
            const submitted = yield* submitMessage(root, { content });
            yield* Effect.promise(() =>
              submitted.submission.wait(BACKGROUND_CONTEXT),
            );
            return yield* readPromptSections(storage);
          });
        const before = yield* send("first");
        thread = [
          comment("question", "ses_run", QUESTION, 2),
          comment("answer", "person:lukas", answer, 4),
        ];
        const after = yield* send("go on");
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return { before, after };
      }),
    );

    expect(outcome.before[THREAD_SECTION_KEY]).toBeUndefined();
    expect(outcome.after[THREAD_SECTION_KEY]).toContain(`\n${answer}\n`);
  }, 120_000);

  it("carries no section for a run with no thread", async () => {
    const outcome = await runOnce({ thread: [] });
    expect(outcome.sections[THREAD_SECTION_KEY]).toBeUndefined();
  }, 120_000);
});
