/**
 * A second model provider and a role's fallback onto it (S-model-provider-breadth).
 *
 * The tables first — `parseOpenAICompatible`, `parseRoleFallbacks`/`resolveRoleFallbacks`, and which
 * answers are a fallback's trigger (`isProviderUnavailable`) — then whole runs through `openSession`
 * against a loopback OpenAI-compatible fake (`./openaiCompatibleFake`) and the faux backend. What a
 * run did is read from what it left behind, never from the code that did it: the requests the fake
 * recorded, the transcript the log committed, the usage ledger Pi Durable keys by the model that
 * answered, and the agent the conversation is pinned to.
 *
 * No database and no real provider: Pi Durable's in-memory storage, a fake on 127.0.0.1, and an
 * injected `AuthContext`, so no variable of the process is read.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type GenerationHooks,
  type Harness,
  type HookApi,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { Effect, Schedule } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  fallbackExtension,
  isProviderUnavailable,
  isRetried,
  NO_ROLE_FALLBACKS,
  parseRoleFallbacks,
  resolveRoleFallbacks,
  type RoleFallbacks,
} from "./fallback";
import {
  parseRoleModels,
  resolveRole,
  resolveRoleModels,
  type RoleModels,
  type RunProfile,
} from "./loader";
import {
  type AuthContext,
  createFauxModelAccess,
  FAUX_FAIL_MESSAGE,
  FAUX_OVERLOADED_MESSAGE,
  type ModelAccess,
  type ModelAccessOptions,
  modelKey,
} from "./models";
import {
  OPENAI_COMPATIBLE_KEY_VARIABLE,
  parseOpenAICompatible,
  type OpenAICompatibleConfig,
} from "./openaiCompatible";
import {
  type OpenAICompatibleFake,
  startOpenAICompatibleFake,
} from "./openaiCompatibleFake";
import {
  closeHarness,
  openSession,
  reachableWindow,
  readPinnedModelKey,
  readSessionLog,
  submitMessage,
} from "./session";

const context = BACKGROUND_CONTEXT;

/** The compatible model's price, per million tokens: what its answers cost in the ledger. */
const PRICE = { input: 3, output: 15 };
/** What one of its answers costs at the fake's default usage (1000 in, 50 out). */
const COMPAT_ANSWER_COST = (1000 * PRICE.input + 50 * PRICE.output) / 1e6;
/** What one faux answer costs (`fauxCost`). */
const FAUX_ANSWER_COST = 0.01;

/** Credentials as the test says they are: none, or a dummy compatible key. */
const auth = (key?: string): AuthContext => ({
  env: async (name) =>
    name === OPENAI_COMPATIBLE_KEY_VARIABLE ? key : undefined,
  fileExists: async () => false,
});

/** `inner` as a storage a harness can close without ending the log, so a second harness can open it. */
const reopenable = (inner: MemoryStorage): Storage =>
  new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const fakes: OpenAICompatibleFake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

const fake = async (
  options: Parameters<typeof startOpenAICompatibleFake>[0] = {},
) => {
  const started = await startOpenAICompatibleFake(options);
  fakes.push(started);
  return started;
};

const compatConfig = (url: string): OpenAICompatibleConfig => ({
  baseUrl: url,
  models: [{ id: "compat-1", cost: PRICE }],
});

/** One deployment: the faux backend and the compatible endpoint, in one registry. */
const deploymentOn = (
  url: string,
  options: ModelAccessOptions = {},
): ModelAccess =>
  createFauxModelAccess({
    fauxModels: ["faux-1", "faux-backup"],
    fauxCost: FAUX_ANSWER_COST,
    openaiCompatible: compatConfig(url),
    authContext: auth(),
    ...options,
  }).access;

