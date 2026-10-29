import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerInfo } from "@repo/domain/Server";
import { Config, Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The API's boot under each Anthropic auth mode (LOB-258): the real `src/index.ts`, its real logger
 * and pi-ai's real credential lookup over the process environment.
 *
 * Each case starts `bun --no-env-file src/index.ts` with an environment built from nothing but the
 * case (and `PATH`), so neither a developer's shell nor a `.env` can lend it a credential; every
 * credential is a dummy, and nothing contacts Anthropic, because a boot sends no request. The server
 * binds port 0 on loopback, and `DATABASE_URL` names a port nothing listens on: the pool is lazy and
 * migrations retry in the background (`index.ts`), so the boot completes without any database.
 */

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "factory-api-boot-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The line the server logs once it is bound: the boot is over. */
const LISTENING = "Listening on";

type Boot<A = never> = {
  /** The exit code when the process ended on its own; `null` when it listened (and was stopped). */
  readonly code: number | null;
  /** stdout and stderr together: every line the process logged until it listened or exited. */
  readonly output: string;
  /** What `whileListening` answered, when the process listened and a callback was given. */
  readonly asked?: A;
};

/** The base URL the `Listening on` line names, e.g. `http://127.0.0.1:53211`. */
const listeningUrl = (output: string): string => {
  const match = /Listening on (http:\/\/[^\s"]+)/.exec(output);
  if (match?.[1] === undefined) throw new Error(`no address in: ${output}`);
  return match[1];
};

/**
 * Boot the API with `env` and nothing else, until it listens or exits on its own. Closing the scope
 * kills a process that is still running, so a listening server is stopped here.
 */
const boot = <A = never>(
  env: Readonly<Record<string, string>>,
  /** Called once the server listens, before it is stopped, with its base URL. */
  whileListening?: (url: string) => Promise<A>,
): Promise<Boot<A>> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("bun", ["--no-env-file", ENTRY], {
        cwd: scratch,
        extendEnv: false,
        env: {
          PATH: yield* Config.String("PATH"),
          HOME: scratch,
          PORT: "0",
          HOST: "127.0.0.1",
          SESSION_ROOT: join(scratch, "sessions"),
          DATABASE_URL: "postgres://factory:factory@127.0.0.1:1/unreachable",
          ...env,
        },
        stdin: "ignore",
      }),
    );
    const output = yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.scan(
        () => "",
        (seen: string, chunk: string) => seen + chunk,
      ),
      Stream.takeUntil((seen) => seen.includes(LISTENING)),
      Stream.runLast,
      Effect.map(Option.getOrElse(() => "")),
    );
    if (output.includes(LISTENING)) {
      if (whileListening === undefined)
        return { code: null, output } satisfies Boot<A>;
      const asked = yield* Effect.promise(() =>
        whileListening(listeningUrl(output)),
      );
      return { code: null, output, asked } satisfies Boot<A>;
    }
    return { code: Number(yield* handle.exitCode), output } satisfies Boot<A>;
  }).pipe(
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  );

