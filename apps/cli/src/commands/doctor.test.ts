/**
 * `factory doctor`'s verdicts (LOB-265): which registry rows can cut a worktree, and the fix the
 * others print. The command itself — clone a URL-only repo, report a clone that fails — is proven by
 * `.pi/skills/verify-cli/clone.sh` against a real control plane.
 */
import { Effect, Schema } from "effect";
import {
  DeploymentChecks,
  ModelPing,
  type RepoCheck,
  ServerInfo,
} from "@repo/domain/Server";
import { type RepoSlug, RepoSummary } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import {
  collectChecks,
  type DoctorCheck,
  type DoctorClient,
  type DoctorOptions,
  diagnoseRow,
  formatCheck,
  liveCheck,
  type Probe,
  verdict,
} from "./doctor";

const summary = (
  extra: Partial<typeof RepoSummary.Encoded> = {},
): RepoSummary =>
  Schema.decodeSync(RepoSummary)({
    repo: "acme/x",
    url: "",
    defaultBaseRef: "main",
    registeredAt: "2026-10-28T10:00:00.000Z",
    localPathIsGit: false,
    hasFactoryConfig: false,
    ...extra,
  });

describe("diagnoseRow", () => {
  it("is ok for a checkout inside a git work tree", () => {
    expect(
      diagnoseRow(summary({ localPath: "/src/x", localPathIsGit: true })),
    ).toEqual({ ok: true, detail: "checkout /src/x" });
  });

  it("is ok for a URL-only repo whose clone exists", () => {
    expect(
      diagnoseRow(
        summary({
          url: "https://github.com/acme/x.git",
          mirrorPath: "/s/.cache/acme/x.git",
        }),
      ),
    ).toEqual({ ok: true, detail: "cloned into /s/.cache/acme/x.git" });
  });

  it("fails a checkout that stopped being a work tree, with the path remedy", () => {
    expect(
      diagnoseRow(summary({ localPath: "/gone/x", localPathIsGit: false })),
    ).toEqual({
      ok: false,
      detail: "local checkout is not a git work tree",
      remedy: "factory repo add acme/x --path <dir>",
    });
  });

  it("fails a URL-only repo with no clone, naming the sync", () => {
    expect(
      diagnoseRow(summary({ url: "https://github.com/acme/x.git" })),
    ).toEqual({
      ok: false,
      detail: "not cloned yet",
      remedy: "factory repo sync acme/x",
    });
  });

  it("fails the auto-registered row: no URL and no checkout", () => {
    expect(diagnoseRow(summary())).toEqual({
      ok: false,
      detail: "no clone URL / no local checkout",
      remedy: "factory repo add acme/x --path <dir>",
    });
  });
});

// --- E8: the preflight ---------------------------------------------------------------------

const info = (extra: Partial<typeof ServerInfo.Encoded> = {}): ServerInfo =>
  Schema.decodeSync(ServerInfo)({
    backend: "faux",
    selectedBy: "MODEL_BACKEND",
    reason: "model backend: faux (selected by MODEL_BACKEND)",
    warnings: ["scripted"],
    defaultModel: "faux/faux-1",
    roleModels: [{ role: "specifier", model: "faux/faux-spec" }],
    models: ["faux/faux-1", "faux/faux-spec"],
    approvalRequired: [],
    credentialMode: { model: null, forge: "none", reviewer: "none" },
    webhooks: [
      {
        route: "/webhooks/github",
        armed: true,
        variable: "GITHUB_WEBHOOK_SECRET",
      },
      {
        route: "/webhooks/linear",
        armed: false,
        variable: "LINEAR_WEBHOOK_SECRET",
      },
    ],
    linearWriteBack: { enabled: false },
    sandbox: "in-process",
    ...extra,
  });

const deployment = (
  extra: Partial<typeof DeploymentChecks.Encoded> = {},
): DeploymentChecks =>
  Schema.decodeSync(DeploymentChecks)({
    triggerRules: 2,
    envFiles: ["/work/.env"],
    repos: [],
    ...extra,
  });

const ready: Probe = {
  kind: "answered",
  checks: [
    { name: "postgres", ok: true },
    { name: "migrations", ok: true },
    { name: "schema", ok: true },
  ],
};