/** `ROLE_MODELS` and `ROLE_FALLBACKS`, resolved the way `apps/api` resolves them at boot. */
const tables = (
  deployment: ModelAccess,
  roleModels: string,
  roleFallbacks: string,
): { readonly roles: RoleModels; readonly fallbacks: RoleFallbacks } =>
  Effect.runSync(
    Effect.gen(function* () {
      const roles = yield* resolveRoleModels(
        deployment,
        yield* parseRoleModels(roleModels),
      );
      const fallbacks = yield* resolveRoleFallbacks(
        deployment,
        roles,
        yield* parseRoleFallbacks(roleFallbacks),
      );
      return { roles, fallbacks };
    }),
  );

const builder: RunProfile = {
  column: "building",
  role: "builder",
  skills: [],
};

/** One turn of a run in `builder`'s column on `storage`, read back from its log. */
const turn = (
  storage: Storage,
  deployment: ModelAccess,
  roles: RoleModels,
  fallbacks: RoleFallbacks,
  content: string,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cwd = mkdtempSync(join(tmpdir(), "factory-fallback-"));
      const opened = yield* openSession({
        storage,
        model: deployment,
        roles,
        fallbacks,
        cwd,
        run: builder,
      });
      const submitted = yield* submitMessage(opened.root, { content });
      const settled = yield* Effect.promise(() =>
        submitted.submission.wait(context),
      );
      const agent = yield* Effect.promise(() => opened.root.agent(context));
      const log = yield* readSessionLog(storage);
      const pinned = yield* readPinnedModelKey(storage);
      yield* closeHarness(opened.harness);
      return {
        status: settled.status,
        opened: modelKey(opened.model),
        pinned,
        agent: agent.model,
        entries: log.entries,
        usage: new Map(
          log.usage.models.map((entry) => [entry.key, entry.usage.costTotal]),
        ),
      };
    }),
  );

/** Ledger rows in model order, so a comparison does not depend on which model answered first. */
const byKey = (
  left: readonly [string, number],
  right: readonly [string, number],
): number => left[0].localeCompare(right[0]);

const failure = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

describe("parseOpenAICompatible", () => {
  const read = (baseUrl: string, models: string) =>
    Effect.runSync(
      parseOpenAICompatible({ baseUrl, models }).pipe(
        Effect.match({
          onFailure: (error) => ({ error: error.message }),
          onSuccess: (value) => ({ value }),
        }),
      ),
    );

  it("reads both blank as no second provider, a list of ids, and a priced JSON array", () => {
    expect(read("", " ")).toEqual({ value: undefined });
    expect(read("http://127.0.0.1:8000/v1/", "a, b")).toEqual({
      value: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [{ id: "a" }, { id: "b" }],
      },
    });
    expect(
      read(
        "https://gateway.example/v1",
        '[{"id":"m","contextWindow":32000,"cost":{"input":1,"output":2}}]',
      ),
    ).toEqual({
      value: {
        baseUrl: "https://gateway.example/v1",
        models: [
          { id: "m", contextWindow: 32000, cost: { input: 1, output: 2 } },
        ],
      },
    });
  });

  it("refuses half a configuration, a URL that is not http(s), a repeated id, a typo'd field and a negative price", () => {
    const refusals = [
      read("http://127.0.0.1:8000/v1", ""),
      read("", "a"),
      read("127.0.0.1:8000", "a"),
      read("http://h/v1", "a,a"),
      read("http://h/v1", '[{"id":"a","costs":{"input":1,"output":1}}]'),
      read("http://h/v1", '[{"id":"a","cost":{"input":-1,"output":1}}]'),
      read("http://h/v1", "[]"),
    ];
    for (const refusal of refusals) expect(refusal).toHaveProperty("error");
  });

  it("never echoes a refused URL, which can carry a key", () => {
    const refusal = read("htps://user:sk-secret@gw/v1?key=sk-query", "a");
    expect(refusal).toHaveProperty("error");
    const text = JSON.stringify(refusal);
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("sk-query");
    expect(text).toContain("OPENAI_COMPATIBLE_BASE_URL is not an http(s) URL");
  });
});

