/**
 * `getServerInfo` over the wire (LOB-269).
 *
 * The facts are resolved the way `index.ts` resolves them at boot — `selectModelBackend` over a
 * credential lookup, `ROLE_MODELS` parsed and resolved against the backend's catalog — and served by
 * this app's own handler through `HttpRouter.toWebHandler`, called with the `RpcClient` over NDJSON
 * the CLI and the dashboard build. The response body is also kept as the bytes that crossed the
 * wire, so "no secret in the answer" is a substring check over everything a client received, not
 * over the fields a decoder happened to keep. Nothing here reads the process environment or reaches
 * a provider: the lookup is a record, and every credential in it is a dummy.
 *
 * `boot.test.ts` drives the same RPC against the real `index.ts`, booted from an environment.
 */
import type { CredentialSource } from "@repo/core";
import { CredentialProvider } from "@repo/core";
import { ServerRpc } from "@repo/domain/Rpc";
import {
  type AuthContext,
  createModelAccess,
  FAUX_MODEL_ID,
  parseRoleModels,
  resolveRoleModels,
} from "@repo/harness";
import { Effect, Layer, Option } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { selectModelBackend } from "../ModelBackend";
import {
  ServerFacts,
  type ServerFactsShape,
  webhookRouteStates,
} from "../ServerInfo";
import { ServerRpcHandlers } from "./Server";
import {
  sendingToken,
  TEST_TOKEN,
  TestControlPlaneAuth,
} from "./Auth.test-fake";

/** Dummy credentials, each distinct, so a leak names which one leaked. */
const ANTHROPIC_KEY = "sk-ant-dummy-lob269-0123456789abcdef";
const WEBHOOK_SECRETS = {
  LINEAR_WEBHOOK_SECRET: "dummy-linear-webhook-secret-lob269",
  GITHUB_WEBHOOK_SECRET: "dummy-github-webhook-secret-lob269",
};
const FORGE_TOKEN = "dummy-forge-token-lob269";

/** A credential lookup over `env` alone: what pi-ai would read from the process environment. */
const lookup = (env: Readonly<Record<string, string>>): AuthContext => ({
  env: async (name) => env[name],
  fileExists: async () => false,
});

/**
 * The boot's facts for one environment, resolved as `index.ts` resolves them: the backend from
 * `MODEL_BACKEND` and the credential lookup, the faux catalog widened by every `faux/<id>` the role
 * table names, and the table resolved against that catalog.
 */
const factsFor = (input: {
  readonly forced: "anthropic" | "faux" | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly roleModels: string;
  /** Whether `GITHUB_TOKEN` is set; set unless a case says otherwise. */
  readonly githubTokenSet?: boolean;
}) =>
  Effect.gen(function* () {
    const choice = yield* selectModelBackend({
      forced: Option.fromUndefinedOr(input.forced),
      authContext: lookup(input.env),
    });
    const declared = yield* parseRoleModels(input.roleModels);
    const fauxModels = [
      FAUX_MODEL_ID,
      ...[...declared.values()]
        .filter((key) => key.startsWith("faux/"))
        .map((key) => key.slice("faux/".length)),
    ];
    const model = createModelAccess(choice.backend, {
      fauxModels,
      authContext: lookup(input.env),
    });
    return {
      choice,
      model,
      roleModels: yield* resolveRoleModels(model, declared),
      approvalRequired: ["npm publish", "terraform apply"],
      defaultBudget: Option.some(5),
      webhooks: webhookRouteStates(input.env),
      githubTokenSet: input.githubTokenSet ?? true,
      linearStates: { started: "Doing", inReview: "Review", done: "Shipped" },
      reviewer: "token",
      sandbox: "in-process",
      triggerRules: 0,
      envFiles: [],
      setupTimeoutSeconds: 1_800,
    } satisfies ServerFactsShape;
  }).pipe(Effect.runPromise);

/** Serve `ServerRpc` over `facts`, call `getServerInfo` once, and keep the bytes that came back. */
const ask = async (facts: ServerFactsShape, forge: CredentialSource) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: ServerRpc,
      path: "/rpc",
      protocol: "http",
    }).pipe(
      Layer.provide(ServerRpcHandlers),
      Layer.provide(
        Layer.mergeAll(
          TestControlPlaneAuth,
          Layer.succeed(ServerFacts, facts),
          Layer.succeed(
            CredentialProvider,
            CredentialProvider.of({
              source: forge,
              tokenFor: () =>
                Effect.die(`no token is asked for: ${FORGE_TOKEN}`),
            }),
          ),
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
    const info = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(ServerRpc);
          return yield* client.getServerInfo({});
        }),
      ).pipe(Effect.provide(protocol)),
    );
    return { info, wire: bodies.join("\n") };
  } finally {
    await dispose();
  }
};

