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
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  Harness as HarnessRuntime,
  hook,
  ToolTask,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Page as CitedPage } from "@repo/domain/Page";
import {
  SessionId as SessionIdSchema,
  type PrEvidence,
} from "@repo/domain/Session";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, Exit, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelAccess } from "./models";
import { autonomyPolicy, DEFAULT_AUTONOMY, policyExtension } from "./policy";
import {
  diffView,
  inheritedPrText,
  projectView,
  usageCostTotal,
} from "./projection";
import { PAGES_TOKEN_CAP } from "./pages";
import {
  attempt,
  closeHarness,
  forkSession,
  isBusy,
  openSession,
  readHistoricalSnapshot,
  readLiveSnapshot,
  readPagePrompt,
  readPromptSections,
  readPage,
  readPullRequestDoc,
  readSessionLog,
  readSpec,
  resetSession,
  SESSION_PROGRESS,
  submitMessage,
  writeApprovalDecided,
  writeApprovalRequested,
  writePage,
  writePullRequestDoc,
  writeSpec,
  type OpenSession,
  type SessionRef,
} from "./session";
import { SpecRefused } from "./spec";

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
        const before = yield* readLiveSnapshot({ harness, root }, ref);
        expect(before.entries.map((entry) => entry.kind)).toContain("user");

        yield* resetSession(root, handoff);

        // What the model sees: the handoff, and nothing from before it.
        const opened = yield* Effect.promise(() => root.context(context));
        expect(messageTexts(opened.messages)).toEqual([handoff]);

        // What a reader sees: the whole transcript, with the reset marked where it happened.
        const after = yield* readLiveSnapshot({ harness, root }, ref);
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
        const after = yield* readLiveSnapshot({ harness, root }, ref);
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
 * A window whose derived thresholds a test can actually reach: 8000 tokens leaves 2000 for the
 * answer, so a context past 6000 blocks and compacts before its next request. The default faux
 * window (128k) would need a sixty-thousand-token transcript to prove the same thing.
 */
const smallWindow = createModelAccess("faux", { contextWindow: 8_000 });

/**
 * LOB-185: a session compacts on a policy (B4), and the policy is the model's window.
 *
 * Mutation checked: opening the session without `compactionPolicyFor` reverts to pi-durable's
 * pinned defaults, which keep 20k tokens verbatim — more than this whole transcript — so range
 * selection finds no cut, no summary is committed, and the first case's head assertion goes red
 * (`expected undefined to be 'pi.compaction'`). The second case is the other half of the same rule:
 * a session that stays under the threshold must not summarize anything, so a policy that compacts
 * on every turn fails it.
 */
describe("compaction", () => {
  it("compacts once past the model's threshold and heads the context with the summary", async () => {
    const compactLog = `${logId}-threshold`;
    const storage = await openStorage(compactLog);

    const live = await runtime.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage,
          model: smallWindow,
          cwd: workdir,
        });
        const first = yield* submitMessage(root, {
          content: "the turn before the threshold",
          requestId: "compact-before",
        });
        yield* Effect.promise(() => first.submission.wait(context));

        // One long message crosses the threshold. The *next* request is what compacts: it blocks
        // on the summarizer, then goes out from the summary.
        const crossing = yield* submitMessage(root, {
          content: "x".repeat(40_000),
          requestId: "compact-crossing",
        });
        const settled = yield* Effect.promise(() =>
          crossing.submission.wait(context),
        );
        expect(settled.status).toBe("done");

        // What the model sees: a context that starts at the summary entry.
        const opened = yield* Effect.promise(() => root.context(context));
        // What a reader sees: the transcript, summary included.
        const snapshot = yield* readLiveSnapshot({ harness, root }, ref);
        yield* closeHarness(harness);
        return { head: opened.head?.kind, entries: snapshot.entries };
      }),
    );

    expect(live.head).toBe("pi.compaction");

    // A head marker is committed state, so a reopen has to find it again instead of folding a
    // transcript whose model context starts at the beginning (the point of D8's head marker).
    const reopenedHead = await runtime.runPromise(
      Effect.gen(function* () {
        const reopened = yield* openSession({
          storage: yield* Effect.promise(() => openStorage(compactLog)),
          model: smallWindow,
          cwd: workdir,
        });
        const opened = yield* Effect.promise(() =>
          reopened.root.context(context),
        );
        yield* closeHarness(reopened.harness);
        return opened.head?.kind;
      }),
    );
    expect(reopenedHead).toBe("pi.compaction");
    const summaries = live.entries.filter(
      (entry) => entry.kind === "compaction",
    );
    // One crossing, one summary: a policy that compacted on every turn would leave more.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.text).toContain("summary");
    // The transcript keeps everything the summary stands in for, which is what makes it checkable.
    expect(
      live.entries.some(
        (entry) => entry.text === "the turn before the threshold",
      ),
    ).toBe(true);

    // The fold is the other read path (D8) and must not disagree, summary included.
    const folded = await runtime.runPromise(
      readSessionLog(await openStorage(compactLog)),
    );
    expect(folded.entries).toEqual(live.entries);
  }, 120_000);

  it("commits no compaction entry while the context stays under the threshold", async () => {
    const storage = await openStorage(`${logId}-under-threshold`);
    const entries = await runtime.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage,
          model: smallWindow,
          cwd: workdir,
        });
        // Two ordinary turns are a thousand tokens: nowhere near the blocking threshold, so
        // nothing may be summarized away from the model.
        for (const [index, content] of ["one", "two"].entries()) {
          const submitted = yield* submitMessage(root, {
            content,
            requestId: `under-threshold-${index}`,
          });
          const settled = yield* Effect.promise(() =>
            submitted.submission.wait(context),
          );
          expect(settled.status).toBe("done");
        }
        const snapshot = yield* readLiveSnapshot({ harness, root }, ref);
        yield* closeHarness(harness);
        return snapshot.entries;
      }),
    );

    expect(entries.some((entry) => entry.kind === "compaction")).toBe(false);
    expect(entries.filter((entry) => entry.kind === "user")).toHaveLength(2);
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