describe("parseRoleFallbacks and resolveRoleFallbacks", () => {
  const deployment = createFauxModelAccess({
    fauxModels: ["faux-1", "faux-backup"],
    openaiCompatible: compatConfig("http://127.0.0.1:1/v1"),
  }).access;
  const outcome = (roleModels: string, roleFallbacks: string) =>
    Effect.runSync(
      Effect.gen(function* () {
        const roles = yield* resolveRoleModels(
          deployment,
          yield* parseRoleModels(roleModels),
        );
        return yield* resolveRoleFallbacks(
          deployment,
          roles,
          yield* parseRoleFallbacks(roleFallbacks),
        );
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error: error.message }),
          onSuccess: (table) => ({
            table: [...table].map(([role, chain]) => [
              role,
              chain.map(modelKey),
            ]),
          }),
        }),
      ),
    );

  it("reads role=provider/model|provider/model in order, and blank as no table", () => {
    expect(outcome("", "")).toEqual({ table: [] });
    expect(
      outcome(
        "builder=faux/faux-backup",
        " builder = openai-compatible/compat-1 | faux/faux-1 , reviewer=faux/faux-backup",
      ),
    ).toEqual({
      table: [
        ["builder", ["openai-compatible/compat-1", "faux/faux-1"]],
        ["reviewer", ["faux/faux-backup"]],
      ],
    });
  });

  it("refuses a malformed row, a role twice, a model twice, a model nobody serves, and the role's own model", () => {
    for (const text of [
      "builder",
      "builder=",
      "=faux/faux-1",
      "builder=faux/faux-backup|",
      "builder=faux/faux-backup,builder=faux/faux-1",
      "builder=faux/faux-backup|faux/faux-backup",
      "builder=openai-compatible/nobody",
    ]) {
      expect(outcome("", text)).toHaveProperty("error");
    }
    // The head is the role's row, else the deployment's model: neither can follow itself.
    expect(outcome("", "builder=faux/faux-1")).toHaveProperty("error");
    expect(
      outcome("builder=faux/faux-backup", "builder=faux/faux-backup"),
    ).toHaveProperty("error");
    expect(outcome("builder=faux/faux-backup", "builder=faux/faux-1")).toEqual({
      table: [["builder", ["faux/faux-1"]]],
    });
  });

  it("gives a role its chain through resolveRole, and every other run none", () => {
    const { roles, fallbacks } = tables(
      deployment,
      "",
      "builder=openai-compatible/compat-1",
    );
    const chain = (profile: RunProfile | undefined) =>
      resolveRole(
        profile,
        deployment,
        roles,
        undefined,
        fallbacks,
      ).fallbacks.map(modelKey);
    expect(chain(builder)).toEqual(["openai-compatible/compat-1"]);
    expect(chain({ column: "review", role: "reviewer", skills: [] })).toEqual(
      [],
    );
    expect(chain(undefined)).toEqual([]);
    expect(
      resolveRole(builder, deployment, roles, undefined, NO_ROLE_FALLBACKS)
        .fallbacks,
    ).toEqual([]);
  });
});

describe("isProviderUnavailable", () => {
  it("is an overloaded or unavailable provider, and nothing else", () => {
    for (const text of [
      FAUX_OVERLOADED_MESSAGE,
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "503 Service Unavailable",
      "The model is at capacity, try again",
    ]) {
      expect(isProviderUnavailable(failure(text))).toBe(true);
    }
    for (const text of [
      FAUX_FAIL_MESSAGE,
      "429 rate limit exceeded",
      "500 internal server error",
      "fetch failed",
      // A quota is not an outage, however it is worded: pi-ai never retries it.
      "insufficient_quota: the account is overloaded with charges",
      "",
    ]) {
      expect(isProviderUnavailable(failure(text))).toBe(false);
    }
    expect(
      isProviderUnavailable({ ...failure("overloaded"), stopReason: "stop" }),
    ).toBe(false);
  });
});

