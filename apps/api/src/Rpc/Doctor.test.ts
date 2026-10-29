/**
 * `checkDeployment` and `pingModel` over the wire (E8): what `factory doctor` asks of the control
 * plane beyond `getServerInfo`.
 *
 * The handlers are served by this app's own code through `HttpRouter.toWebHandler` and called with
 * the `RpcClient` the CLI builds. Every response body is kept as the bytes that crossed the wire, so
 * "no credential in the answer" is a substring check over everything a client received. The checkout
 * is a real repository in a temp directory; the registry and the credential provider are fakes, and
 * the model is pi-ai's faux provider, whose call count is the witness for "spends nothing".
 */
import {
  CredentialError,
  CredentialProvider,
  type CredentialProviderShape,
  SessionService,
  type SessionServiceShape,
} from "@repo/core";
import { DoctorRpc } from "@repo/domain/Rpc";
import { SessionError, type RepoSummary } from "@repo/domain/Session";
import {
  createFauxModelAccess,
  type ModelAccess,
  parseRoleModels,
  resolveRoleModels,
} from "@repo/harness";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ServerFacts, type ServerFactsShape } from "../ServerInfo";
import { DoctorRpcHandlers } from "./Doctor";
import {
  sendingToken,
  TEST_TOKEN,
  TestControlPlaneAuth,
} from "./Auth.test-fake";

/** A dummy credential, distinct, so a leak is unmistakable. */
const FORGE_TOKEN = "dummy-forge-token-e8-0123456789";

const checkout = mkdtempSync(join(tmpdir(), "factory-doctor-"));
execSync(
  "git init -q -b main && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m first",
  { cwd: checkout, stdio: "ignore" },
);
const workTree = realpathSync(checkout);

const repo = (extra: Partial<typeof RepoSummary.Encoded>): RepoSummary =>
  Schema.decodeSync(
    Schema.Struct({
      repo: Schema.String,
      url: Schema.String,
      defaultBaseRef: Schema.String,
      registeredAt: Schema.String,
      localPathIsGit: Schema.Boolean,
      hasFactoryConfig: Schema.Boolean,
      localPath: Schema.optional(Schema.String),
      workTree: Schema.optional(Schema.String),
    }),
  )({
    repo: "acme/x",
    url: "",
    defaultBaseRef: "main",
    registeredAt: "2026-10-28T10:00:00.000Z",
    localPathIsGit: true,
    hasFactoryConfig: true,
    localPath: workTree,
    workTree,
    ...extra,
  }) as unknown as RepoSummary;

const factsWith = (
  model: ModelAccess,
  extra: Partial<ServerFactsShape> = {},
): Effect.Effect<ServerFactsShape> =>
  Effect.gen(function* () {
    const choice = {
      backend: model.backend,
      selectedBy: "MODEL_BACKEND",
      reason: "model backend: faux (selected by MODEL_BACKEND)",
      credential: null,
    } as unknown as ServerFactsShape["choice"];
    return {
      choice,
      model,
      roleModels: yield* resolveRoleModels(model, yield* parseRoleModels("")),
      approvalRequired: [],
      defaultBudget: Option.none(),
      webhooks: [],
      githubTokenSet: true,
      linearStates: undefined,
      reviewer: "none",
      sandbox: "in-process",
      triggerRules: 3,
      envFiles: ["/work/factory/.env"],
      setupTimeoutSeconds: 1_800,
      ...extra,
    } satisfies ServerFactsShape;
  }).pipe(Effect.orDie);

const tokenProvider = (
  source: CredentialProviderShape["source"],
  tokenFor: CredentialProviderShape["tokenFor"],
): CredentialProviderShape => ({ source, tokenFor });

const resolvesToken = tokenProvider("static-token", () =>
  Effect.succeed(Redacted.make(FORGE_TOKEN)),
);