/**
 * A log per case: the page-prompt record is session state, so two cases sharing one log would read
 * each other's record — and a case that asks "no record" would find its neighbour's.
 */
const openPagesStorage = (logId: string, mode: "owner" | "reader") =>
  PostgresStorage.open(sql, { logId, mode }, context);

/**
 * The knowledge a session carries reaches its prompt (LOB-205, part 2 of LOB-47).
 *
 * The control plane reads a session's pages and hands them to `openSession`; this suite is what
 * proves the hand-off becomes the prompt and the record, and that a session with no pages gets
 * neither. The cap's arithmetic is `pages.test.ts`'s; here it is the committed `pi.system` entry and
 * the page-prompt document that are read, because those are the two things a person can check after
 * a run.
 */
describe("the pages a session carries", () => {
  /** A page as the domain holds it: content, its citations, and the links it points at. */
  const page = (name: string, content: string): CitedPage => ({
    name,
    kind: "trap",
    content,
    links: [],
    sources: ["ses_0000000000aaaaaa"],
  });

  it("commits the section it was given, exactly, and records what it cost", async () => {
    const logId = `harness-pages-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openPagesStorage(logId, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
          pages: [
            page("a-the-log-is-the-truth", "the log is the truth"),
            page("b-batch-the-fold", "a batch delete clobbers a sibling"),
          ],
        });
        const submitted = yield* submitMessage(root, { content: "begin" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const sections = yield* readPromptSections(storage);
        const record = yield* readPagePrompt(harness, root);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return { sections, record };
      }),
    );

    // The exact text the model was sent, from the log rather than from the extension that built it:
    // the two pages, their kinds, and their citation.
    expect(outcome.sections["pages"]).toBe(
      [
        "<pages>",
        "## a-the-log-is-the-truth (trap)",
        "the log is the truth",
        "sources: ses_0000000000aaaaaa",
        "",
        "## b-batch-the-fold (trap)",
        "a batch delete clobbers a sibling",
        "sources: ses_0000000000aaaaaa",
        "</pages>",
      ].join("\n"),
    );
    // And what it came to: the budget, the cost, the pages carried, and none dropped.
    expect(outcome.record).toEqual({
      cap: PAGES_TOKEN_CAP,
      tokens: estimateTextTokens(outcome.sections["pages"] ?? ""),
      held: 2,
      included: ["a-the-log-is-the-truth", "b-batch-the-fold"],
      dropped: [],
    });
  }, 120_000);

  it("keeps the section inside the budget and records the pages it dropped", async () => {
    const bulky = (tag: string): string => `${tag} `.repeat(300).trim();
    const logId = `harness-pages-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openPagesStorage(logId, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
          pages: [
            page("a-old-note", bulky("old")),
            page("b-new-note", bulky("new")),
          ],
        });
        const submitted = yield* submitMessage(root, { content: "begin" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const sections = yield* readPromptSections(storage);
        const record = yield* readPagePrompt(harness, root);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return { sections, record };
      }),
    );

    const section = outcome.sections["pages"] ?? "";
    // Inside the budget it was assembled under, and the page it could not hold is named rather than
    // silently missing: the record is the answer to "what did this run not receive".
    expect(estimateTextTokens(section)).toBeLessThanOrEqual(PAGES_TOKEN_CAP);
    expect(outcome.record?.held).toBe(2);
    expect(outcome.record?.included).toEqual(["a-old-note"]);
    expect(outcome.record?.dropped).toEqual(["b-new-note"]);
    expect(outcome.record?.tokens).toBe(estimateTextTokens(section));
    expect(section).not.toContain("b-new-note");
  }, 120_000);

  it("renders no pages section, and writes no record, when the session has no pages", async () => {
    const logId = `harness-pages-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openPagesStorage(logId, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const submitted = yield* submitMessage(root, { content: "begin" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const sections = yield* readPromptSections(storage);
        const record = yield* readPagePrompt(harness, root);
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return { sections, record };
      }),
    );

    // No `pages` section at all — not an empty one — and a record that says the session held none,
    // rather than a missing record a later reader would have to interpret.
    expect(outcome.sections["pages"]).toBeUndefined();
    expect(Object.keys(outcome.sections)).toEqual([]);
    expect(outcome.record).toEqual({
      cap: PAGES_TOKEN_CAP,
      tokens: 0,
      held: 0,
      included: [],
      dropped: [],
    });
  }, 120_000);

  it("records the absence when a session that was told pages no longer holds any", async () => {
    const logId = `harness-pages-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const toldStorage = yield* Effect.promise(() =>
          openPagesStorage(logId, "owner"),
        );
        const told = yield* openSession({
          storage: toldStorage,
          model,
          cwd: workdir,
          pages: [page("a-note", "a note the session was told")],
        });
        const submitted = yield* submitMessage(told.root, { content: "begin" });
        yield* Effect.promise(() => submitted.submission.wait(context));
        const first = yield* readPagePrompt(told.harness, told.root);
        yield* closeHarness(told.harness);
        yield* Effect.promise(() => toldStorage.dispose());
        // The pages are gone (a page deleted from the projection, say), so the next open holds none.
        const bareStorage = yield* Effect.promise(() =>
          openPagesStorage(logId, "owner"),
        );
        const bare = yield* openSession({
          storage: bareStorage,
          model,
          cwd: workdir,
        });
        const second = yield* readPagePrompt(bare.harness, bare.root);
        const submittedBare = yield* submitMessage(bare.root, {
          content: "begin",
        });
        yield* Effect.promise(() => submittedBare.submission.wait(context));
        const sectionsAfter = yield* readPromptSections(bareStorage);
        yield* closeHarness(bare.harness);
        yield* Effect.promise(() => bareStorage.dispose());
        return { first, second, sectionsAfter };
      }),
    );

    expect(outcome.first?.included).toEqual(["a-note"]);
    // And the section is gone with the pages: the next open's request carries none, so a session
    // cannot keep reading knowledge its projection no longer holds.
    expect(outcome.sectionsAfter["pages"]).toBeUndefined();
    // The record is the latest answer, not the last one that had something to say: a stale record
    // claiming pages the open did not send would be worse than no record.
    expect(outcome.second).toEqual({
      cap: PAGES_TOKEN_CAP,
      tokens: 0,
      held: 0,
      included: [],
      dropped: [],
    });
  }, 120_000);
});