describe("a role on the second provider", () => {
  it("runs a session end to end on the OpenAI-compatible endpoint, its answers charged to its model", async () => {
    const endpoint = await fake();
    const deployment = deploymentOn(endpoint.url);
    const { roles } = tables(
      deployment,
      "builder=openai-compatible/compat-1",
      "",
    );
    const result = await turn(
      new MemoryStorage(),
      deployment,
      roles,
      NO_ROLE_FALLBACKS,
      "go",
    );

    expect(result.status).toBe("done");
    expect(result.opened).toBe("openai-compatible/compat-1");
    // The endpoint was asked twice — the tool call, then the answer — under the role's model id,
    // and keyless, because no key resolved.
    expect(
      endpoint.requests.map((request) => [request.model, request.answered]),
    ).toEqual([
      ["compat-1", "bash"],
      ["compat-1", "text"],
    ]);
    expect(endpoint.requests[0]?.authorization).toBe("Bearer keyless");
    // The tool ran in the session's own shell, and the answer says what it printed.
    const kinds = result.entries.map((entry) => entry.kind);
    expect(kinds).toContain("toolResult");
    expect(result.entries.at(-1)).toMatchObject({
      kind: "assistant",
      text: "compat-ok (re: go)",
    });
    expect([...result.usage]).toEqual([
      ["openai-compatible/compat-1", 2 * COMPAT_ANSWER_COST],
    ]);
  }, 30_000);

  it("sends the endpoint the key pi-ai resolves, never a placeholder, when one is set", async () => {
    const endpoint = await fake();
    const deployment = deploymentOn(endpoint.url, {
      authContext: auth("test-dummy-compat-key"),
    });
    const { roles } = tables(
      deployment,
      "builder=openai-compatible/compat-1",
      "",
    );
    await turn(new MemoryStorage(), deployment, roles, NO_ROLE_FALLBACKS, "go");
    expect(endpoint.requests.map((request) => request.authorization)).toEqual([
      "Bearer test-dummy-compat-key",
      "Bearer test-dummy-compat-key",
    ]);
  }, 30_000);
});

