/**
 * The GitHub App installation-token provider (LOB-55), against the in-process fake in
 * `github-app.test-fake.ts`. No case reaches github.com: the fake answers at the HttpClient seam.
 */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { DateTime, Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { RepoSlug } from "@repo/domain/Session";
import {
  githubAppProvider,
  mintAppJwt,
  type CredentialError,
} from "./credentials";
import { makeFakeGitHub } from "./github-app.test-fake";

const repo = RepoSlug.make("lobiklukas/factory");
const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

const config = {
  appId: "123",
  privateKey: Redacted.make(pem),
  installationId: "456",
  apiUrl: "https://api.github.test",
};

const errorOf = (exit: Exit.Exit<unknown, CredentialError>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []))[0]
    : undefined;

describe("the App JWT", () => {
  it("is RS256 over iss, iat and exp, signed by the App's key", () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    const jwt = mintAppJwt("123", pem, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, signature!, "base64url")).toBe(true);
  });
});

describe("the App token provider", () => {
  it("mints an installation token narrowed to the repo, with the App JWT as bearer", async () => {
    const fake = makeFakeGitHub(() => ({
      status: 201,
      token: "ghs_first",
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(T0 + 3600_000)),
    }));
    const provider = await Effect.runPromise(
      githubAppProvider(config, () => T0).pipe(Effect.provide(fake.client)),
    );
    expect(provider.source).toBe("github-app");
    const token = await Effect.runPromise(provider.tokenFor(repo));
    expect(Redacted.value(token)).toBe("ghs_first");
    expect(JSON.stringify(token)).not.toContain("ghs_first");

    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe("/app/installations/456/access_tokens");
    expect(request!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(request!.body).toEqual({ repositories: ["factory"] });
  });

  it("reuses a cached token until shortly before it expires, then mints again", async () => {
    let clock = T0;
    const expiresAt = () =>
      DateTime.formatIso(DateTime.makeUnsafe(clock + 3600_000));
    const fake = makeFakeGitHub((n) => ({
      status: 201,
      token: `ghs_${n}`,
      expiresAt: expiresAt(),
    }));
    const provider = await Effect.runPromise(
      githubAppProvider(config, () => clock).pipe(Effect.provide(fake.client)),
    );
    expect(
      Redacted.value(await Effect.runPromise(provider.tokenFor(repo))),
    ).toBe("ghs_1");
    expect(
      Redacted.value(await Effect.runPromise(provider.tokenFor(repo))),
    ).toBe("ghs_1");
    expect(fake.requests).toHaveLength(1);

    clock += 3600_000 - 60_000; // inside the five-minute refresh margin
    expect(
      Redacted.value(await Effect.runPromise(provider.tokenFor(repo))),
    ).toBe("ghs_2");
    expect(fake.requests).toHaveLength(2);
  });

  it("keeps a narrowed token apart from another repo's, so a request never gets a wider token", async () => {
    const fake = makeFakeGitHub((n) => ({
      status: 201,
      token: `ghs_${n}`,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(T0 + 3600_000)),
    }));
    const provider = await Effect.runPromise(
      githubAppProvider(config, () => T0).pipe(Effect.provide(fake.client)),
    );
    await Effect.runPromise(provider.tokenFor(repo));
    await Effect.runPromise(
      provider.tokenFor(RepoSlug.make("lobiklukas/other")),
    );
    expect(fake.requests.map((r) => r.body)).toEqual([
      { repositories: ["factory"] },
      { repositories: ["other"] },
    ]);
  });

  it("fails with a typed error naming the status, without echoing a body", async () => {
    const fake = makeFakeGitHub(() => ({ status: 401 }));
    const provider = await Effect.runPromise(
      githubAppProvider(config, () => T0).pipe(Effect.provide(fake.client)),
    );
    const exit = await Effect.runPromiseExit(provider.tokenFor(repo));
    const error = errorOf(exit);
    expect(error?._tag).toBe("CredentialError");
    expect(error?.code).toBe("failed");
    expect(error?.message).toContain("HTTP 401");
    expect(error?.message).not.toContain("rejected");
  });

  it("fails typed when the App private key cannot sign", async () => {
    const fake = makeFakeGitHub(() => ({
      status: 201,
      token: "x",
      expiresAt: "",
    }));
    const provider = await Effect.runPromise(
      githubAppProvider({
        ...config,
        privateKey: Redacted.make("not a key"),
      }).pipe(Effect.provide(fake.client)),
    );
    const exit = await Effect.runPromiseExit(provider.tokenFor(repo));
    expect(errorOf(exit)?.code).toBe("failed");
    expect(fake.requests).toHaveLength(0);
  });
});
