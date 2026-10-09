/**
 * Credentials for the control plane's own calls to a forge (docs/design.md D14, LOB-51, LOB-55).
 *
 * A `CredentialProvider` resolves a token for a repo when a caller needs one, at the point of use.
 * It never writes a token into a session's directory, environment, or log: the sandbox a session
 * runs in is handed nothing, and the consumers that need a token (the push path, the PR client)
 * ask for it themselves, per call.
 *
 * Two implementations exist. `static-token` is the local-development shape: one `GITHUB_TOKEN` for
 * every repo, no GitHub App registered. `github-app` is D14's narrow, short-lived shape: an App
 * JWT (RS256, signed with the App's private key) is exchanged for an installation token scoped to
 * the repo being asked for, cached until shortly before it expires, and minted again on demand.
 * Selecting it requires `GITHUB_APP_ID` with `GITHUB_APP_PRIVATE_KEY` and
 * `GITHUB_APP_INSTALLATION_ID`; an App id with a missing half is a typed error, never a silent
 * fallback to the static token, because an operator who set an App expects App tokens.
 */
import { createSign } from "node:crypto";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { RepoSlug } from "@repo/domain/Session";

/** A credential could not be resolved. Typed, so callers handle it instead of crashing. */
export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  {
    repo: Schema.String,
    code: Schema.Literals(["missing", "unsupported", "failed"]),
    message: Schema.String,
  },
) {}

/** The credential sources that exist. */
export type CredentialSource = "static-token" | "github-app";

export type CredentialProviderShape = {
  /** Which implementation was selected, and therefore what a token means. */
  readonly source: CredentialSource;
  /** A token for one repo. Fails with a typed error when none can be resolved. */
  readonly tokenFor: (
    repo: RepoSlug,
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialError>;
};

export class CredentialProvider extends Context.Service<
  CredentialProvider,
  CredentialProviderShape
>()("@repo/core/CredentialProvider") {}

/**
 * The credential configuration. `GITHUB_TOKEN` is the static token; the `GITHUB_APP_*` variables
 * select and configure the App flow. `GITHUB_API_URL` is the API root the App flow calls.
 */
export const CredentialConfig = Config.all({
  githubToken: Config.option(Config.Redacted("GITHUB_TOKEN")),
  githubAppId: Config.option(Config.String("GITHUB_APP_ID")),
  githubAppPrivateKey: Config.option(Config.Redacted("GITHUB_APP_PRIVATE_KEY")),
  githubAppInstallationId: Config.option(
    Config.String("GITHUB_APP_INSTALLATION_ID"),
  ),
  githubApiUrl: Config.withDefault(
    Config.String("GITHUB_API_URL"),
    "https://api.github.com",
  ),
});

export type CredentialConfigShape = {
  readonly githubToken: Option.Option<Redacted.Redacted<string>>;
  readonly githubAppId: Option.Option<string>;
  readonly githubAppPrivateKey: Option.Option<Redacted.Redacted<string>>;
  readonly githubAppInstallationId: Option.Option<string>;
  readonly githubApiUrl: string;
};

/** A provider that answers from one configured static token, for every repo. */
export const staticTokenProvider = (
  configured: Option.Option<Redacted.Redacted<string>>,
): CredentialProviderShape => {
  // An empty GITHUB_TOKEN is an unset one: an empty secret is no credential, and sending it would
  // fail later, far from the cause.
  const token = Option.filter(
    configured,
    (value) => Redacted.value(value).length > 0,
  );
  return {
    source: "static-token",
    tokenFor: (repo) =>
      Option.match(token, {
        onNone: () =>
          Effect.fail(
            new CredentialError({
              repo,
              code: "missing",
              message: `no GITHUB_TOKEN configured; cannot resolve a token for ${repo}`,
            }),
          ),
        onSome: (value) => Effect.succeed(value),
      }),
  };
};

export type GitHubAppConfig = {
  readonly appId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly installationId: string;
  readonly apiUrl: string;
};

/** Tokens are refreshed this long before GitHub's expiry, so a caller never receives a dead one. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** An App JWT lives at most ten minutes; GitHub rejects a longer one. */
const JWT_LIFETIME_S = 9 * 60;

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/**
 * The App JWT GitHub exchanges for an installation token: RS256 over `{iat, exp, iss}`. `iat` is
 * backdated a minute to absorb clock skew between this process and GitHub.
 */
export const mintAppJwt = (
  appId: string,
  privateKeyPem: string,
  nowMs: number,
): string => {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S + 60, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKeyPem).toString("base64url")}`;
};

/** GitHub's private keys arrive from env files with literal `\n` sequences; restore the newlines. */
const normalisePem = (value: string): string => value.replace(/\\n/g, "\n");

const InstallationToken = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
});

/**
 * The GitHub App provider. It needs an `HttpClient` at construction, so the HTTP boundary is a
 * service the tests replace with an in-process fake; the returned provider needs nothing further.
 *
 * Tokens are cached per installation and repository set, so a narrower request never gets a wider
 * token. A cached token is reused until `REFRESH_MARGIN_MS` before its expiry, then minted again.
 */
export const githubAppProvider = (
  config: GitHubAppConfig,
  now: () => number = Date.now,
): Effect.Effect<CredentialProviderShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const cache = new Map<
      string,
      { readonly token: Redacted.Redacted<string>; readonly expiresAt: number }
    >();
    const pem = normalisePem(Redacted.value(config.privateKey));

    const mint = (
      repo: RepoSlug,
    ): Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly expiresAt: number },
      CredentialError
    > => {
      const repoName = repo.split("/")[1] ?? repo;
      const fail = (reason: string) =>
        new CredentialError({
          repo,
          code: "failed",
          message: `GitHub App token for ${repo} failed: ${reason}`,
        });
      return Effect.gen(function* () {
        const jwt = yield* Effect.try({
          try: () => mintAppJwt(config.appId, pem, now()),
          catch: () => fail("the App private key could not sign a JWT"),
        });
        const request = yield* HttpClientRequest.post(
          `${config.apiUrl}/app/installations/${config.installationId}/access_tokens`,
          {
            headers: {
              authorization: `Bearer ${jwt}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            },
          },
        ).pipe(
          HttpClientRequest.bodyJson({ repositories: [repoName] }),
          Effect.mapError(() => fail("the request body could not be encoded")),
        );
        const response = yield* http.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(InstallationToken)),
          Effect.mapError((error) =>
            fail(
              // The error names the status and the failure kind; a response body is never quoted,
              // because a rejected request can echo parts of what was sent.
              error._tag === "HttpClientError" &&
                error.reason._tag === "StatusCodeError"
                ? `GitHub answered HTTP ${error.reason.response.status}`
                : "GitHub's response could not be read",
            ),
          ),
        );
        return {
          token: Redacted.make(response.token),
          expiresAt: Date.parse(response.expires_at),
        };
      });
    };

    return {
      source: "github-app",
      tokenFor: (repo) =>
        Effect.gen(function* () {
          const repoName = repo.split("/")[1] ?? repo;
          const key = `${config.installationId}:${repoName}`;
          const cached = cache.get(key);
          if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) {
            return cached.token;
          }
          const fresh = yield* mint(repo);
          cache.set(key, fresh);
          return fresh.token;
        }),
    };
  });