/** A client that answers from the values given and counts every call, by name. */
const fakeClient = (answers: {
  readonly info?: ServerInfo;
  readonly deployment?: DeploymentChecks;
  readonly repos?: ReadonlyArray<RepoSummary>;
}) => {
  const calls: string[] = [];
  const client = {
    getServerInfo: () => {
      calls.push("getServerInfo");
      return Effect.succeed(answers.info ?? info());
    },
    listRepos: () => {
      calls.push("listRepos");
      return Effect.succeed({ repos: answers.repos ?? [] });
    },
    getRepo: ({ repo }: { readonly repo: string }) => {
      calls.push("getRepo");
      return Effect.succeed(
        answers.repos?.find((row) => row.repo === repo) ?? summary(),
      );
    },
    syncRepo: ({ repo }: { readonly repo: string }) => {
      calls.push("syncRepo");
      return Effect.succeed(
        answers.repos?.find((row) => row.repo === repo) ?? summary(),
      );
    },
    checkDeployment: () => {
      calls.push("checkDeployment");
      return Effect.succeed(answers.deployment ?? deployment());
    },
    pingModel: () => {
      calls.push("pingModel");
      return Effect.succeed(
        Schema.decodeSync(ModelPing)({
          model: "faux/faux-1",
          ok: true,
          message: 'answered "ok"',
          costUsd: 0.0002,
          inputTokens: 12,
          outputTokens: 1,
          latencyMs: 40,
        }),
      );
    },
  };
  return { client: client as unknown as DoctorClient, calls };
};

const run = (
  client: DoctorClient,
  probe: Probe = ready,
  extra: Partial<DoctorOptions> = {},
) =>
  Effect.runPromise(
    collectChecks(client, probe, {
      apiUrl: "http://localhost:9000",
      repo: undefined,
      live: false,
      ...extra,
    }),
  ).then((checks) => checks.map(formatCheck));

