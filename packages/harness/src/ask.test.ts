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
import type { TaskComment } from "@repo/domain/Task";
import { TaskId } from "@repo/domain/Task";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASK_TOOL,
  describeAsk,
  renderThread,
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
      const storage = yield* Effect.promise(() =>
        PostgresStorage.owner(sql, freshLogId()),
      );
      const { harness, root } = yield* openSession({
        storage,
        model: faux.access,
        cwd: workdir,
        ...(options.ask === undefined ? {} : { ask: options.ask }),
        ...(options.thread === undefined ? {} : { thread: options.thread }),
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

  it("carries no section for a run with no thread", async () => {
    const outcome = await runOnce({ thread: [] });
    expect(outcome.sections[THREAD_SECTION_KEY]).toBeUndefined();
  }, 120_000);
});
