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
import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_AUTH_VARIABLES,
  checkModelAuth,
  compactionPolicyFor,
  createModelAccess,
  FAUX_FAIL_MESSAGE,
  fauxAnswer,
  isFauxTurnStep,
  modelKey,
  parseFauxFail,
  parseFauxModelScripts,
  resolveDefaultModel,
} from "./models";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
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

/**
 * `DEFAULT_MODEL` (LOB-274) is the backend's catalog asked for one model: the deployment's default
 * when it holds it, the backend's own when the variable is blank, and a typed refusal — the boot's —
 * naming the key when it does not.
 */
describe("resolveDefaultModel", () => {
  const anthropic = createModelAccess("anthropic", {
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const faux = createModelAccess("faux", {
    fauxModels: ["faux-1", "faux-cheap"],
  });
  const resolved = (
    backend: typeof anthropic,
    key: string,
  ):
    | { readonly model: string; readonly window: number }
    | { readonly error: string } =>
    Effect.runSync(
      resolveDefaultModel(backend, key).pipe(
        Effect.match({
          onFailure: (error) => ({ error: `${error._tag}: ${error.message}` }),
          onSuccess: (access) => ({
            model: modelKey(access),
            window: access.contextWindow,
          }),
        }),
      ),
    );

  it("changes the deployment's model to one the catalog serves, and keeps its registry", () => {
    expect(resolved(anthropic, "anthropic/claude-haiku-4-5")).toEqual({
      model: "anthropic/claude-haiku-4-5",
      window: anthropic.models.getModel("anthropic", "claude-haiku-4-5")
        ?.contextWindow,
    });
    expect(resolved(faux, " faux/faux-cheap ")).toEqual({
      model: "faux/faux-cheap",
      window: 128_000,
    });
    const access = Effect.runSync(
      resolveDefaultModel(anthropic, "anthropic/claude-haiku-4-5"),
    );
    expect(access.models).toBe(anthropic.models);
    expect(access.backend).toBe("anthropic");
  });

  it("keeps the backend's own model when DEFAULT_MODEL is blank", () => {
    expect(Effect.runSync(resolveDefaultModel(anthropic, ""))).toBe(anthropic);
    expect(Effect.runSync(resolveDefaultModel(faux, "  "))).toBe(faux);
  });

  it("refuses a model outside the catalog, naming it and the backend", () => {
    for (const [backend, key] of [
      [anthropic, "anthropic/claude-nonexistent-9"],
      [anthropic, "faux/faux-1"],
      [faux, "anthropic/claude-haiku-4-5"],
      [faux, "faux/faux-unpublished"],
      [faux, "faux-1"],
    ] as const) {
      expect(resolved(backend, key)).toEqual({
        error: `InvalidDefaultModel: DEFAULT_MODEL names model ${key}, which this process does not serve on the ${backend.backend} backend (provider/modelId, one of getServerInfo's models)`,
      });
    }
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

/**
 * The faux fails a request on demand (F6): `FAUX_FAIL`, process-wide or one model's `fail`, ends a
 * turn's step with `stopReason: "error"` and `FAUX_FAIL_MESSAGE`, which Pi Durable does not retry.
 * `SessionService.failures.test.ts` proves the session that reaches goes idle with an error entry
 * and a `run_failures` row; these pin which request fails. Mutation: drop the failure from the
 * factory — every case answers; count user messages rather than answers — `model_error:1` fails the
 * first step; fail a summary — the compaction case errors; retryable wording — the retry case fails.
 */
describe("the failing faux (F6)", () => {
  const user: Message = { role: "user", content: "go", timestamp: 0 };
  const bashCall: Message = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: { command: "echo faux-ok" },
      },
    ],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const bashResult: Message = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text: "faux-ok" }],
    isError: false,
    timestamp: 0,
  };
  const turn = (
    access: ReturnType<typeof createModelAccess>,
    messages: Message[],
    modelId = access.modelId,
  ) => {
    const model = access.models.getModel("faux", modelId);
    if (model === undefined) throw new Error(`faux does not serve ${modelId}`);
    return access.models.completeSimple(model, { messages });
  };

  it("fails a turn's first request with model_error, as a provider error Pi Durable does not retry", async () => {
    const failing = createModelAccess("faux", {
      fauxFail: { afterAnswers: 0 },
    });
    const answer = await turn(failing, [user]);
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toBe(FAUX_FAIL_MESSAGE);
    expect(answer.content).toEqual([]);
    expect(isRetryableAssistantError(answer)).toBe(false);
    // A compaction's summary is not a turn's step: it still answers, so the failure is the run's.
    const summary = await turn(failing, [
      { ...user, content: "<conversation>user: hi</conversation>" },
    ]);
    expect(summary.stopReason).toBe("stop");
  });

  it("lets the model answer n times first with model_error:n", async () => {
    const afterOne = createModelAccess("faux", {
      fauxFail: { afterAnswers: 1 },
    });
    const first = await turn(afterOne, [user]);
    expect(first.stopReason).toBe("toolUse");
    const second = await turn(afterOne, [user, bashCall, bashResult]);
    expect(second.stopReason).toBe("error");
    expect(second.errorMessage).toBe(FAUX_FAIL_MESSAGE);
  });

  it("fails only the model whose script says so, and never by default", async () => {
    const access = createModelAccess("faux", {
      fauxModels: ["faux-1", "faulted"],
      fauxModelScripts: new Map([["faulted", { fail: { afterAnswers: 0 } }]]),
    });
    expect((await turn(access, [user], "faulted")).stopReason).toBe("error");
    expect((await turn(access, [user], "faux-1")).stopReason).toBe("toolUse");
    expect(
      (await turn(createModelAccess("faux"), [user])).stopReason,
    ).toBe("toolUse");
  });

  it("reads FAUX_FAIL as model_error or model_error:<answers>, blank as never, and refuses anything else", () => {
    const read = (text: string) => Effect.runSyncExit(parseFauxFail(text));
    expect(read("")).toEqual(Exit.succeed(undefined));
    expect(read(" model_error ")).toEqual(Exit.succeed({ afterAnswers: 0 }));
    expect(read("model_error:2")).toEqual(Exit.succeed({ afterAnswers: 2 }));
    for (const text of ["yes", "model_error:", "model_error:-1", "budget"]) {
      const refused = read(text);
      expect(Exit.isFailure(refused)).toBe(true);
      expect(JSON.stringify(refused)).toContain("neither model_error");
    }
    const scripts = Effect.runSyncExit(
      parseFauxModelScripts('{"builder": {"fail": "model_error:1"}}', [
        "faux-1",
        "builder",
      ]),
    );
    expect(Exit.isSuccess(scripts) && [...scripts.value]).toEqual([
      ["builder", { fail: { afterAnswers: 1 } }],
    ]);
    const typo = Effect.runSyncExit(
      parseFauxModelScripts('{"builder": {"fail": "model-error"}}', [
        "faux-1",
        "builder",
      ]),
    );
    expect(JSON.stringify(typo)).toContain(
      "faux model script for builder: FAUX_FAIL is",
    );
  });
});

/**
 * `checkModelAuth` is pi-ai's own resolution (LOB-258), driven through an injected context so no
 * test touches the process environment. The values are dummies: nothing is sent anywhere.
 */
describe("checkModelAuth", () => {
  const authWith = (env: Readonly<Record<string, string>>) =>
    Effect.runPromise(
      checkModelAuth(
        createModelAccess("anthropic", {
          authContext: {
            env: async (name) => env[name],
            fileExists: async () => false,
          },
        }),
      ),
    );

  it("names each token variable as the source when it is the only one set", async () => {
    for (const name of ANTHROPIC_AUTH_VARIABLES.tokens) {
      expect(await authWith({ [name]: "dummy-credential" })).toEqual(
        Option.some({ source: name, type: "api_key" }),
      );
    }
  });

  it("takes pi-ai's order: the bearer token before the OAuth token before the key", async () => {
    expect(
      await authWith({
        ANTHROPIC_API_KEY: "dummy-key",
        ANTHROPIC_OAUTH_TOKEN: "dummy-oauth",
        ANTHROPIC_AUTH_TOKEN: "dummy-bearer",
      }),
    ).toEqual(Option.some({ source: "ANTHROPIC_AUTH_TOKEN", type: "api_key" }));
    expect(
      await authWith({
        ANTHROPIC_API_KEY: "dummy-key",
        ANTHROPIC_OAUTH_TOKEN: "dummy-oauth",
      }),
    ).toEqual(
      Option.some({ source: "ANTHROPIC_OAUTH_TOKEN", type: "api_key" }),
    );
  });

  it("authenticates by workload identity federation only with all three of its variables", async () => {
    const federation = Object.fromEntries(
      ANTHROPIC_AUTH_VARIABLES.federation.map((name) => [name, "dummy"]),
    );
    expect(await authWith(federation)).toEqual(
      Option.some({ source: "workload identity federation", type: "api_key" }),
    );
    for (const missing of ANTHROPIC_AUTH_VARIABLES.federation) {
      const { [missing]: _dropped, ...partial } = federation;
      expect(await authWith(partial)).toEqual(Option.none());
    }
  });

  it("finds nothing with no variable set, or only one pi-ai never reads", async () => {
    expect(await authWith({})).toEqual(Option.none());
    expect(
      await authWith({ CLAUDE_CODE_OAUTH_TOKEN: "dummy-subscription" }),
    ).toEqual(Option.none());
  });
});