/** Serve `DoctorRpc` over the given fakes, run `use` against it, and keep the bytes sent back. */
const ask = async <A>(
  deps: {
    readonly facts: ServerFactsShape;
    readonly credentials: CredentialProviderShape;
    readonly repos: Effect.Effect<
      { readonly repos: ReadonlyArray<RepoSummary> },
      SessionError
    >;
  },
  use: (client: {
    readonly checkDeployment: (input: {
      readonly repo?: string;
    }) => Effect.Effect<unknown>;
    readonly pingModel: (input: {}) => Effect.Effect<unknown>;
  }) => Effect.Effect<A>,
) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: DoctorRpc,
      path: "/rpc",
      protocol: "http",
    }).pipe(
      Layer.provide(DoctorRpcHandlers),
      Layer.provide(
        Layer.mergeAll(
          TestControlPlaneAuth,
          Layer.succeed(ServerFacts, deps.facts),
          Layer.succeed(
            CredentialProvider,
            CredentialProvider.of(deps.credentials),
          ),
          Layer.succeed(SessionService, {
            listRepos: deps.repos,
          } as unknown as SessionServiceShape),
        ),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
    { disableLogger: true },
  );
  const bodies: string[] = [];
  const protocol = RpcClient.layerProtocolHttp({
    url: "http://factory.test/rpc",
    transformClient: sendingToken(TEST_TOKEN),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, signal) =>
          HttpClientRequest.toWeb(request, { signal }).pipe(
            Effect.flatMap((web) =>
              Effect.promise(async () => {
                const response = await handler(web);
                bodies.push(await response.clone().text());
                return response;
              }),
            ),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, response),
            ),
            Effect.orDie,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerNdjson),
  );
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(DoctorRpc);
          return yield* use(client as never);
        }),
      ).pipe(Effect.provide(protocol)),
    );
    return { result, wire: bodies.join("\n") };
  } finally {
    await dispose();
  }
};

const registry = (rows: ReadonlyArray<RepoSummary>) =>
  Effect.succeed({ repos: rows });

describe("checkDeployment over RPC (E8)", () => {
  it("answers the boot's trigger rules and env files, and one row per repo with its base ref and forge check", async () => {
    const faux = createFauxModelAccess();
    const { result } = (await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: resolvesToken,
        repos: registry([
          repo({}),
          repo({ repo: "acme/y", defaultBaseRef: "trunk" }),
        ]),
      },
      (client) => client.checkDeployment({}),
    )) as { result: any; wire: string };

    expect(result.triggerRules).toBe(3);
    expect(result.envFiles).toEqual(["/work/factory/.env"]);
    expect(result.reposError).toBeUndefined();
    const [x, y] = result.repos;
    expect(x.repo).toBe("acme/x");
    expect(x.baseRef).toMatchObject({ ref: "main", status: "ok" });
    expect(x.forge).toEqual({
      mode: "static-token",
      status: "ok",
      message: "static-token resolves a token for acme/x",
    });
    // Mutation: report the default base ref as resolved without asking the checkout.
    expect(y.baseRef).toMatchObject({ ref: "trunk", status: "unresolved" });
  });

  /** Mutation: put the token into the message, or into any field. */
  it("carries no credential: the forge token never reaches the client", async () => {
    const faux = createFauxModelAccess();
    const { wire } = await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: resolvesToken,
        repos: registry([repo({})]),
      },
      (client) => client.checkDeployment({}),
    );
    expect(wire).toContain("acme/x");
    expect(wire).not.toContain(FORGE_TOKEN);
  });

  it("says `none` and `missing` for a deployment with no GITHUB_TOKEN, and `failed` for an App that cannot mint", async () => {
    const faux = createFauxModelAccess();
    const noToken = tokenProvider("static-token", (slug) =>
      Effect.fail(
        new CredentialError({
          repo: slug,
          code: "missing",
          message: `no GITHUB_TOKEN configured; cannot resolve a token for ${slug}`,
        }),
      ),
    );
    const missing = (await ask(
      {
        facts: await Effect.runPromise(
          factsWith(faux.access, { githubTokenSet: false }),
        ),
        credentials: noToken,
        repos: registry([repo({})]),
      },
      (client) => client.checkDeployment({}),
    )) as { result: any; wire: string };
    expect(missing.result.repos[0].forge).toMatchObject({
      mode: "none",
      status: "missing",
    });

    const app = tokenProvider("github-app", (slug) =>
      Effect.fail(
        new CredentialError({
          repo: slug,
          code: "failed",
          message: `GitHub App token for ${slug} failed: GitHub answered HTTP 401`,
        }),
      ),
    );
    const failed = (await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: app,
        repos: registry([repo({})]),
      },
      (client) => client.checkDeployment({}),
    )) as { result: any; wire: string };
    expect(failed.result.repos[0].forge).toMatchObject({
      mode: "github-app",
      status: "failed",
    });
    expect(failed.result.repos[0].forge.message).toContain("HTTP 401");
  });

  /** Mutation: let the registry's failure fail the RPC, so a doctor run with Postgres down loses every other answer. */
  it("answers with the registry's error when Postgres is down, keeping the boot facts", async () => {
    const faux = createFauxModelAccess();
    const { result } = (await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: resolvesToken,
        repos: Effect.fail(
          new SessionError({ code: "storage", message: "connection refused" }),
        ),
      },
      (client) => client.checkDeployment({}),
    )) as { result: any; wire: string };
    expect(result.repos).toEqual([]);
    expect(result.reposError).toBe("connection refused");
    expect(result.triggerRules).toBe(3);
  });

  /** Mutation: ignore the repo filter, so a scoped run mints a token for every registered repo. */
  it("checks only the repo it is asked about", async () => {
    const faux = createFauxModelAccess();
    const minted: string[] = [];
    const counting = tokenProvider("static-token", (slug) => {
      minted.push(slug);
      return Effect.succeed(Redacted.make(FORGE_TOKEN));
    });
    const { result } = (await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: counting,
        repos: registry([repo({}), repo({ repo: "acme/y" })]),
      },
      (client) => client.checkDeployment({ repo: "acme/y" }),
    )) as { result: any; wire: string };
    expect(minted).toEqual(["acme/y"]);
    expect(result.repos.map((row: { repo: string }) => row.repo)).toEqual([
      "acme/y",
    ]);
  });

  /** Mutation: no bound on the mint, so one stalled provider hangs the whole command. */
  it("answers a stalled token mint as a failed forge check instead of hanging", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const faux = createFauxModelAccess();
      const stalled = tokenProvider("github-app", () => Effect.never);
      const pending = ask(
        {
          facts: await Effect.runPromise(factsWith(faux.access)),
          credentials: stalled,
          repos: registry([repo({})]),
        },
        (client) => client.checkDeployment({}),
      );
      await vi.advanceTimersByTimeAsync(25_000);
      const { result } = (await pending) as { result: any; wire: string };
      expect(result.repos[0].forge).toMatchObject({
        mode: "github-app",
        status: "failed",
        message: "no answer within 20s",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /** "Without --live, spend is unchanged": checking a deployment never calls the model. */
  it("makes no model request", async () => {
    const faux = createFauxModelAccess();
    await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: resolvesToken,
        repos: registry([repo({})]),
      },
      (client) => client.checkDeployment({}),
    );
    expect(faux.faux.state.callCount).toBe(0);
  });
});