describe("a role's fallback chain", () => {
  it("switches a forced 529 from the primary onto the fallback once, says so in the transcript, and charges each answer to its model", async () => {
    const endpoint = await fake();
    // The primary is the faux's `faux-1`, overloaded from its second request on: the run's `bash`
    // call is answered (and charged) on it, the request after the tool is refused with a 529.
    const deployment = deploymentOn(endpoint.url, {
      fauxModelScripts: new Map([
        ["faux-1", { fail: { afterAnswers: 1, kind: "overloaded" } }],
      ]),
    });
    const { roles, fallbacks } = tables(
      deployment,
      "",
      "builder=openai-compatible/compat-1",
    );
    const storage = reopenable(new MemoryStorage());
    const first = await turn(storage, deployment, roles, fallbacks, "go");

    expect(first.status).toBe("done");
    expect(first.opened).toBe("faux/faux-1");
    const switches = first.entries.filter(
      (entry) => entry.kind === "modelSwitch",
    );
    expect(switches).toHaveLength(1);
    expect(switches[0]?.text).toContain("faux/faux-1 is unavailable");
    expect(switches[0]?.text).toContain(FAUX_OVERLOADED_MESSAGE);
    expect(switches[0]?.text).toContain("go to openai-compatible/compat-1");
    // The transcript in order: the primary's tool round, the switch, the 529 it was made for, and
    // the fallback's answer, which picks up from the primary's tool result.
    const tail = first.entries
      .filter((entry) => entry.kind !== "system")
      .map((entry) =>
        entry.kind === "assistant" && entry.isError === true
          ? `error: ${entry.error}`
          : entry.kind,
      );
    expect(tail).toEqual([
      "user",
      "assistant",
      "toolResult",
      "modelSwitch",
      `error: ${FAUX_OVERLOADED_MESSAGE}`,
      "assistant",
    ]);
    expect(first.entries.at(-1)?.text).toBe("faux-ok (re: go)");
    // Asked once, for the answer: the fallback was never asked to redo the primary's tool round.
    expect(endpoint.requests.map((request) => request.answered)).toEqual([
      "text",
    ]);
    // Each answer is charged to the model that gave it: the primary's `bash` call at the faux's
    // price, its 529 at nothing, and the fallback's answer at the endpoint's.
    expect([...first.usage].sort(byKey)).toEqual([
      ["faux/faux-1", FAUX_ANSWER_COST],
      ["openai-compatible/compat-1", COMPAT_ANSWER_COST],
    ]);
    // The recorded switch is the one change of the pinned model: the agent and the log agree.
    expect(first.agent).toEqual({
      provider: "openai-compatible",
      modelId: "compat-1",
    });
    expect(first.pinned).toBe("openai-compatible/compat-1");

    // A later turn, in a reopened harness, stays on the fallback: the pin is the switch's, the role
    // table is unchanged, and nothing switches again.
    const second = await turn(storage, deployment, roles, fallbacks, "again");
    expect(second.status).toBe("done");
    expect(second.opened).toBe("openai-compatible/compat-1");
    expect(
      second.entries.filter((entry) => entry.kind === "modelSwitch"),
    ).toHaveLength(1);
    expect(endpoint.requests.map((request) => request.answered)).toEqual([
      "text",
      "text",
    ]);
    expect(second.usage.get("faux/faux-1")).toBe(FAUX_ANSWER_COST);
    expect(second.usage.get("openai-compatible/compat-1")).toBeCloseTo(
      2 * COMPAT_ANSWER_COST,
      12,
    );
  }, 30_000);

  it("switches an endpoint's HTTP 529 onto a faux fallback, as pi-ai reports a real provider's", async () => {
    const endpoint = await fake({ fail: { afterAnswers: 1, status: 529 } });
    const deployment = deploymentOn(endpoint.url);
    const { roles, fallbacks } = tables(
      deployment,
      "builder=openai-compatible/compat-1",
      "builder=faux/faux-backup",
    );
    const result = await turn(
      new MemoryStorage(),
      deployment,
      roles,
      fallbacks,
      "go",
    );
    expect(result.status).toBe("done");
    expect(endpoint.requests.map((request) => request.status)).toEqual([
      200, 529,
    ]);
    const switched = result.entries.filter(
      (entry) => entry.kind === "modelSwitch",
    );
    expect(switched).toHaveLength(1);
    expect(switched[0]?.text).toContain(
      "openai-compatible/compat-1 is unavailable",
    );
    expect(result.pinned).toBe("faux/faux-backup");
    expect(result.entries.at(-1)?.text).toBe("compat-ok (re: go)");
    expect([...result.usage].sort(byKey)).toEqual([
      ["faux/faux-backup", FAUX_ANSWER_COST],
      ["openai-compatible/compat-1", COMPAT_ANSWER_COST],
    ]);
  }, 30_000);

  it("moves down a chain one model per outage, and never back up it", async () => {
    const endpoint = await fake();
    const deployment = deploymentOn(endpoint.url, {
      fauxModelScripts: new Map([
        ["faux-1", { fail: { afterAnswers: 1, kind: "overloaded" } }],
        ["faux-backup", { fail: { afterAnswers: 0, kind: "overloaded" } }],
      ]),
    });
    const { roles, fallbacks } = tables(
      deployment,
      "",
      "builder=faux/faux-backup|openai-compatible/compat-1",
    );
    const result = await turn(
      new MemoryStorage(),
      deployment,
      roles,
      fallbacks,
      "go",
    );
    expect(result.status).toBe("done");
    expect(
      result.entries
        .filter((entry) => entry.kind === "modelSwitch")
        .map((entry) => entry.text.split(" is unavailable")[0]),
    ).toEqual(["model switch: faux/faux-1", "model switch: faux/faux-backup"]);
    expect(result.pinned).toBe("openai-compatible/compat-1");
  }, 30_000);

  it("does not switch on a failure that is not an outage: the run fails on its own model", async () => {
    const endpoint = await fake();
    const deployment = deploymentOn(endpoint.url, {
      fauxModelScripts: new Map([["faux-1", { fail: { afterAnswers: 1 } }]]),
    });
    const { roles, fallbacks } = tables(
      deployment,
      "",
      "builder=openai-compatible/compat-1",
    );
    const result = await turn(
      new MemoryStorage(),
      deployment,
      roles,
      fallbacks,
      "go",
    );
    expect(result.status).toBe("unanswered");
    expect(result.entries.some((entry) => entry.kind === "modelSwitch")).toBe(
      false,
    );
    expect(result.pinned).toBe("faux/faux-1");
    expect(endpoint.requests).toEqual([]);
  }, 30_000);

  it("leaves a session created on a model outside the chain on that model", async () => {
    const endpoint = await fake();
    const deployment = deploymentOn(endpoint.url, {
      fauxModelScripts: new Map([
        ["faux-backup", { fail: { afterAnswers: 1, kind: "overloaded" } }],
      ]),
    });
    const { roles, fallbacks } = tables(
      deployment,
      "",
      "builder=openai-compatible/compat-1",
    );
    // A session created on `faux-backup` runs it whatever its role says (LOB-274), so the role's
    // chain — headed by `faux-1` — has nothing to say about its outage.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = new MemoryStorage();
        const opened = yield* openSession({
          storage,
          model: deployment,
          roles,
          fallbacks,
          sessionModel: {
            ...deployment,
            modelId: "faux-backup",
          },
          cwd: mkdtempSync(join(tmpdir(), "factory-fallback-")),
          run: builder,
        });
        const submitted = yield* submitMessage(opened.root, {
          content: "go",
        });
        // Until the 529 is in the log: a switch is committed before the failed answer it is for,
        // so by then one would be there too.
        const log = yield* readSessionLog(storage).pipe(
          Effect.repeat({
            until: (read) =>
              read.entries.some(
                (entry) => entry.kind === "assistant" && entry.isError === true,
              ),
            schedule: Schedule.spaced("50 millis"),
          }),
        );
        yield* Effect.promise(() => opened.root.abort(context));
        yield* Effect.promise(() => submitted.submission.wait(context));
        yield* closeHarness(opened.harness);
        return log;
      }),
    );
    expect(result.entries.some((entry) => entry.kind === "modelSwitch")).toBe(
      false,
    );
    expect(
      result.entries.filter(
        (entry) => entry.kind === "assistant" && entry.isError === true,
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(endpoint.requests).toEqual([]);
  }, 30_000);
});