const prLogId = `harness-pr-test-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;
const pageLogId = `harness-page-test-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

const openPrStorage = (mode: "owner" | "reader") =>
  PostgresStorage.open(sql, { logId: prLogId, mode }, context);

describe("the PR a session opened", () => {
  it("commits one link, emits one prOpened, and folds the link back", async () => {
    const opened = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => openPrStorage("owner"));
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const before = yield* Effect.promise(() => root.viewState(context));
        const beforeValue = before.value;
        before.dispose();
        // No PR until the step commits one: the document's initial URL is the empty string.
        const unpublished = yield* readPullRequestDoc(harness, root);

        const url = "https://github.com/lobiklukas/factory/pull/7";
        yield* writePullRequestDoc(root, {
          url,
          number: 7,
          base: "main",
          head: "factory/ses_1",
          openedAt: "2026-10-24T17:00:00.000Z",
        });

        const after = yield* Effect.promise(() => root.viewState(context));
        const afterValue = after.value;
        after.dispose();
        const recorded = yield* readPullRequestDoc(harness, root);
        yield* closeHarness(harness);
        return {
          unpublished,
          recorded,
          opened: diffView(beforeValue, afterValue),
          // A second diff of the same revision is nobody's opening: an attached client sees the
          // event once, not once per read.
          again: diffView(afterValue, afterValue),
        };
      }),
    );

    expect(opened.unpublished).toBeUndefined();
    expect(opened.recorded).toEqual({
      url: "https://github.com/lobiklukas/factory/pull/7",
      number: 7,
      base: "main",
      head: "factory/ses_1",
      openedAt: "2026-10-24T17:00:00.000Z",
    });
    // Exactly one, by count: the emit is a single event, not one per attached reader.
    expect(opened.opened.filter((event) => event._tag === "prOpened")).toEqual([
      {
        _tag: "prOpened",
        prUrl: "https://github.com/lobiklukas/factory/pull/7",
      },
    ]);
    expect(opened.again.filter((event) => event._tag === "prOpened")).toEqual(
      [],
    );

    // The link is in the log, not only in the view: a reader folds it back.
    const reader = await openPrStorage("reader");
    const folded = await runtime.runPromise(readSessionLog(reader));
    await reader.dispose();
    expect(folded.pr?.url).toBe("https://github.com/lobiklukas/factory/pull/7");
    expect(folded.pr?.number).toBe(7);
  }, 120_000);

  /**
   * The evidence the body states (LOB-79) is the PR's record too: committed on the document a later
   * reader (a column's `requires[]` check) reads, on the entry an attached client sees, and folded
   * back from the log by a reader that owns nothing.
   */
  it("attaches the evidence to the document, the prOpened event and the fold", async () => {
    const evidenceLogId = `${prLogId}-evidence`;
    const evidence: PrEvidence = {
      _tag: "EvidenceRecorded",
      calls: 1,
      changedCount: 1,
      results: [
        {
          _tag: "VerificationRan",
          surface: "api",
          name: "verify-api",
          source: "skill",
          command: "bash drive.sh",
          exitCode: 0,
          excerpt: "3/3 checks passed\n",
          truncated: false,
        },
      ],
    };
    const url = "https://github.com/lobiklukas/factory/pull/8";
    const opened = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          PostgresStorage.open(
            sql,
            { logId: evidenceLogId, mode: "owner" },
            context,
          ),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const before = yield* Effect.promise(() => root.viewState(context));
        const beforeValue = before.value;
        before.dispose();
        yield* writePullRequestDoc(root, {
          url,
          number: 8,
          base: "main",
          head: "factory/ses_2",
          openedAt: "2026-10-27T17:00:00.000Z",
          evidence,
        });
        const after = yield* Effect.promise(() => root.viewState(context));
        const afterValue = after.value;
        after.dispose();
        const recorded = yield* readPullRequestDoc(harness, root);
        yield* closeHarness(harness);
        return { recorded, events: diffView(beforeValue, afterValue) };
      }),
    );

    expect(opened.recorded?.evidence).toEqual(evidence);
    expect(opened.events.filter((event) => event._tag === "prOpened")).toEqual([
      { _tag: "prOpened", prUrl: url, evidence },
    ]);
    const reader = await PostgresStorage.open(
      sql,
      { logId: evidenceLogId, mode: "reader" },
      context,
    );
    const folded = await runtime.runPromise(readSessionLog(reader));
    await reader.dispose();
    expect(folded.pr?.evidence).toEqual(evidence);
  }, 120_000);

  /**
   * A fork does not inherit its parent's PR (LOB-211): it runs on a branch of its own, so the
   * parent's `factory.pr` is not its record and the parent's announcement must not reach a client
   * attached to it. The two answers a fork gives about its PR — the fold's `pr` and the `prOpened`
   * events its transcript yields to an attach — have to agree, before and after it opens its own.
   *
   * The events are what an attach with nothing sent yet would be told: `diffView` over the fork's
   * own view with an empty `sent` set, which is every entry in it.
   */
  it("forks without the parent's PR, and announces only the fork's own", async () => {
    const parentLog = `${prLogId}-fork-parent`;
    const childLog = `${prLogId}-fork-child`;
    const parentUrl = "https://github.com/lobiklukas/factory/pull/9";
    const forkUrl = "https://github.com/lobiklukas/factory/pull/10";
    const owner = (id: string) =>
      PostgresStorage.open(sql, { logId: id, mode: "owner" }, context);
    const reader = (id: string) =>
      PostgresStorage.open(sql, { logId: id, mode: "reader" }, context);
    const fold = (id: string) =>
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => reader(id));
        const log = yield* readSessionLog(storage);
        yield* Effect.promise(() => storage.dispose());
        return log;
      });
    const announced = (root: OpenSession["root"]) =>
      Effect.gen(function* () {
        const state = yield* Effect.promise(() => root.viewState(context));
        const view = state.value;
        state.dispose();
        return diffView(view, view, new Set()).filter(
          (event) => event._tag === "prOpened",
        );
      });

    const parent = await runtime.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage: yield* Effect.promise(() => owner(parentLog)),
          model,
          cwd: workdir,
        });
        const turn = yield* submitMessage(root, {
          content: "before the PR",
          requestId: "before the PR",
        });
        yield* Effect.promise(() => turn.submission.wait(context));
        yield* writePullRequestDoc(root, {
          url: parentUrl,
          number: 9,
          base: "main",
          head: "factory/ses_parent",
          openedAt: "2026-10-27T18:00:00.000Z",
        });
        const events = yield* announced(root);
        yield* closeHarness(harness);
        return { events, log: yield* fold(parentLog) };
      }),
    );
    // The premise: the parent announces its PR and records it, so there is something to inherit.
    expect(parent.events).toEqual([{ _tag: "prOpened", prUrl: parentUrl }]);
    expect(parent.log.pr?.url).toBe(parentUrl);

    const forked = await runtime.runPromise(
      Effect.gen(function* () {
        const opened = yield* forkSession({
          parent: yield* Effect.promise(() => reader(parentLog)),
          child: yield* Effect.promise(() => owner(childLog)),
          lineage: parentLog,
          model,
          cwd: workdir,
        });
        const before = {
          record: yield* readPullRequestDoc(opened.harness, opened.root),
          events: yield* announced(opened.root),
          log: yield* fold(childLog),
        };
        yield* writePullRequestDoc(opened.root, {
          url: forkUrl,
          number: 10,
          base: "main",
          head: "factory/ses_fork",
          openedAt: "2026-10-27T18:05:00.000Z",
        });
        const after = {
          record: yield* readPullRequestDoc(opened.harness, opened.root),
          events: yield* announced(opened.root),
          log: yield* fold(childLog),
        };
        yield* closeHarness(opened.harness);
        return { before, after };
      }),
    );

    // Before its own PR, the fork has none in either answer: no record its PR step would read back
    // instead of opening one, no fold, and nothing an attached client is told.
    expect(forked.before.record).toBeUndefined();
    expect(forked.before.log.pr).toBeUndefined();
    expect(forked.before.events).toEqual([]);
    // The transcript is still the parent's entry for entry, the PR line kept as whose it was.
    expect(forked.before.log.entries.map((entry) => entry.text)).toEqual(
      parent.log.entries.map((entry) =>
        entry.kind === "other" && entry.text === ""
          ? inheritedPrText(parentUrl)
          : entry.text,
      ),
    );
    expect(forked.before.log.entries).toContainEqual(
      expect.objectContaining({ text: inheritedPrText(parentUrl) }),
    );

    // After it opens its own, both answers name that one PR, and only that one: one `prOpened`, not
    // the parent's beside it.
    expect(forked.after.record?.url).toBe(forkUrl);
    expect(forked.after.log.pr?.url).toBe(forkUrl);
    expect(forked.after.events).toEqual([{ _tag: "prOpened", prUrl: forkUrl }]);
  }, 120_000);
});

