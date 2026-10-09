/**
 * Credentials for the control plane's own calls to a forge (docs/design.md D14, LOB-51).
 *
 * A `CredentialProvider` resolves a token for a repo when a caller needs one, at the point of use.
 * It never writes a token into a session's directory, environment, or log: the sandbox a session
 * runs in is handed nothing, and the consumers that need a token (the push path, the PR client)
 * ask for it themselves, per call.
 *
 * Two implementations are planned and one exists. `static-token` is the local-development shape:
 * one `GITHUB_TOKEN` for every repo, no GitHub App registered. The GitHub App installation-token
 * flow (LOB-55) is where D14's narrow, short-lived tokens come from. Until it exists, configuring
 * `GITHUB_APP_ID` is refused rather than silently falling back to the static token: an operator who
 * set an App expects App tokens, and a quiet fallback would hand out the wrong credential.
 */
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import type { RepoSlug } from "@repo/domain/Session";

/** A credential could not be resolved. Typed, so callers handle it instead of crashing. */
export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  {
    repo: Schema.String,
    code: Schema.Literals(["missing", "unsupported"]),
    message: Schema.String,
  },
) {}

/** The one credential source that exists today. */
export type CredentialSource = "static-token";

export type CredentialProviderShape = {
  /** Which implementation was selected, and therefore what a token means. */
  readonly source: CredentialSource;
  /** A token for one repo. Fails with a typed error when none is configured. */
  readonly tokenFor: (
    repo: RepoSlug,
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialError>;
};

export class CredentialProvider extends Context.Service<
  CredentialProvider,
  CredentialProviderShape
>()("@repo/core/CredentialProvider") {}

/**
 * The credential configuration. `GITHUB_TOKEN` is the static token; `GITHUB_APP_ID` is read only so
 * that its presence can be refused (see the module comment).
 */
export const CredentialConfig = Config.all({
  githubToken: Config.option(Config.Redacted("GITHUB_TOKEN")),
  githubAppId: Config.option(Config.String("GITHUB_APP_ID")),
});

export type CredentialConfigShape = {
  readonly githubToken: Option.Option<Redacted.Redacted<string>>;
  readonly githubAppId: Option.Option<string>;
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

/**
 * The selected provider for a configuration. The selection is the whole answer: with no GitHub App
 * configured it is the static token, and that is the value a caller reads as `source`.
 */
export const selectCredentialProvider = (
  config: CredentialConfigShape,
): Effect.Effect<CredentialProviderShape, CredentialError> =>
  Option.isSome(config.githubAppId)
    ? Effect.fail(
        new CredentialError({
          repo: "*",
          code: "unsupported",
          message:
            "GITHUB_APP_ID is set, but the GitHub App token flow is not built yet (LOB-55); unset it to use GITHUB_TOKEN",
        }),
      )
    : Effect.succeed(staticTokenProvider(config.githubToken));

/** The provider the process runs with, selected from the environment at layer build. */
export const CredentialProviderLive = Layer.effect(
  CredentialProvider,
  Effect.gen(function* () {
    const config = yield* CredentialConfig;
    return CredentialProvider.of(yield* selectCredentialProvider(config));
  }),
);