describe("getServerInfo over RPC (LOB-269)", () => {
  it("answers backend faux, its default model and the role models ROLE_MODELS names, under MODEL_BACKEND=faux", async () => {
    const { info } = await ask(
      await factsFor({
        forced: "faux",
        // A key that is set is not in use under a forced faux, so it is not the credential mode.
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        roleModels: "specifier=faux/faux-spec,reviewer=faux/faux-review",
      }),
      "static-token",
    );

    expect(info.backend).toBe("faux");
    expect(info.selectedBy).toBe("MODEL_BACKEND");
    expect(info.reason).toBe("model backend: faux (selected by MODEL_BACKEND)");
    expect(info.warnings.length).toBeGreaterThan(0);
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
    expect(info.credentialMode).toEqual({
      model: null,
      forge: "static-token",
      reviewer: "token",
    });
    expect(info.approvalRequired).toEqual(["npm publish", "terraform apply"]);
    expect(info.defaultBudget).toBe(5);
    expect(info.sandbox).toBe("in-process");
  });

  it("names the variable that authenticated anthropic, and no credential's value appears anywhere in the answer", async () => {
    const { info, wire } = await ask(
      await factsFor({
        forced: undefined,
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, ...WEBHOOK_SECRETS },
        roleModels: "",
      }),
      "github-app",
    );

    expect(info.backend).toBe("anthropic");
    expect(info.selectedBy).toBe("credential");
    expect(info.credentialMode.model).toEqual({
      source: "ANTHROPIC_API_KEY",
      type: "api_key",
    });
    expect(info.credentialMode.forge).toBe("github-app");
    expect(info.defaultModel).toMatch(/^anthropic\//);
    expect(info.models).toContain(info.defaultModel);
    expect(info.warnings).toEqual([]);
    expect(info.webhooks).toEqual([
      {
        route: "/webhooks/linear",
        armed: true,
        variable: "LINEAR_WEBHOOK_SECRET",
      },
      { route: "/webhooks/generic", armed: false, variable: "TRIGGER_SECRET" },
      {
        route: "/webhooks/sentry",
        armed: false,
        variable: "SENTRY_CLIENT_SECRET",
      },
      {
        route: "/webhooks/github",
        armed: true,
        variable: "GITHUB_WEBHOOK_SECRET",
      },
      {
        route: "/webhooks/jira",
        armed: false,
        variable: "JIRA_WEBHOOK_SECRET",
      },
      {
        route: "/webhooks/slack",
        armed: false,
        variable: "SLACK_SIGNING_SECRET",
      },
    ]);
    expect(info.linearWriteBack).toEqual({
      enabled: true,
      states: { started: "Doing", inReview: "Review", done: "Shipped" },
    });
    // Every byte the client received, not only the decoded fields: the answer crossed the wire.
    expect(wire).toContain("ANTHROPIC_API_KEY");
    for (const secret of [
      ANTHROPIC_KEY,
      ...Object.values(WEBHOOK_SECRETS),
      FORGE_TOKEN,
    ]) {
      expect(wire).not.toContain(secret);
      expect(JSON.stringify(info)).not.toContain(secret);
    }
  });

  it("says faux was chosen because no credential resolved, with the warning that says how to fix it", async () => {
    const { info } = await ask(
      await factsFor({ forced: undefined, env: {}, roleModels: "" }),
      "static-token",
    );

    expect(info.backend).toBe("faux");
    expect(info.selectedBy).toBe("no_credential");
    expect(info.reason).toBe(
      "model backend: faux (no Anthropic credential resolved)",
    );
    expect(info.warnings.join("\n")).toContain("ANTHROPIC_API_KEY");
    expect(info.roleModels).toEqual([]);
    expect(info.models).toEqual(["faux/faux-1"]);
    expect(info.webhooks.every((route) => !route.armed)).toBe(true);
  });

  it("reports the forge as none when the static-token provider has no GITHUB_TOKEN behind it, and a GitHub App as itself", async () => {
    const unset = await factsFor({
      forced: "faux",
      env: {},
      roleModels: "",
      githubTokenSet: false,
    });
    expect((await ask(unset, "static-token")).info.credentialMode.forge).toBe(
      "none",
    );
    // An App needs no static token: its source is what is in use.
    expect((await ask(unset, "github-app")).info.credentialMode.forge).toBe(
      "github-app",
    );
  });
});