describe("collectChecks", () => {
  /** Mutation: treat faux as ok, or drop the `selected by` clause. */
  it("warns on a faux backend with what chose it", async () => {
    const lines = await run(fakeClient({}).client);
    expect(lines).toContain(
      "warn model: faux (selected by MODEL_BACKEND) -- fix: sessions answer from a script, not a model: set ANTHROPIC_API_KEY (see README, Model credentials) and unset MODEL_BACKEND",
    );
  });

  it("is ok on an anthropic backend and names how it authenticates", async () => {
    const lines = await run(
      fakeClient({
        info: info({
          backend: "anthropic",
          selectedBy: "credential",
          credentialMode: {
            model: { source: "ANTHROPIC_API_KEY", type: "api_key" },
            forge: "static-token",
            reviewer: "token",
          },
          defaultModel: "anthropic/claude-sonnet-5-5",
          roleModels: [],
          models: ["anthropic/claude-sonnet-5-5"],
        }),
      }).client,
    );
    expect(lines).toContain(
      "ok model: anthropic (a model credential resolved)",
    );
    expect(lines).toContain("ok model-auth: ANTHROPIC_API_KEY (api_key)");
  });

  /** Mutation: skip the role models, or check only the default. */
  it("fails a default or role model the backend does not serve", async () => {
    const lines = await run(
      fakeClient({
        info: info({
          defaultModel: "faux/gone",
          roleModels: [{ role: "reviewer", model: "faux/also-gone" }],
        }),
      }).client,
    );
    const models = lines.find((line) => line.startsWith("fail models:"));
    expect(models).toContain("default faux/gone");
    expect(models).toContain("reviewer=faux/also-gone");
  });

  /** Mutation: print `ok postgres` for a failed check, or lose the error. */
  it("fails postgres with the readiness error and how to start it", async () => {
    const lines = await run(fakeClient({}).client, {
      kind: "answered",
      checks: [
        { name: "postgres", ok: false, error: "connection refused" },
        { name: "migrations", ok: false, error: "no database" },
        { name: "schema", ok: false, error: "no database" },
      ],
    });
    expect(lines).toContain("ok api: http://localhost:9000 reachable");
    const postgres = lines.find((line) => line.startsWith("fail postgres:"));
    expect(postgres).toContain("connection refused");
    expect(postgres).toContain("docker compose up -d --wait postgres");
  });

  /** Mutation: continue past an unreachable API and call RPCs that cannot answer. */
  it("fails api with the URL it tried and asks nothing else", async () => {
    const { client, calls } = fakeClient({});
    const lines = await run(client, {
      kind: "unreachable",
      message: "connection refused",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^fail api: http:\/\/localhost:9000 is not reachable \(connection refused\) -- fix: /,
    );
    expect(calls).toEqual([]);
  });

  it("fails api when something else answers /readyz", async () => {
    const lines = await run(fakeClient({}).client, {
      kind: "unrecognized",
      status: 404,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fail api: http://localhost:9000");
    expect(lines[0]).toContain("HTTP 404");
  });

  /** Mutation: arm every route, or leave out the variable to set. */
  it("says which webhook routes are armed and which variable arms the rest", async () => {
    const lines = await run(fakeClient({}).client);
    expect(lines).toContain("ok webhook github: armed (GITHUB_WEBHOOK_SECRET)");
    const linear = lines.find((line) => line.startsWith("warn webhook linear"));
    expect(linear).toContain("LINEAR_WEBHOOK_SECRET");
  });

  it("counts the trigger rules and lists the env files the boot loaded", async () => {
    const lines = await run(fakeClient({}).client);
    expect(lines).toContain("ok trigger-rules: 2 mapped");
    expect(lines).toContain("ok env-files: /work/.env");
  });

  /** Mutation: warn on 0 rules even where no webhook can deliver. */
  it("warns on zero trigger rules only when a webhook is armed", async () => {
    const armed = await run(
      fakeClient({ deployment: deployment({ triggerRules: 0 }) }).client,
    );
    expect(
      armed.find((line) => line.startsWith("warn trigger-rules")),
    ).toBeDefined();
    const none = await run(
      fakeClient({
        deployment: deployment({ triggerRules: 0 }),
        info: info({ webhooks: [] }),
      }).client,
    );
    expect(none).toContain("ok trigger-rules: 0 mapped (no webhook is armed)");
  });

  /** Mutation: lose the registry's error, or report no repos instead of a failure. */
  it("fails repos with the registry's error when it could not be read", async () => {
    const lines = await run(
      fakeClient({
        deployment: deployment({ reposError: "connection refused" }),
      }).client,
    );
    const repos = lines.find((line) => line.startsWith("fail repos:"));
    expect(repos).toContain("connection refused");
  });

  describe("per repo", () => {
    const row = summary({
      localPath: "/src/x",
      localPathIsGit: true,
      workTree: "/src/x",
      hasFactoryConfig: true,
    });
    const server = (extra: Partial<typeof RepoCheck.Encoded> = {}) =>
      deployment({
        repos: [
          {
            repo: "acme/x",
            forge: {
              mode: "static-token",
              status: "ok",
              message: "static-token resolves a token for acme/x",
            },
            baseRef: {
              ref: "main",
              status: "ok",
              message: "main resolves to abc1234",
            },
            ...extra,
          },
        ],
      });

    it("is ok for a repo that can run: checkout, base ref, config and forge", async () => {
      const lines = await run(
        fakeClient({ repos: [row], deployment: server() }).client,
      );
      expect(lines).toContain("ok repo acme/x: checkout /src/x");
      expect(lines).toContain("ok base-ref acme/x: main resolves to abc1234");
      expect(lines).toContain("ok config acme/x: .factory/config found");
      expect(lines).toContain(
        "ok forge acme/x: static-token resolves a token for acme/x",
      );
    });

    /** Mutation: skip the base ref, or report an unresolved one as ok. */
    it("fails a base ref the checkout cannot resolve", async () => {
      const lines = await run(
        fakeClient({
          repos: [row],
          deployment: server({
            baseRef: {
              ref: "trunk",
              status: "unresolved",
              message: "no commit named trunk in /src/x",
            },
          }),
        }).client,
      );
      const line = lines.find((entry) =>
        entry.startsWith("fail base-ref acme/x"),
      );
      expect(line).toContain("no commit named trunk");
      expect(line).toContain("factory repo add acme/x --base-ref");
    });

    it("warns on a checkout with no .factory/config", async () => {
      const lines = await run(
        fakeClient({
          repos: [{ ...row, hasFactoryConfig: false }],
          deployment: server(),
        }).client,
      );
      expect(
        lines.find((entry) => entry.startsWith("warn config acme/x")),
      ).toContain("add .factory/config to /src/x");
    });

    /** Mutation: treat a missing credential as ok, or a failed mint as a mere warning. */
    it("warns on a missing forge credential and fails one that cannot mint a token", async () => {
      const missing = await run(
        fakeClient({
          repos: [row],
          deployment: server({
            forge: {
              mode: "none",
              status: "missing",
              message:
                "no GITHUB_TOKEN configured; cannot resolve a token for acme/x",
            },
          }),
        }).client,
      );
      expect(
        missing.find((entry) => entry.startsWith("warn forge acme/x")),
      ).toContain("set GITHUB_TOKEN");
      const failed = await run(
        fakeClient({
          repos: [row],
          deployment: server({
            forge: {
              mode: "github-app",
              status: "failed",
              message:
                "GitHub App token for acme/x failed: GitHub answered HTTP 401",
            },
          }),
        }).client,
      );
      expect(
        failed.find((entry) => entry.startsWith("fail forge acme/x")),
      ).toContain("HTTP 401");
    });

    /** Mutation: a repo the registry holds but cannot cut a worktree from is reported ok. */
    it("fails a repo with no checkout and names the command that fixes it", async () => {
      const lines = await run(
        fakeClient({
          repos: [summary()],
          deployment: server({
            baseRef: { ref: "main", status: "no_checkout", message: "nothing" },
          }),
        }).client,
      );
      expect(lines).toContain(
        "fail repo acme/x: no clone URL / no local checkout -- fix: factory repo add acme/x --path <dir>",
      );
      // The base ref has nothing to say about a repo with nothing to resolve it in.
      expect(lines.some((line) => line.includes("base-ref"))).toBe(false);
    });

    it("clones a URL-only repo before it asks about its base ref", async () => {
      const { client, calls } = fakeClient({
        repos: [
          summary({
            url: "https://github.com/acme/x.git",
            mirrorPath: "/s/.cache/acme/x.git",
          }),
        ],
        deployment: server(),
      });
      const lines = await run(client);
      expect(calls.indexOf("syncRepo")).toBeLessThan(
        calls.indexOf("checkDeployment"),
      );
      expect(lines).toContain(
        "ok repo acme/x: cloned into /s/.cache/acme/x.git",
      );
    });

    it("reads one repo when asked for one", async () => {
      const { client, calls } = fakeClient({
        repos: [row],
        deployment: server(),
      });
      await run(client, ready, { repo: "acme/x" as RepoSlug });
      expect(calls).toContain("getRepo");
      expect(calls).not.toContain("listRepos");
    });
  });

  /** Mutation: ping the model on every run, or never. This is "without --live, spend is unchanged". */
  it("asks the model nothing unless --live says to", async () => {
    const without = fakeClient({});
    await run(without.client);
    expect(without.calls).not.toContain("pingModel");

    const withLive = fakeClient({});
    const lines = await run(withLive.client, ready, { live: true });
    expect(withLive.calls.filter((call) => call === "pingModel")).toHaveLength(
      1,
    );
    expect(lines).toContain(
      'ok live-model: faux/faux-1 answered "ok" ($0.0002, 12 in / 1 out, 40ms)',
    );
  });

  it("fails live-model with the provider's refusal", () => {
    expect(
      formatCheck(
        liveCheck(
          Schema.decodeSync(ModelPing)({
            model: "anthropic/claude-sonnet-5-5",
            ok: false,
            message: "invalid x-api-key",
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
          }),
        ),
      ),
    ).toMatch(
      /^fail live-model: anthropic\/claude-sonnet-5-5 refused: invalid x-api-key -- fix: /,
    );
  });
});

describe("a failed read", () => {
  it("is a fail line, never a thrown error", async () => {
    const { client } = fakeClient({});
    const broken = {
      ...client,
      getServerInfo: () => Effect.fail({ message: "unauthenticated" }),
    } as unknown as DoctorClient;
    const lines = await run(broken);
    expect(lines.at(-1)).toBe(
      "fail server-info: unauthenticated -- fix: if the API has auth on, set FACTORY_API_TOKEN to its token",
    );
  });
});

describe("verdict", () => {
  const faux = [
    { status: "warn", check: "model", detail: "faux", fix: "x" },
  ] satisfies DoctorCheck[];

  /** Mutation: let --allow-faux hide a failure, or let a faux backend exit 0 without it. */
  it("refuses a faux backend unless --allow-faux, and never lets the flag hide a fail", () => {
    expect(verdict(faux, false)).toEqual({
      failed: 0,
      warned: 1,
      fauxRefused: true,
    });
    expect(verdict(faux, true)).toEqual({
      failed: 0,
      warned: 1,
      fauxRefused: false,
    });
    expect(
      verdict(
        [...faux, { status: "fail", check: "postgres", detail: "x", fix: "y" }],
        true,
      ).failed,
    ).toBe(1);
  });

  it("does not refuse any other warning", () => {
    expect(
      verdict(
        [{ status: "warn", check: "webhook linear", detail: "x", fix: "y" }],
        false,
      ).fauxRefused,
    ).toBe(false);
  });
});

describe("formatCheck", () => {
  it("is `status check: detail`, with the fix after `-- fix:` and none on an ok", () => {
    expect(formatCheck({ status: "ok", check: "api", detail: "up" })).toBe(
      "ok api: up",
    );
    expect(
      formatCheck({
        status: "fail",
        check: "postgres",
        detail: "down",
        fix: "start it",
      }),
    ).toBe("fail postgres: down -- fix: start it");
  });
});