describe.concurrent("the API's boot, per Anthropic auth mode (LOB-258)", () => {
  for (const name of [
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ]) {
    it(`boots on anthropic with only ${name} set, logging its name and never its value`, async () => {
      const value = `dummy-${name.toLowerCase().replaceAll("_", "-")}-0123456789`;
      const { code, output } = await boot({ [name]: value });
      expect(code, output).toBeNull();
      expect(output).toContain(`model backend: anthropic (auth: ${name})`);
      expect(output).not.toContain(value);
      expect(output).not.toContain("faux");
    }, 30_000);
  }

  it("exits non-zero when MODEL_BACKEND forces anthropic and the only key is blank, listing the accepted variables", async () => {
    // A whitespace-only value is not a credential: pi-ai's lookup treats it as unset.
    const { code, output } = await boot({
      MODEL_BACKEND: "anthropic",
      ANTHROPIC_API_KEY: "   ",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    expect(code, output).not.toBeNull();
    expect(code, output).not.toBe(0);
    expect(output).toContain("AnthropicCredentialMissing");
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
    ]) {
      expect(output).toContain(name);
    }
    expect(output).not.toContain("Listening on");
  }, 30_000);

  it("boots on anthropic from workload identity federation when the token file exists", async () => {
    const token = join(scratch, "identity-token");
    writeFileSync(token, "dummy-identity-token-0123456789");
    const { code, output } = await boot({
      MODEL_BACKEND: "anthropic",
      ANTHROPIC_FEDERATION_RULE_ID: "dummy-rule",
      ANTHROPIC_ORGANIZATION_ID: "dummy-org",
      ANTHROPIC_IDENTITY_TOKEN_FILE: token,
    });
    expect(code, output).toBeNull();
    expect(output).toContain(
      "model backend: anthropic (MODEL_BACKEND; auth: workload identity federation)",
    );
    expect(output).not.toContain("dummy-identity-token-0123456789");
  }, 30_000);

  it("exits non-zero when MODEL_BACKEND forces anthropic on a federation whose token file does not exist", async () => {
    const missing = join(scratch, "no-such-identity-token");
    const { code, output } = await boot({
      MODEL_BACKEND: "anthropic",
      ANTHROPIC_FEDERATION_RULE_ID: "dummy-rule",
      ANTHROPIC_ORGANIZATION_ID: "dummy-org",
      ANTHROPIC_IDENTITY_TOKEN_FILE: missing,
    });
    expect(code, output).not.toBeNull();
    expect(code, output).not.toBe(0);
    expect(output).toContain("AnthropicIdentityTokenFileMissing");
    expect(output).toContain(missing);
    expect(output).not.toContain("Listening on");
  }, 30_000);

  it("says faux was selected by MODEL_BACKEND, even with a key set", async () => {
    const { code, output } = await boot({
      MODEL_BACKEND: "faux",
      ANTHROPIC_API_KEY: "dummy-key-that-must-not-matter",
    });
    expect(code, output).toBeNull();
    expect(output).toContain("model backend: faux (selected by MODEL_BACKEND)");
    expect(output).not.toContain("dummy-key-that-must-not-matter");
  }, 30_000);

  it("falls back to faux with no credential, and says the Claude Code token is not read", async () => {
    const { code, output } = await boot({
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-subscription-token",
    });
    expect(code, output).toBeNull();
    expect(output).toContain(
      "model backend: faux (no Anthropic credential resolved)",
    );
    expect(output).toContain("CLAUDE_CODE_OAUTH_TOKEN is set but not read");
    expect(output).not.toContain("dummy-subscription-token");
  }, 30_000);
});

/**
 * `getServerInfo` against the real boot (LOB-269): the process is configured only through its
 * environment, and the answer is read over its own `/rpc` as raw NDJSON, so both what the boot
 * resolved and every byte a client receives are under test. No database is reachable here, which
 * is the point too: the answer needs none.
 */