describe("a switch only for a request Pi Durable sends again", () => {
  const policy = {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
  };

  it("is retried while the attempt is within the policy's retries, and never once they are spent", () => {
    expect(isRetried(1, policy)).toBe(true);
    expect(isRetried(3, policy)).toBe(true);
    expect(isRetried(4, policy)).toBe(false);
    expect(isRetried(1, { ...policy, enabled: false })).toBe(false);
    expect(isRetried(undefined, policy)).toBe(false);
  });

  /** The hook as Pi Durable calls it, on an answer for `attempt`, counting the switches it asks for. */
  const afterResponseOn = async (attempt: number) => {
    const deployment = createFauxModelAccess({
      fauxModels: ["faux-1", "faux-backup"],
    }).access;
    const chain = [deployment, { ...deployment, modelId: "faux-backup" }];
    let reads = 0;
    const harness: Pick<Harness, "conversation"> = {
      conversation: () => {
        reads += 1;
        return Promise.resolve(undefined);
      },
    };
    const registration = fallbackExtension(chain, () => harness, policy)
      .hooks?.[0];
    const hooks = registration?.handlers as Partial<GenerationHooks>;
    const api = {
      conversationId: 0,
      snapshot: () => Promise.resolve({ generation: { attempt } }),
    } as unknown as HookApi;
    await hooks.afterResponse?.(
      {
        ...failure(FAUX_OVERLOADED_MESSAGE),
        provider: "faux",
        model: "faux-1",
      },
      api,
      context,
    );
    return reads;
  };

  it("moves the conversation on an outage the policy retries, and leaves it when the retries are spent", async () => {
    // The commit reads the conversation first: one read is a switch attempted, none is no switch.
    expect(await afterResponseOn(3)).toBe(1);
    expect(await afterResponseOn(4)).toBe(0);
  });
});