const approvalLogId = `harness-approvals-test-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

const openApprovalStorage = (mode: "owner" | "reader") =>
  PostgresStorage.open(sql, { logId: approvalLogId, mode }, context);

describe("the approval fold", () => {
  /**
   * LOB-147. The service writes one request and one decision per approval; a log can still hold
   * two requests for one id (a writer killed between its commit and its index write, a retried
   * session), so the fold — not the writer — is what makes the id the identity. Both the pending
   * list a snapshot reports and the `session_approvals` rows a rebuild derives come from here.
   */
  it("folds one record per request id, and reports only the pending ones", async () => {
    const folded = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openApprovalStorage("owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        // The same id twice: the first request is the record, the second changes nothing.
        yield* writeApprovalRequested(root, {
          requestId: "apr-1",
          action: "push refs/heads/main",
          detail: "the first ask",
          requestedAt: "2026-01-01T00:00:01.000Z",
        });
        yield* writeApprovalRequested(root, {
          requestId: "apr-1",
          action: "push refs/heads/main",
          detail: "a retry of the same ask",
          requestedAt: "2026-01-01T00:00:09.000Z",
        });
        // A second request, settled: it is in the log and not in the pending list.
        yield* writeApprovalRequested(root, {
          requestId: "apr-2",
          action: "watch",
          detail: "",
          requestedAt: "2026-01-01T00:00:02.000Z",
        });
        yield* writeApprovalDecided(root, {
          requestId: "apr-2",
          decision: "denied",
          actor: "lukas@laptop",
          decidedAt: "2026-01-01T00:00:03.000Z",
        });
        yield* closeHarness(harness);
        yield* Effect.promise(() => storage.dispose());
        return approvalLogId;
      }),
    );

    const reader = await openApprovalStorage("reader");
    const log = await runtime.runPromise(readSessionLog(reader));
    const refForApprovals: SessionRef = {
      ...ref,
      id: SessionIdSchema.make(`ses_${"1".repeat(26)}`),
    };
    const snapshot = await runtime.runPromise(
      readHistoricalSnapshot(reader, refForApprovals),
    );
    // Folded twice: the same log yields the same records, so the fold is a function, not an
    // accumulator.
    const again = await runtime.runPromise(readSessionLog(reader));
    await reader.dispose();

    expect(log.approvals).toEqual([
      {
        requestId: "apr-1",
        action: "push refs/heads/main",
        detail: "the first ask",
        requestedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        requestId: "apr-2",
        action: "watch",
        detail: "",
        requestedAt: "2026-01-01T00:00:02.000Z",
        decision: {
          decision: "denied",
          actor: "lukas@laptop",
          decidedAt: "2026-01-01T00:00:03.000Z",
        },
      },
    ]);
    expect(again.approvals).toEqual(log.approvals);
    expect(folded).toBe(approvalLogId);
    // The snapshot carries the pending one, stamped with the session it belongs to.
    expect(snapshot.approvals).toEqual([
      {
        sessionId: refForApprovals.id,
        requestId: "apr-1",
        action: "push refs/heads/main",
        detail: "the first ask",
        requestedAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(snapshot.session.mode).toBe("historical");
  }, 120_000);
});

const openPageStorage = (mode: "owner" | "reader") =>
  PostgresStorage.open(sql, { logId: pageLogId, mode }, context);

/**
 * A cited knowledge page (LOB-204): the family document a reader asks for by name, and the entry a
 * fold can see. Both are one commit, and a reader of the log — not only of the live view — folds the
 * page back, which is what a rebuild relies on.
 */
describe("the cited pages a session recorded", () => {
  it("commits a page as a document and an entry, and both read back", async () => {
    const recorded = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() => openPageStorage("owner"));
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const unpublished = yield* readPage(harness, root, "a-trap");
        yield* writePage(root, {
          name: "a-trap",
          kind: "trap",
          content: "a per-batch delete clobbers another batch",
          links: ["a-decision"],
          sources: ["ses_1", "ses_nobody"],
        });
        const page = yield* readPage(harness, root, "a-trap");
        // A page nobody wrote is not a page, even though the family members are seeded on read.
        const missing = yield* readPage(harness, root, "never-written");
        yield* closeHarness(harness);
        const reader = yield* Effect.promise(() => openPageStorage("reader"));
        const folded = yield* readSessionLog(reader);
        yield* Effect.promise(() => reader.dispose());
        return { unpublished, page, missing, folded: folded.pages };
      }),
    );

    expect(recorded.unpublished).toBeUndefined();
    expect(recorded.missing).toBeUndefined();
    expect(recorded.page).toEqual({
      name: "a-trap",
      kind: "trap",
      content: "a per-batch delete clobbers another batch",
      links: ["a-decision"],
      sources: ["ses_1", "ses_nobody"],
    });
    // The entry, not the document, is what a fold reads — and it keeps the citation of a session
    // that does not exist.
    expect(recorded.folded).toEqual([recorded.page]);
  }, 120_000);
});

const usageLogId = `${logId}-usage`;

/**
 * A tool result's own spend, as a self-reporting tool would return it: an execution that calls a
 * model (a subagent, a summarizer) carries usage with no model identity of its own. No tool in
 * `CodingTools` reports any, so the probe below plays that role through Pi Durable's real
 * `afterTool` hook — the same seam the policy uses — which is what makes `pi.usage.tools` non-empty
 * in a real log rather than only in a hand-written JSON fixture.
 */
const TOOL_USAGE = {
  input: 1_200,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_500,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
};

const reportingToolUsage = defineExtension({
  name: "probe-tool-usage",
  hooks: [
    hook(ToolTask, {
      afterTool: (_call, result): ToolExecutionResult => ({
        ...result,
        usage: TOOL_USAGE,
      }),
    }),
  ],
});

/**
 * LOB-153: the spend ledger has two buckets and the session's numbers are both.
 *
 * `pi.usage` keys model spend `provider/modelId` and tool spend by tool name, and the projection
 * used to read only the first — so a session whose tools report spend attributed none of it, and
 * the list surface's total quietly left it out. The faux model's own cost is zero (pi-ai hard-codes
 * `cost.total = 0`), which is exactly why the probe reports a non-zero one: a zero-cost tool bucket
 * would let a broken projection pass.
 */
describe("the spend a session recorded", () => {
  it("attributes a tool's own usage to the tools bucket, live and folded", async () => {
    const recorded = await runtime.runPromise(
      Effect.gen(function* () {
        const faux = createModelAccess("faux");
        const storage = yield* Effect.promise(() =>
          PostgresStorage.open(
            sql,
            { logId: usageLogId, mode: "owner" },
            context,
          ),
        );
        // The harness `openSession` builds, plus the probe: the point is a real tool result whose
        // usage Pi Durable records, and `openSession` takes no extensions.
        const registry = createRegistry();
        registry.install(CodingTools);
        registry.install(reportingToolUsage);
        registry.install(
          policyExtension(autonomyPolicy(DEFAULT_AUTONOMY, workdir)),
        );
        const harness = yield* attempt("open harness", () =>
          HarnessRuntime.open(
            storage,
            {
              models: faux.models,
              registry,
              env: (target) =>
                new NodeExecutionEnv({ cwd: target.cwd ?? workdir }),
              settings: { progress: SESSION_PROGRESS },
            },
            BACKGROUND_CONTEXT,
          ),
        );
        const root = yield* attempt("open root conversation", () =>
          harness.root(BACKGROUND_CONTEXT, {
            agent: {
              model: { provider: faux.provider, modelId: faux.modelId },
              cwd: workdir,
            },
          }),
        );
        const submitted = yield* submitMessage(root, {
          content: "spend something",
          requestId: "tool-usage",
        });
        yield* Effect.promise(() => submitted.submission.wait(context));
        // The live read path first, while this process owns the log.
        const live = yield* readLiveSnapshot({ harness, root }, ref);
        yield* closeHarness(harness);
        // Then the fold, which is what a rebuild of the index reads.
        const reader = yield* Effect.promise(() =>
          PostgresStorage.open(
            sql,
            { logId: usageLogId, mode: "reader" },
            context,
          ),
        );
        const folded = yield* readSessionLog(reader);
        yield* Effect.promise(() => reader.dispose());
        return { live, folded };
      }),
    );

    // The tool's numbers are projected, keyed by tool name, not dropped for having no model.
    expect(recorded.folded.usage.tools).toEqual([
      {
        key: "bash",
        usage: {
          input: 1_200,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_500,
          costTotal: 0.02,
        },
      },
    ]);
    // The model's own spend is still there: one bucket does not replace the other.
    expect(recorded.folded.usage.models.length).toBeGreaterThan(0);
    expect(recorded.folded.usage.models[0]?.key).toContain("faux/");
    // Two read paths, one ledger: the snapshot's usage is the fold's usage.
    expect(recorded.live.usage).toEqual(recorded.folded.usage);
    // The total the list shows is both buckets, which is the number a rebuild has to reproduce.
    expect(usageCostTotal(recorded.folded.usage)).toBeCloseTo(0.02);
  }, 120_000);
});

const specLogId = `${logId}-spec`;

const openSpecStorage = (id: string, mode: "owner" | "reader") =>
  PostgresStorage.open(sql, { logId: id, mode }, context);

/** A complete card's spec: nothing missing, so nothing to ask — both said as `[]`. */
const COMPLETE_SPEC = {
  goal: "the specifying stage's artifact is typed",
  acceptance: [
    "a spec with gaps: [] round-trips",
    "a spec missing gaps is refused",
  ],
  gaps: [],
  openQuestions: [],
};

/**
 * LOB-72, part 1 of LOB-46. B4's `specifying` exit is "a `spec` doc, gaps declared (explicitly `[]`
 * when there are none)", so the document is typed and the rule is checked at the write, not
 * promised by the writer.
 */
describe("the spec a session declared", () => {
  it("round-trips a spec with gaps: [] and reads the same content after a reopen", async () => {
    const written = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openSpecStorage(specLogId, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        // Never specified: the seed is not a spec, so this is "no spec", not "no gaps".
        const before = yield* readSpec(harness, root);
        const committed = yield* writeSpec(root, COMPLETE_SPEC);
        const live = yield* readSpec(harness, root);
        yield* closeHarness(harness);
        return { before, committed, live };
      }),
    );
    expect(written.before).toBeUndefined();
    expect(written.committed).toEqual(COMPLETE_SPEC);
    expect(written.live).toEqual(COMPLETE_SPEC);

    // A fresh harness over the same log: the content is the log's, not the first process's memory.
    const reopened = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openSpecStorage(specLogId, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        const spec = yield* readSpec(harness, root);
        yield* closeHarness(harness);
        return spec;
      }),
    );
    expect(reopened).toEqual(COMPLETE_SPEC);
    // `[]` survives as `[]`: an empty declaration is a value, not a field the round trip dropped.
    expect(reopened?.gaps).toEqual([]);
    expect(reopened?.openQuestions).toEqual([]);

    // And the read-only fold the control plane uses for a session it does not own says the same.
    const reader = await openSpecStorage(specLogId, "reader");
    const folded = await runtime.runPromise(readSessionLog(reader));
    await reader.dispose();
    expect(folded.spec).toEqual(COMPLETE_SPEC);
  }, 120_000);

  it("refuses a spec with no gaps field, naming it, and commits nothing", async () => {
    const id = `${specLogId}-refused`;
    const { withoutGaps, nullGaps, emptyGaps, untouched, kept } =
      await runtime.runPromise(
        Effect.gen(function* () {
          const storage = yield* Effect.promise(() =>
            openSpecStorage(id, "owner"),
          );
          const { harness, root } = yield* openSession({
            storage,
            model,
            cwd: workdir,
          });
          const { gaps: _gaps, ...noGaps } = COMPLETE_SPEC;
          // Flipped, so a write that wrongly succeeds fails the test rather than passing as a value.
          const withoutGaps = yield* Effect.flip(writeSpec(root, noGaps));
          // Refused at the write: the log still holds no spec at all.
          const untouched = yield* readSpec(harness, root);
          const nullGaps = yield* Effect.flip(
            writeSpec(root, { ...COMPLETE_SPEC, gaps: null }),
          );
          const emptyGaps = yield* Effect.exit(
            writeSpec(root, { ...COMPLETE_SPEC, gaps: [] }),
          );
          // A later refusal leaves the accepted spec standing rather than erasing it.
          yield* Effect.flip(writeSpec(root, noGaps));
          const kept = yield* readSpec(harness, root);
          yield* closeHarness(harness);
          return { withoutGaps, nullGaps, emptyGaps, untouched, kept };
        }),
      );

    // Absent: a typed refusal that names the field and says it is missing.
    expect(withoutGaps).toBeInstanceOf(SpecRefused);
    expect(withoutGaps).toMatchObject({
      _tag: "SpecRefused",
      field: "gaps",
      reason: "missing",
    });
    expect(withoutGaps.message).toContain("`gaps` is missing");
    expect(untouched).toBeUndefined();
    // Present but not a list: the same field, a different reason — so absent is its own answer.
    expect(nullGaps).toMatchObject({
      _tag: "SpecRefused",
      field: "gaps",
      reason: "invalid",
    });
    // `[]` is the declaration of none, and it is accepted.
    expect(Exit.isSuccess(emptyGaps)).toBe(true);
    expect(kept).toEqual(COMPLETE_SPEC);

    const reader = await openSpecStorage(id, "reader");
    const folded = await runtime.runPromise(readSessionLog(reader));
    await reader.dispose();
    expect(folded.spec).toEqual(COMPLETE_SPEC);
  }, 120_000);

  it("rewrites every field, so a withdrawn gap does not survive the next spec", async () => {
    const id = `${specLogId}-rewrite`;
    const thin = {
      goal: "add the board view",
      acceptance: [],
      gaps: ["the card names no acceptance criteria"],
      openQuestions: ["what must the board show to be done?"],
    };
    const { first, second } = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openSpecStorage(id, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage,
          model,
          cwd: workdir,
        });
        yield* writeSpec(root, thin);
        const first = yield* readSpec(harness, root);
        yield* writeSpec(root, COMPLETE_SPEC);
        const second = yield* readSpec(harness, root);
        yield* closeHarness(harness);
        return { first, second };
      }),
    );
    expect(first).toEqual(thin);
    expect(second).toEqual(COMPLETE_SPEC);
  }, 120_000);

  it("reads a version-1 spec as no spec, not as one declaring no gaps", async () => {
    const id = `${specLogId}-v1`;
    // The shape `factory.spec` had before LOB-72: one string, and no gaps anywhere in it.
    const SpecDocV1 = defineDoc({
      kind: "factory.spec",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "current",
      initial: () => ({ spec: "" }),
    });
    const storage = await openSpecStorage(id, "owner");
    const v1 = await HarnessRuntime.open(
      storage,
      { models: model.models, registry: createRegistry() },
      context,
    );
    const v1Root = await v1.root(context, {
      agent: {
        model: { provider: model.provider, modelId: model.modelId },
        cwd: workdir,
      },
    });
    await v1Root.commit(
      (tx) =>
        tx.doc(SpecDocV1, v1Root.id).then((doc) => {
          doc.spec = "a v1 spec";
        }),
      context,
    );
    await v1.close(context);

    const read = await runtime.runPromise(
      Effect.gen(function* () {
        const reopened = yield* Effect.promise(() =>
          openSpecStorage(id, "owner"),
        );
        const { harness, root } = yield* openSession({
          storage: reopened,
          model,
          cwd: workdir,
        });
        const spec = yield* readSpec(harness, root);
        yield* closeHarness(harness);
        return spec;
      }),
    );
    expect(read).toBeUndefined();

    const reader = await openSpecStorage(id, "reader");
    const folded = await runtime.runPromise(readSessionLog(reader));
    await reader.dispose();
    expect(folded.spec).toBeUndefined();
  }, 120_000);
});
