/**
 * Compaction thresholds follow the model's context window (B4, LOB-185).
 *
 * `compactionPolicyFor` is pure, so the whole rule is a table here: no harness, no database, no
 * model. That the derived policy is what a session actually opens with — and that crossing the
 * threshold commits one summary and heads the context with it — is
 * `session.test.ts`'s "compaction" block, and the RPC path is `.pi/skills/verify-api`.
 */
import {
  Type,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  compactionPolicyFor,
  createModelAccess,
  fauxAnswer,
  isFauxTurnStep,
} from "./models";

/** pi-durable's pinned defaults, which a large window must keep to the token. */
const PINNED = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
};

describe("compactionPolicyFor", () => {
  it("returns the pinned defaults for the window the real model publishes", () => {
    const model = createModelAccess("anthropic");
    // pi-ai's catalog says a million tokens for the pinned Anthropic model; nothing about it
    // should need a smaller reserve than the package's own default.
    expect(model.contextWindow).toBe(1_000_000);
    expect(compactionPolicyFor(model.contextWindow)).toEqual(PINNED);
  });

  it("shrinks every threshold to a quarter of a small window and turns background off", () => {
    // A window whose pinned defaults would be larger than the window itself: with them, the
    // blocking threshold (window - 16384) is negative and nothing ever compacts.
    expect(compactionPolicyFor(8_000)).toEqual({
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: 2_000,
      backgroundTokens: 0,
    });
  });

  it("keeps background compaction where the window still has room for it", () => {
    // 32k: half the window is the answer reserve and the recent tail, so summarizing ahead of a
    // request has 16k to work in.
    expect(compactionPolicyFor(32_768)).toEqual({
      enabled: true,
      reserveTokens: 8_192,
      keepRecentTokens: 8_192,
      backgroundTokens: 0,
    });
    // 128k is pi-durable's own reference window: close to its defaults, never above them.
    expect(compactionPolicyFor(128_000)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_000,
    });
  });

  it("falls back to the pinned defaults when the catalog does not publish a window", () => {
    // 0 is "unknown", not "tiny": deriving from nothing would summarize everything on a manual
    // compact (a zero-token tail is always a cut).
    expect(compactionPolicyFor(0)).toEqual(PINNED);
  });
});

describe("createModelAccess", () => {
  it("publishes the window the model was registered with", () => {
    expect(createModelAccess("faux").contextWindow).toBe(128_000);
    expect(
      createModelAccess("faux", { contextWindow: 8_000 }).contextWindow,
    ).toBe(8_000);
  });
});

describe("the faux script's turns", () => {
  const user = (text: string): Message => ({
    role: "user",
    content: text,
    timestamp: 0,
  });
  const bashResult = (text: string): Message => ({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  });
  const callsBash = (message: AssistantMessage): boolean =>
    message.content.some((part) => part.type === "toolCall");

  // A second turn after a bash result: the stock script answers from it, `everyTurn` calls again.
  const secondTurn = [user("one"), bashResult("blocked"), user("two")];

  it("calls bash on a session's first turn only, by default", () => {
    expect(callsBash(fauxAnswer([user("one")], "echo x"))).toBe(true);
    expect(callsBash(fauxAnswer(secondTurn, "echo x"))).toBe(false);
  });

  it("calls bash on every turn with everyTurn, and answers once it ran", () => {
    expect(
      callsBash(
        fauxAnswer(secondTurn, "echo x", undefined, false, undefined, true),
      ),
    ).toBe(true);
    const answered = fauxAnswer(
      [...secondTurn, bashResult("ran")],
      "echo x",
      undefined,
      false,
      undefined,
      true,
    );
    expect(callsBash(answered)).toBe(false);
    expect(answered.content).toEqual([{ type: "text", text: "ran (re: two)" }]);
  });
});

