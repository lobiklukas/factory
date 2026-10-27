/**
 * Compaction thresholds follow the model's context window (B4, LOB-185).
 *
 * `compactionPolicyFor` is pure, so the whole rule is a table here: no harness, no database, no
 * model. That the derived policy is what a session actually opens with — and that crossing the
 * threshold commits one summary and heads the context with it — is
 * `session.test.ts`'s "compaction" block, and the RPC path is `.pi/skills/verify-api`.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  compactionPolicyFor,
  createModelAccess,
  fauxAnswer,
  isFauxTurnStep,
  parseFauxModelScripts,
} from "./models";
import { VERIFY_TOOL } from "./verify";

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

/**
 * A script per faux model (LOB-86): the builder role's model writes and verifies, every other model
 * keeps the process's script. `.pi/skills/verify-board/drive.sh`'s build phase is the end-to-end
 * proof; these cases pin which model gets which step.
 */
describe("a faux model's own script", () => {
  const access = createModelAccess("faux", {
    fauxCommand: "sleep 8; echo faux-ok",
    fauxModels: ["faux-1", "builder"],
    fauxModelScripts: new Map([
      ["builder", { command: "git commit -am build", verify: true }],
    ]),
  });
  const turn = (modelId: string, messages: Message[]) => {
    const model = access.models.getModel("faux", modelId);
    if (model === undefined) throw new Error(`faux does not serve ${modelId}`);
    return access.models.completeSimple(model, { messages });
  };
  const toolCall = (message: AssistantMessage) =>
    message.content.flatMap((part) =>
      part.type === "toolCall"
        ? [{ name: part.name, arguments: part.arguments }]
        : [],
    );
  const user: Message = { role: "user", content: "go", timestamp: 0 };
  const bashResult: Message = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text: "built" }],
    isError: false,
    timestamp: 0,
  };

  it("runs the model's command under that model, and the process's under any other", async () => {
    expect(toolCall(await turn("builder", [user]))).toEqual([
      { name: "bash", arguments: { command: "git commit -am build" } },
    ]);
    expect(toolCall(await turn("faux-1", [user]))).toEqual([
      { name: "bash", arguments: { command: "sleep 8; echo faux-ok" } },
    ]);
  });

  it("verifies after the bash turn only where the model's script says so", async () => {
    expect(toolCall(await turn("builder", [user, bashResult]))).toEqual([
      { name: VERIFY_TOOL, arguments: {} },
    ]);
    const plain = await turn("faux-1", [user, bashResult]);
    expect(toolCall(plain)).toEqual([]);
    expect(plain.content).toEqual([{ type: "text", text: "built (re: go)" }]);
  });
});

describe("parseFauxModelScripts", () => {
  const parse = (text: string) =>
    Effect.runSyncExit(parseFauxModelScripts(text, ["faux-1", "builder"]));

  it("reads a model's command and verify flag, and blank as no table", () => {
    const parsed = parse(
      '{"builder": {"command": "bash build.sh", "verify": true}}',
    );
    expect(Exit.isSuccess(parsed) && [...parsed.value]).toEqual([
      ["builder", { command: "bash build.sh", verify: true }],
    ]);
    const blank = parse("  ");
    expect(Exit.isSuccess(blank) && blank.value.size).toBe(0);
  });

  it("refuses a model the faux backend does not publish, naming it", () => {
    const parsed = parse('{"bulider": {"verify": true}}');
    expect(Exit.isFailure(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).toContain(
      "faux model script for bulider, which the faux backend does not publish",
    );
  });

  it("refuses a table that is not one", () => {
    for (const text of [
      '["builder"]',
      '{"builder": {"verify": "yes"}}',
      '{"builder": {"cmd": "x"}}',
      '{"builder": {"command": "git commit", "verfy": true}}',
      "{",
    ]) {
      const parsed = parse(text);
      expect(Exit.isFailure(parsed)).toBe(true);
      expect(JSON.stringify(parsed)).toContain("faux model scripts are not a");
    }
  });
});