/**
 * The selected provider for a configuration. The selection is the whole answer: with no GitHub App
 * configured it is the static token; with `GITHUB_APP_ID` it is the App flow, and any missing App
 * setting is a typed error naming it.
 */
export const selectCredentialProvider = (
  config: CredentialConfigShape,
): Effect.Effect<
  CredentialProviderShape,
  CredentialError,
  HttpClient.HttpClient
> => {
  if (Option.isNone(config.githubAppId)) {
    return Effect.succeed(staticTokenProvider(config.githubToken));
  }
  const key = Option.filter(
    config.githubAppPrivateKey,
    (value) => Redacted.value(value).length > 0,
  );
  const installation = Option.filter(
    config.githubAppInstallationId,
    (value) => value.length > 0,
  );
  if (Option.isNone(key) || Option.isNone(installation)) {
    const missing = [
      Option.isNone(key) ? "GITHUB_APP_PRIVATE_KEY" : undefined,
      Option.isNone(installation) ? "GITHUB_APP_INSTALLATION_ID" : undefined,
    ].filter((name): name is string => name !== undefined);
    return Effect.fail(
      new CredentialError({
        repo: "*",
        code: "missing",
        message: `GITHUB_APP_ID is set, but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not; set them, or unset GITHUB_APP_ID to use GITHUB_TOKEN`,
      }),
    );
  }
  return githubAppProvider({
    appId: config.githubAppId.value,
    privateKey: key.value,
    installationId: installation.value,
    apiUrl: config.githubApiUrl,
  });
};

/**
 * The provider the process runs with, selected from the environment at layer build. The HTTP
 * client is the platform's fetch; a test that needs the App flow builds it with its own client.
 */
export const CredentialProviderLive = Layer.effect(
  CredentialProvider,
  Effect.gen(function* () {
    const config = yield* CredentialConfig;
    return CredentialProvider.of(yield* selectCredentialProvider(config));
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
