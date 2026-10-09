/**
 * The credential provider's selection and its typed failure (LOB-51, docs/design.md D14).
 *
 * Pure: no database, no network. The end-to-end half, that a real bash call in a faux session never
 * sees the token, lives beside the session service's own suite, which owns the Postgres fixture.
 */
import { ConfigProvider, Effect, Exit, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { RepoSlug } from "@repo/domain/Session";
import {
  CredentialConfig,
  selectCredentialProvider,
  staticTokenProvider,
} from "./credentials";

const repo = RepoSlug.make("lobiklukas/factory");

const configFrom = (env: Record<string, string>) =>
  CredentialConfig.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(env),
    ),
    Effect.runSync,
  );

describe("the static-token provider", () => {
  it("resolves the configured token for a repo slug, redacted", async () => {
    const provider = staticTokenProvider(
      Option.some(Redacted.make("ghp_example")),
    );
    const token = await Effect.runPromise(provider.tokenFor(repo));
    expect(Redacted.value(token)).toBe("ghp_example");
    expect(JSON.stringify(token)).not.toContain("ghp_example");
  });

  it("treats an empty token as no token", async () => {
    const provider = staticTokenProvider(Option.some(Redacted.make("")));
    const exit = await Effect.runPromiseExit(provider.tokenFor(repo));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails with a typed missing-credential error when no token is configured", async () => {
    const provider = staticTokenProvider(Option.none());
    const exit = await Effect.runPromiseExit(provider.tokenFor(repo));
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((r) =>
          r._tag === "Fail" ? [r.error] : [],
        )[0]
      : undefined;
    expect(error?._tag).toBe("CredentialError");
    expect(error?.code).toBe("missing");
    expect(error?.repo).toBe(repo);
  });
});

describe("the selection", () => {
  it("selects the static token when no GitHub App is configured, and says so", async () => {
    const provider = await Effect.runPromise(
      selectCredentialProvider(configFrom({ GITHUB_TOKEN: "ghp_example" })),
    );
    expect(provider.source).toBe("static-token");
  });

  it("selects the static token with no token at all, and fails only at resolution", async () => {
    const provider = await Effect.runPromise(
      selectCredentialProvider(configFrom({})),
    );
    expect(provider.source).toBe("static-token");
    const exit = await Effect.runPromiseExit(provider.tokenFor(repo));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("refuses a GitHub App configuration rather than falling back to the static token", async () => {
    const exit = await Effect.runPromiseExit(
      selectCredentialProvider(
        configFrom({ GITHUB_APP_ID: "123", GITHUB_TOKEN: "ghp_example" }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
