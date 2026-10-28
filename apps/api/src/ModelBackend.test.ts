import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@repo/harness";
import {
  ACCEPTED_ANTHROPIC_VARIABLES,
  describeFauxBackend,
  describeMissingIdentityTokenFile,
  describeModelBackend,
  modelBackendWarnings,
  selectModelBackend,
} from "./ModelBackend";

/**
 * The backend decision against an injected credential lookup (LOB-258): pi-ai's real Anthropic
 * provider resolves, but from a record, so no case reads or writes the process environment. Every
 * value is a dummy and nothing is sent anywhere. `boot.test.ts` proves the same against a real boot.
 */

/** A lookup over `env` and the paths in `files`, recording each name it is asked for. */
const contextOf = (
  env: Readonly<Record<string, string>>,
  files: readonly string[] = [],
) => {
  const asked: string[] = [];
  const context: AuthContext = {
    env: async (name) => {
      asked.push(name);
      return env[name];
    },
    fileExists: async (path) => files.includes(path),
  };
  return { context, asked };
};

const select = (
  forced: "anthropic" | "faux" | undefined,
  env: Readonly<Record<string, string>>,
  files: readonly string[] = [],
) =>
  Effect.runPromiseExit(
    selectModelBackend({
      forced: Option.fromUndefinedOr(forced),
      authContext: contextOf(env, files).context,
    }),
  );

const chosen = async (
  forced: "anthropic" | "faux" | undefined,
  env: Readonly<Record<string, string>>,
  files: readonly string[] = [],
) => {
  const exit = await select(forced, env, files);
  if (!Exit.isSuccess(exit)) throw new Error(`select failed: ${String(exit)}`);
  return exit.value;
};

/** The `AnthropicCredentialMissing` a selection failed with, if that is how it failed. */
const missingOf = (exit: Awaited<ReturnType<typeof select>>) => {
  const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
  return failure?._tag === "AnthropicCredentialMissing" ? failure : undefined;
};