describe("getServerInfo on a booted API (LOB-269)", () => {
  /** The NDJSON message that settles a request: its exit, a success carrying the answer. */
  const ExitMessage = Schema.fromJsonString(
    Schema.TaggedStruct("Exit", {
      exit: Schema.TaggedStruct("Success", { value: ServerInfo }),
    }),
  );

  /** One `getServerInfo` request, as the RPC client frames it over NDJSON. */
  const REQUEST = `${JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: "getServerInfo",
    payload: {},
    headers: [],
  })}\n`;

  /** One `getServerInfo` call over HTTP: the decoded answer and the body as it arrived. */
  const getServerInfo = (url: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${url}/rpc`).pipe(
          HttpClientRequest.bodyText(REQUEST, "application/ndjson"),
        ),
      );
      const wire = yield* response.text;
      const line = wire.split("\n").find((text) => text.includes('"Exit"'));
      const message = yield* Schema.decodeUnknownEffect(ExitMessage)(line);
      return { wire, info: message.exit.value };
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

  const KEY = "sk-ant-dummy-boot-lob269-0123456789";
  const SECRETS = {
    GITHUB_WEBHOOK_SECRET: "dummy-github-webhook-secret-boot-lob269",
    LINEAR_WEBHOOK_SECRET: "dummy-linear-webhook-secret-boot-lob269",
    GITHUB_TOKEN: "dummy-github-token-boot-lob269",
  };

  it("answers backend faux, faux/faux-1 and the ROLE_MODELS rows under MODEL_BACKEND=faux, and no credential's value", async () => {
    const { code, output, asked } = await boot(
      {
        MODEL_BACKEND: "faux",
        ROLE_MODELS: "specifier=faux/faux-spec,reviewer=faux/faux-review",
        APPROVAL_REQUIRED: "npm publish",
        SESSION_BUDGET: "2.5",
        ANTHROPIC_API_KEY: KEY,
        ...SECRETS,
      },
      getServerInfo,
    );
    expect(code, output).toBeNull();
    if (asked === undefined) throw new Error("the boot never answered");
    const { info, wire } = asked;
    expect(info.backend).toBe("faux");
    expect(info.selectedBy).toBe("MODEL_BACKEND");
    expect(info.defaultModel).toBe("faux/faux-1");
    expect(info.roleModels).toEqual([
      { role: "reviewer", model: "faux/faux-review" },
      { role: "specifier", model: "faux/faux-spec" },
    ]);
    expect(info.models).toEqual([
      "faux/faux-1",
      "faux/faux-review",
      "faux/faux-spec",
    ]);
    expect(info.approvalRequired).toEqual(["npm publish"]);
    expect(info.defaultBudget).toBe(2.5);
    expect(info.credentialMode).toEqual({
      model: null,
      forge: "static-token",
      reviewer: "none",
    });
    expect(
      info.webhooks.filter((route) => route.armed).map((route) => route.route),
    ).toEqual(["/webhooks/linear", "/webhooks/github"]);
    expect(info.linearWriteBack).toEqual({ enabled: false });
    for (const secret of [KEY, ...Object.values(SECRETS)]) {
      expect(wire).not.toContain(secret);
    }
  }, 30_000);

  it("reports the forge credential as none when neither GITHUB_TOKEN nor a GitHub App is configured", async () => {
    const { code, output, asked } = await boot(
      { MODEL_BACKEND: "faux" },
      getServerInfo,
    );
    expect(code, output).toBeNull();
    if (asked === undefined) throw new Error("the boot never answered");
    expect(asked.info.credentialMode).toEqual({
      model: null,
      forge: "none",
      reviewer: "none",
    });
  }, 30_000);

  it("names ANTHROPIC_API_KEY as the credential mode on an inferred anthropic boot, never its value", async () => {
    const { code, output, asked } = await boot(
      { ANTHROPIC_API_KEY: KEY, ...SECRETS },
      getServerInfo,
    );
    expect(code, output).toBeNull();
    if (asked === undefined) throw new Error("the boot never answered");
    const { info, wire } = asked;
    expect(info.backend).toBe("anthropic");
    expect(info.selectedBy).toBe("credential");
    expect(info.credentialMode.model).toEqual({
      source: "ANTHROPIC_API_KEY",
      type: "api_key",
    });
    expect(info.defaultModel).toMatch(/^anthropic\//);
    for (const secret of [KEY, ...Object.values(SECRETS)]) {
      expect(wire).not.toContain(secret);
    }
  }, 30_000);

  it("answers the DEFAULT_MODEL a deployment set as its defaultModel, on either backend (LOB-274)", async () => {
    const faux = await boot(
      { MODEL_BACKEND: "faux", DEFAULT_MODEL: "faux/faux-cheap" },
      getServerInfo,
    );
    expect(faux.code, faux.output).toBeNull();
    if (faux.asked === undefined) throw new Error("the boot never answered");
    expect(faux.asked.info.defaultModel).toBe("faux/faux-cheap");
    // Published beside the backend's own, which stays servable to a session that names it.
    expect(faux.asked.info.models).toEqual(["faux/faux-1", "faux/faux-cheap"]);
    expect(faux.output).toContain(
      "default model: faux/faux-cheap (DEFAULT_MODEL)",
    );

    const anthropic = await boot(
      { ANTHROPIC_API_KEY: KEY, DEFAULT_MODEL: "anthropic/claude-haiku-4-5" },
      getServerInfo,
    );
    expect(anthropic.code, anthropic.output).toBeNull();
    if (anthropic.asked === undefined)
      throw new Error("the boot never answered");
    expect(anthropic.asked.info.defaultModel).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(anthropic.asked.wire).not.toContain(KEY);

    // Unset, the backend's own model, and the boot says where it came from.
    const unset = await boot({ MODEL_BACKEND: "faux" }, getServerInfo);
    expect(unset.asked?.info.defaultModel).toBe("faux/faux-1");
    expect(unset.output).toContain(
      "default model: faux/faux-1 (the faux backend's own; DEFAULT_MODEL unset)",
    );
  }, 60_000);

  it("serves an OpenAI-compatible endpoint's models beside the backend's, and the ROLE_FALLBACKS chains, without reading its key (S-model-provider-breadth)", async () => {
    const COMPAT_KEY = "dummy-compat-key-boot-s-model-provider-breadth";
    const { code, output, asked } = await boot(
      {
        MODEL_BACKEND: "faux",
        OPENAI_COMPATIBLE_BASE_URL: "http://user:pw@127.0.0.1:1/v1?key=q",
        OPENAI_COMPATIBLE_MODELS: "compat-1,compat-2",
        OPENAI_COMPATIBLE_API_KEY: COMPAT_KEY,
        ROLE_MODELS: "builder=openai-compatible/compat-1",
        ROLE_FALLBACKS:
          "builder=faux/faux-backup|openai-compatible/compat-2,reviewer=openai-compatible/compat-1",
      },
      getServerInfo,
    );
    expect(code, output).toBeNull();
    if (asked === undefined) throw new Error("the boot never answered");
    expect(asked.info.models).toEqual([
      "faux/faux-1",
      "faux/faux-backup",
      "openai-compatible/compat-1",
      "openai-compatible/compat-2",
    ]);
    expect(asked.info.roleModels).toEqual([
      { role: "builder", model: "openai-compatible/compat-1" },
    ]);
    expect(asked.info.roleFallbacks).toEqual([
      {
        role: "builder",
        models: ["faux/faux-backup", "openai-compatible/compat-2"],
      },
      { role: "reviewer", models: ["openai-compatible/compat-1"] },
    ]);
    // The boot names the endpoint without its userinfo or query, and the key by its variable.
    expect(output).toContain(
      "second provider: openai-compatible at http://127.0.0.1:1/v1 serving compat-1, compat-2 (OPENAI_COMPATIBLE_BASE_URL; auth: OPENAI_COMPATIBLE_API_KEY)",
    );
    expect(output).toContain(
      "role fallbacks: builder → faux/faux-backup | openai-compatible/compat-2, reviewer → openai-compatible/compat-1",
    );
    for (const text of [output, asked.wire]) {
      expect(text).not.toContain(COMPAT_KEY);
      expect(text).not.toContain("user:pw");
    }
  }, 30_000);

  it.each([
    [
      "a fallback chain outside the catalog",
      { MODEL_BACKEND: "faux", ROLE_FALLBACKS: "builder=openai-compatible/x" },
      "builder's fallback chain names model openai-compatible/x",
    ],
    [
      "half an endpoint",
      { MODEL_BACKEND: "faux", OPENAI_COMPATIBLE_MODELS: "compat-1" },
      "OPENAI_COMPATIBLE_BASE_URL is not",
    ],
  ])(
    "refuses to boot on %s, naming it (S-model-provider-breadth)",
    async (_name, env, says) => {
      const { code, output } = await boot(env);
      expect(code, output).not.toBe(0);
      expect(code, output).not.toBeNull();
      expect(output).toContain(says);
    },
    30_000,
  );

  it("refuses to boot on a DEFAULT_MODEL outside the catalog, naming it", async () => {
    for (const [env, key] of [
      [
        { ANTHROPIC_API_KEY: KEY, DEFAULT_MODEL: "anthropic/claude-nope-9" },
        "anthropic/claude-nope-9",
      ],
      // Another backend's model: a faux process cannot serve it.
      [
        { MODEL_BACKEND: "faux", DEFAULT_MODEL: "anthropic/claude-haiku-4-5" },
        "anthropic/claude-haiku-4-5",
      ],
      [{ MODEL_BACKEND: "faux", DEFAULT_MODEL: "haiku" }, "haiku"],
    ] as const) {
      const { code, output } = await boot(env);
      expect(code, output).not.toBeNull();
      expect(code, output).not.toBe(0);
      expect(output).toContain("InvalidDefaultModel");
      expect(output).toContain(`DEFAULT_MODEL names model ${key}`);
      expect(output).not.toContain(LISTENING);
      expect(output).not.toContain(KEY);
    }
  }, 90_000);
});

/**
 * `checkDeployment` against the real boot (E8): what `factory doctor` reads of a process that is up
 * while Postgres is not. The registry cannot be read here, which is the case the RPC exists to
 * answer: the boot's own facts (the rules `TRIGGER_RULES` mapped, the env files it loaded) still
 * arrive, and the registry's failure arrives as `reposError` rather than as a failed call.
 */
describe("checkDeployment on a booted API (E8)", () => {
  const TOKEN = "dummy-github-token-boot-e8-0123456789";

  const checkDeployment = (url: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${url}/rpc`).pipe(
          HttpClientRequest.bodyText(
            `${JSON.stringify({ _tag: "Request", id: "1", tag: "checkDeployment", payload: {}, headers: [] })}\n`,
            "application/ndjson",
          ),
        ),
      );
      return yield* response.text;
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

  it("answers the mapped trigger rules and, with the registry down, reposError, and never a credential", async () => {
    const { code, output, asked } = await boot(
      {
        MODEL_BACKEND: "faux",
        GITHUB_TOKEN: TOKEN,
        TRIGGER_RULES: JSON.stringify([
          {
            label: "factory",
            repo: "acme/x",
            baseRef: "main",
            prompt: "{{title}}",
          },
        ]),
      },
      checkDeployment,
    );
    expect(code, output).toBeNull();
    if (asked === undefined) throw new Error("the boot never answered");
    const line = asked.split("\n").find((text) => text.includes('"Exit"'));
    const exit = JSON.parse(line ?? "{}").exit;
    expect(exit._tag, asked).toBe("Success");
    expect(exit.value.triggerRules).toBe(1);
    // `--no-env-file`: the process loaded no file, and says so.
    expect(exit.value.envFiles).toEqual([]);
    expect(exit.value.repos).toEqual([]);
    expect(typeof exit.value.reposError).toBe("string");
    expect(asked).not.toContain(TOKEN);
    // No `SETUP_TIMEOUT_SECONDS`: the harness's default bound.
    expect(exit.value.setupTimeoutSeconds).toBe(1_800);
  }, 30_000);

  it("reports the SETUP_TIMEOUT_SECONDS the deployment set, and refuses a malformed one at boot (F24)", async () => {
    const { code, output, asked } = await boot(
      { MODEL_BACKEND: "faux", SETUP_TIMEOUT_SECONDS: "5400" },
      checkDeployment,
    );
    expect(code, output).toBeNull();
    const line = asked?.split("\n").find((text) => text.includes('"Exit"'));
    expect(JSON.parse(line ?? "{}").exit.value.setupTimeoutSeconds).toBe(5400);
    for (const bad of ["0", "soon", "-1"]) {
      const refused = await boot({
        MODEL_BACKEND: "faux",
        SETUP_TIMEOUT_SECONDS: bad,
      });
      expect(refused.code, refused.output).not.toBeNull();
      expect(refused.code, refused.output).not.toBe(0);
      expect(refused.output).toContain("SETUP_TIMEOUT_SECONDS");
      expect(refused.output).not.toContain(LISTENING);
    }
  }, 90_000);
});