describe("the faux script's spec (LOB-238)", () => {
  const offered = (sections?: Record<string, string>): Message => ({
    role: "system",
    content: "",
    toolsAdded: [
      { name: "spec", description: "", parameters: Type.Object({}) },
    ],
    ...(sections === undefined ? {} : { sections }),
    timestamp: 0,
  });
  const user: Message = { role: "user", content: "specify", timestamp: 0 };
  const result = (toolName: string, isError: boolean): Message => ({
    role: "toolResult",
    toolCallId: `call_${toolName}`,
    toolName,
    content: [{ type: "text", text: isError ? "refused" : "ran" }],
    isError,
    timestamp: 0,
  });
  const first = { goal: "g", acceptance: [], openQuestions: [] };
  const second = { ...first, gaps: ["which major"], openQuestions: ["q?"] };
  /** The arguments of the spec call an answer makes, or `undefined` when it makes none. */
  const specCall = (messages: readonly Message[]) => {
    const answer = fauxAnswer(
      messages,
      "echo x",
      undefined,
      false,
      undefined,
      false,
      [first, second],
    );
    const call = answer.content.find((part) => part.type === "toolCall");
    return call?.name === "spec" ? call.arguments : undefined;
  };
  const ran = [offered(), user, result("bash", false)];

  it("tries the attempts in order, one per refusal, and stops once one is accepted", () => {
    expect(specCall(ran)).toEqual(first);
    expect(specCall([...ran, result("spec", true)])).toEqual(second);
    expect(
      specCall([...ran, result("spec", true), result("spec", false)]),
    ).toBeUndefined();
    // Out of attempts: the script replies rather than calling forever.
    expect(
      specCall([...ran, result("spec", true), result("spec", true)]),
    ).toBeUndefined();
  });

  it("does not spec when the run was not offered the tool, or before its bash turn", () => {
    expect(specCall([user, result("bash", false)])).toBeUndefined();
    expect(specCall([offered(), user])).toBeUndefined();
  });

  it("declares the last attempt with its gaps closed once the thread is in the prompt", () => {
    const answered = [
      offered({ task_thread: "<task_thread>…</task_thread>" }),
      user,
      result("bash", false),
    ];
    expect(specCall(answered)).toEqual({
      ...second,
      gaps: [],
      openQuestions: [],
    });
    expect(specCall([...answered, result("spec", true)])).toBeUndefined();
  });
});

describe("the sleeping faux script", () => {
  const user = (text: string): Message => ({
    role: "user",
    content: text,
    timestamp: 0,
  });
  const ask = (
    access: ReturnType<typeof createModelAccess>,
    text: string,
    signal?: AbortSignal,
  ) => {
    const model = access.models.getModel(access.provider, access.modelId);
    if (model === undefined) throw new Error("the faux model is not served");
    return access.models.completeSimple(
      model,
      { messages: [{ role: "user", content: text, timestamp: 0 }] },
      signal === undefined ? undefined : { signal },
    );
  };
  const timed = async <A>(work: () => Promise<A>) => {
    const started = performance.now();
    const value = await work();
    return { value, ms: performance.now() - started };
  };

  it("naps before a turn's step, and still takes the step", async () => {
    const sleeping = createModelAccess("faux", { fauxSleepMs: 400 });
    const { value, ms } = await timed(() => ask(sleeping, "take your time"));
    expect(ms).toBeGreaterThanOrEqual(390);
    // The nap delays the script; it does not replace it: the first step still calls bash.
    expect(value.stopReason).toBe("toolUse");
    expect(value.content.some((part) => part.type === "toolCall")).toBe(true);
  });

  it("answers at once without fauxSleepMs", async () => {
    const { ms } = await timed(() =>
      ask(createModelAccess("faux"), "be quick"),
    );
    expect(ms).toBeLessThan(390);
  });

  it("stops napping when the request is aborted", async () => {
    // A nap the test could never wait out: only the abort can end it inside the test's timeout.
    const sleeping = createModelAccess("faux", { fauxSleepMs: 600_000 });
    const { value, ms } = await timed(() =>
      ask(sleeping, "never mind", AbortSignal.timeout(50)),
    );
    expect(value.stopReason).toBe("aborted");
    expect(ms).toBeLessThan(5_000);
  }, 10_000);

  it("does not nap over a compaction's summary or a curation", async () => {
    const sleeping = createModelAccess("faux", { fauxSleepMs: 600_000 });
    const summary = await timed(() =>
      ask(sleeping, "<conversation>user: hi</conversation>"),
    );
    expect(summary.ms).toBeLessThan(5_000);
    expect(summary.value.stopReason).toBe("stop");
    const curation = await timed(() => ask(sleeping, "<curate>nothing ran"));
    expect(curation.ms).toBeLessThan(5_000);
    expect(isFauxTurnStep([user("<curate>x")])).toBe(false);
    expect(isFauxTurnStep([user("  <conversation>x")])).toBe(false);
    expect(isFauxTurnStep([user("fix the bug")])).toBe(true);
  }, 10_000);
});