describe("selectModelBackend", () => {
  it("picks anthropic from each token variable alone, naming it and never its value", async () => {
    for (const name of [
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]) {
      const value = `dummy-${name.toLowerCase()}-value`;
      const choice = await chosen(undefined, { [name]: value });
      expect(choice).toEqual({
        backend: "anthropic",
        forced: false,
        auth: { source: name, type: "api_key" },
      });
      const line = describeModelBackend(choice);
      expect(line).toBe(`model backend: anthropic (auth: ${name})`);
      expect(line).not.toContain(value);
      expect(modelBackendWarnings(choice)).toEqual([]);
    }
  });

  const FEDERATION = {
    ANTHROPIC_FEDERATION_RULE_ID: "dummy-rule",
    ANTHROPIC_ORGANIZATION_ID: "dummy-org",
    ANTHROPIC_IDENTITY_TOKEN_FILE: "/dummy/token",
  } as const;

  it("picks anthropic from workload identity federation when the token file exists", async () => {
    const choice = await chosen(undefined, FEDERATION, ["/dummy/token"]);
    expect(describeModelBackend(choice)).toBe(
      "model backend: anthropic (auth: workload identity federation)",
    );
    expect(modelBackendWarnings(choice)).toEqual([]);
  });

  it("refuses a forced anthropic whose federation names a token file that does not exist", async () => {
    const exit = await select("anthropic", FEDERATION);
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(failure?._tag).toBe("AnthropicIdentityTokenFileMissing");
    if (failure?._tag !== "AnthropicIdentityTokenFileMissing") return;
    expect(failure.path).toBe("/dummy/token");
    expect(failure.message).toContain(
      "ANTHROPIC_IDENTITY_TOKEN_FILE names /dummy/token, which does not exist",
    );
  });

  it("falls back to faux when an inferred federation's token file does not exist, and says which file", async () => {
    const choice = await chosen(undefined, FEDERATION);
    expect(choice).toEqual({
      backend: "faux",
      forced: false,
      unread: [],
      missingIdentityTokenFile: "/dummy/token",
    });
    const warnings = modelBackendWarnings(choice);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toBe(describeMissingIdentityTokenFile("/dummy/token"));
  });

  it("never checks the token file when a token variable resolves first", async () => {
    const choice = await chosen("anthropic", {
      ...FEDERATION,
      ANTHROPIC_API_KEY: "dummy-key",
    });
    expect(describeModelBackend(choice)).toBe(
      "model backend: anthropic (MODEL_BACKEND; auth: ANTHROPIC_API_KEY)",
    );
  });

  it("says MODEL_BACKEND forced anthropic, and still names the source", async () => {
    const choice = await chosen("anthropic", {
      ANTHROPIC_API_KEY: "dummy-key",
    });
    expect(describeModelBackend(choice)).toBe(
      "model backend: anthropic (MODEL_BACKEND; auth: ANTHROPIC_API_KEY)",
    );
  });

  it("refuses a forced anthropic with nothing that resolves, listing every accepted variable", async () => {
    const exit = await select("anthropic", {});
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = missingOf(exit);
    expect(failure?._tag).toBe("AnthropicCredentialMissing");
    expect(failure?.accepted).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
    ]);
    for (const name of ACCEPTED_ANTHROPIC_VARIABLES) {
      expect(failure?.message).toContain(name);
    }
    expect(failure?.message).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("refuses a forced anthropic with half a federation, which pi-ai does not accept", async () => {
    const exit = await select("anthropic", {
      ANTHROPIC_FEDERATION_RULE_ID: "dummy-rule",
      ANTHROPIC_ORGANIZATION_ID: "dummy-org",
    });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("says CLAUDE_CODE_OAUTH_TOKEN is not read when it is all a forced anthropic has", async () => {
    const exit = await select("anthropic", {
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-subscription-token",
    });
    const failure = missingOf(exit);
    expect(failure?.message).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN is set but not read",
    );
    expect(failure?.message).not.toContain("dummy-subscription-token");
  });

  it("never consults a credential when MODEL_BACKEND forces faux", async () => {
    const { context, asked } = contextOf({ ANTHROPIC_API_KEY: "dummy-key" });
    const choice = await Effect.runPromise(
      selectModelBackend({ forced: Option.some("faux"), authContext: context }),
    );
    expect(choice).toEqual({ backend: "faux", forced: true, unread: [] });
    expect(asked).toEqual([]);
    expect(describeModelBackend(choice)).toBe(
      "model backend: faux (selected by MODEL_BACKEND)",
    );
    expect(modelBackendWarnings(choice)).toEqual([describeFauxBackend(true)]);
  });

  it("falls back to faux with nothing set, and warns with the variables that would have worked", async () => {
    const choice = await chosen(undefined, {});
    expect(choice).toEqual({ backend: "faux", forced: false, unread: [] });
    expect(describeModelBackend(choice)).toBe(
      "model backend: faux (no Anthropic credential resolved)",
    );
    const [warning, ...rest] = modelBackendWarnings(choice);
    expect(rest).toEqual([]);
    for (const name of ACCEPTED_ANTHROPIC_VARIABLES) {
      expect(warning).toContain(name);
    }
  });

  it("falls back to faux on CLAUDE_CODE_OAUTH_TOKEN alone, and says it is not read", async () => {
    const choice = await chosen(undefined, {
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-subscription-token",
    });
    expect(choice).toEqual({
      backend: "faux",
      forced: false,
      unread: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    const warnings = modelBackendWarnings(choice);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN is set but not read",
    );
    expect(warnings.join("\n")).not.toContain("dummy-subscription-token");
  });
});

describe("describeFauxBackend", () => {
  it("says faux was chosen, not that a credential is missing, when MODEL_BACKEND set it", () => {
    const line = describeFauxBackend(true);
    expect(line).toContain("chosen by MODEL_BACKEND=faux");
    expect(line).not.toContain("no Anthropic credential");
  });

  it("points at the missing credential when the backend was inferred", () => {
    const line = describeFauxBackend(false);
    expect(line).toContain("no Anthropic credential");
    expect(line).not.toContain("chosen by");
  });
});