describe("the compaction window of a run that can fall back", () => {
  const deployment = createFauxModelAccess({ fauxModels: ["big"] }).access;
  const big = { ...deployment, modelId: "big", contextWindow: 200_000 };
  const small = { ...deployment, modelId: "small", contextWindow: 32_000 };
  const unknown = { ...deployment, modelId: "gone", contextWindow: 0 };

  it("is the smallest window of the model and every link after it, ignoring windows nobody knows", () => {
    expect(reachableWindow(big, [])).toBe(200_000);
    expect(reachableWindow(big, [big, small])).toBe(32_000);
    // Already on the last link: nothing smaller is reachable.
    expect(reachableWindow(small, [big, small])).toBe(32_000);
    expect(reachableWindow(big, [small, big])).toBe(200_000);
    expect(reachableWindow(big, [big, unknown])).toBe(200_000);
    expect(reachableWindow(unknown, [])).toBe(0);
  });
});

describe("a session created on a model of its own", () => {
  it("never falls back, even on a model its role's chain holds, on this open or a later one", async () => {
    const endpoint = await fake();
    const deployment = deploymentOn(endpoint.url, {
      fauxModelScripts: new Map([
        ["faux-backup", { fail: { afterAnswers: 1, kind: "overloaded" } }],
      ]),
    });
    // `faux-backup` is a link of the builder's chain, between its head and the endpoint.
    const { roles, fallbacks } = tables(
      deployment,
      "",
      "builder=faux/faux-backup|openai-compatible/compat-1",
    );
    const storage = reopenable(new MemoryStorage());
    const sessionModel = { ...deployment, modelId: "faux-backup" };
    /** One turn, stopped once the 529 is in the log: a switch would be committed before it. */
    const outage = (withModel: boolean) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const opened = yield* openSession({
            storage,
            model: deployment,
            roles,
            fallbacks,
            ...(withModel ? { sessionModel } : {}),
            cwd: mkdtempSync(join(tmpdir(), "factory-fallback-")),
            run: builder,
          });
          const before = (yield* readSessionLog(storage)).entries.filter(
            (entry) => entry.kind === "assistant" && entry.isError === true,
          ).length;
          const submitted = yield* submitMessage(opened.root, {
            content: "go",
          });
          const log = yield* readSessionLog(storage).pipe(
            Effect.repeat({
              until: (read) =>
                read.entries.filter(
                  (entry) =>
                    entry.kind === "assistant" && entry.isError === true,
                ).length > before,
              schedule: Schedule.spaced("50 millis"),
            }),
          );
          yield* Effect.promise(() => opened.root.abort(context));
          yield* Effect.promise(() => submitted.submission.wait(context));
          const pinned = yield* readPinnedModelKey(storage);
          yield* closeHarness(opened.harness);
          return { log, pinned };
        }),
      );
    // Created on it: the open that creates the root records the choice.
    const first = await outage(true);
    expect(
      first.log.entries.some((entry) => entry.kind === "modelSwitch"),
    ).toBe(false);
    expect(first.pinned).toBe("faux/faux-backup");
    // Reopened as every later open is, without the model: the record still keeps the chain off.
    const second = await outage(false);
    expect(
      second.log.entries.some((entry) => entry.kind === "modelSwitch"),
    ).toBe(false);
    expect(second.pinned).toBe("faux/faux-backup");
    expect(endpoint.requests).toEqual([]);
  }, 30_000);
});