/**
 * Control-plane identity on the real boot (LOB-20): `index.ts` reads the token table from its
 * environment, says which mode it runs in, refuses a table it cannot trust, and serves `/rpc` behind
 * the middleware — read here as raw NDJSON, so the refusal is the typed `Unauthenticated` a client
 * decodes, not a transport error. No database is reachable, and `getServerInfo` needs none.
 */
describe("control-plane auth on a booted API (LOB-20)", () => {
  const TOKEN = "boot-shared-token-lob20-0123456789";

  /** One `getServerInfo` request over raw NDJSON, with `authorization` when given; the body. */
  const askWith = (authorization: string | undefined) => (url: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${url}/rpc`).pipe(
          HttpClientRequest.bodyText(
            `${JSON.stringify({ _tag: "Request", id: "1", tag: "getServerInfo", payload: {}, headers: [] })}\n`,
            "application/ndjson",
          ),
          authorization === undefined
            ? (request) => request
            : HttpClientRequest.setHeader("authorization", authorization),
        ),
      );
      return yield* response.text;
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

  it("refuses an RPC with no credential as Unauthenticated, serves the token, and never logs it", async () => {
    const missing = await boot(
      { MODEL_BACKEND: "faux", FACTORY_API_TOKEN: TOKEN },
      askWith(undefined),
    );
    const served = await boot(
      { MODEL_BACKEND: "faux", FACTORY_API_TOKEN: TOKEN },
      askWith(`Bearer ${TOKEN}`),
    );

    expect(missing.code, missing.output).toBeNull();
    expect(missing.output).toContain(
      "control-plane auth: bearer token on every RPC, 1 credential(s) for operator",
    );
    expect(missing.asked).toContain('"_tag":"Unauthenticated"');
    expect(missing.asked).toContain('"reason":"missing"');
    expect(served.asked).toContain('"backend":"faux"');
    expect(served.asked).not.toContain("Unauthenticated");
    for (const output of [missing.output, served.output]) {
      expect(output).not.toContain(TOKEN);
    }
  }, 30_000);

  it("warns that auth is off when no token is configured, and serves an unauthenticated call", async () => {
    const { code, output, asked } = await boot(
      { MODEL_BACKEND: "faux" },
      askWith(undefined),
    );
    expect(code, output).toBeNull();
    expect(output).toContain("control-plane auth: OFF");
    expect(asked).toContain('"backend":"faux"');
  }, 30_000);

  it("exits non-zero on a token table it cannot trust, naming the actor and never the token", async () => {
    const { code, output } = await boot({
      MODEL_BACKEND: "faux",
      FACTORY_API_TOKENS: `trigger:linear=${TOKEN}`,
    });
    expect(code, output).not.toBeNull();
    expect(code, output).not.toBe(0);
    expect(output).toContain("InvalidApiTokens");
    expect(output).toContain("FACTORY_API_TOKENS entry 1");
    expect(output).toContain("trigger's actor");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(LISTENING);
  }, 30_000);

  it("refuses to serve an open control plane beyond loopback, unless FACTORY_API_AUTH=off says so", async () => {
    const refused = await boot({ MODEL_BACKEND: "faux", HOST: "0.0.0.0" });
    const intended = await boot(
      { MODEL_BACKEND: "faux", HOST: "0.0.0.0", FACTORY_API_AUTH: "off" },
      askWith(undefined),
    );
    const secured = await boot(
      { MODEL_BACKEND: "faux", HOST: "0.0.0.0", FACTORY_API_TOKEN: TOKEN },
      askWith(`Bearer ${TOKEN}`),
    );

    expect(refused.code, refused.output).not.toBeNull();
    expect(refused.code, refused.output).not.toBe(0);
    expect(refused.output).toContain("ApiAuthRequired");
    expect(refused.output).toContain("HOST=0.0.0.0");
    expect(refused.output).not.toContain(LISTENING);
    expect(intended.code, intended.output).toBeNull();
    expect(intended.output).toContain("control-plane auth: OFF");
    expect(intended.asked).toContain('"backend":"faux"');
    expect(secured.code, secured.output).toBeNull();
    expect(secured.asked).toContain('"backend":"faux"');
  }, 60_000);
});