describe("pingModel over RPC (E8)", () => {
  it("makes exactly one request to the default model and reports its answer", async () => {
    const faux = createFauxModelAccess();
    const { result } = (await ask(
      {
        facts: await Effect.runPromise(factsWith(faux.access)),
        credentials: resolvesToken,
        repos: registry([]),
      },
      (client) => client.pingModel({}),
    )) as { result: any; wire: string };
    expect(faux.faux.state.callCount).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.model).toBe("faux/faux-1");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /** Mutation: let a provider's refusal fail the RPC, so the operator never reads why. */
  it("answers a provider's refusal as ok: false with its message", async () => {
    const faux = createFauxModelAccess();
    const refusing: ModelAccess = {
      ...faux.access,
      models: new Proxy(faux.access.models, {
        get: (target, property) =>
          property === "completeSimple"
            ? () => Promise.reject(new Error("401 invalid x-api-key"))
            : Reflect.get(target, property),
      }),
    };
    const { result } = (await ask(
      {
        facts: await Effect.runPromise(factsWith(refusing)),
        credentials: resolvesToken,
        repos: registry([]),
      },
      (client) => client.pingModel({}),
    )) as { result: any; wire: string };
    expect(result).toMatchObject({
      ok: false,
      message: "401 invalid x-api-key",
      costUsd: 0,
    });
  });

  /** Mutation: no signal and no bound, so a provider that never answers hangs `doctor --live`. */
  it("answers a provider that never replies as a refusal, and aborts the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const faux = createFauxModelAccess();
      let aborted = false;
      const hanging: ModelAccess = {
        ...faux.access,
        models: new Proxy(faux.access.models, {
          get: (target, property) =>
            property === "completeSimple"
              ? (
                  _model: unknown,
                  _context: unknown,
                  options?: { signal?: AbortSignal },
                ) =>
                  // oxlint-disable-next-line effecttsgo/new-promise -- a provider that never answers is a promise that never settles.
                  new Promise(() => {
                    options?.signal?.addEventListener("abort", () => {
                      aborted = true;
                    });
                  })
              : Reflect.get(target, property),
        }),
      };
      const pending = ask(
        {
          facts: await Effect.runPromise(factsWith(hanging)),
          credentials: resolvesToken,
          repos: registry([]),
        },
        (client) => client.pingModel({}),
      );
      await vi.advanceTimersByTimeAsync(35_000);
      const { result } = (await pending) as { result: any; wire: string };
      expect(result).toMatchObject({
        ok: false,
        message: "no answer within 30s",
      });
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a default model this process does not serve, without calling anything", async () => {
    const faux = createFauxModelAccess();
    const { result } = (await ask(
      {
        facts: await Effect.runPromise(
          factsWith({ ...faux.access, modelId: "gone" }),
        ),
        credentials: resolvesToken,
        repos: registry([]),
      },
      (client) => client.pingModel({}),
    )) as { result: any; wire: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("faux/gone");
    expect(faux.faux.state.callCount).toBe(0);
  });
});
