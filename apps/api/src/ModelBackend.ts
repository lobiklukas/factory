import {
  ANTHROPIC_AUTH_VARIABLES,
  checkModelAuth,
  createModelAccess,
  defaultProviderAuthContext,
  type AuthContext,
  type ModelAuth,
  type ModelBackend,
} from "@repo/harness";
import { Effect, Option, Schema } from "effect";

/**
 * Which model backend the process runs, and why (LOB-258).
 *
 * The decision is pi-ai's own: `checkModelAuth` asks the Anthropic provider whether any credential
 * it accepts resolves, through the same lookup a request authenticates with. So every mode pi-ai
 * supports picks the real backend (a bearer `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`,
 * `ANTHROPIC_API_KEY`, workload identity federation), and a mode it does not is never mistaken for
 * one. The boot line names the source that authenticated, the variable's name, never its value.
 *
 * `MODEL_BACKEND` still wins. Forcing `anthropic` with nothing that resolves is a configuration
 * error, so the boot fails with `AnthropicCredentialMissing` rather than serving until the first
 * request does; forcing `faux` is a choice and is never second-guessed. pi-ai accepts federation on
 * any non-empty `ANTHROPIC_IDENTITY_TOKEN_FILE`, so the file's existence is checked here: missing, a
 * forced anthropic fails with `AnthropicIdentityTokenFileMissing` and an inferred one runs faux.
 */

/**
 * A variable an operator may have set expecting it to authenticate, which pi-ai never reads.
 * Claude Code's own subscription token: pi-ai never reads it, and this API stores no Pro/Max login.
 */
export const UNREAD_ANTHROPIC_VARIABLES = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** Every variable that, alone or with its group, authenticates the Anthropic backend. */
export const ACCEPTED_ANTHROPIC_VARIABLES: readonly string[] = [
  ...ANTHROPIC_AUTH_VARIABLES.tokens,
  ...ANTHROPIC_AUTH_VARIABLES.federation,
];

/** The accepted modes in a sentence, for an error or a warning an operator acts on. */
const acceptedModes = () =>
  `${ANTHROPIC_AUTH_VARIABLES.tokens.join(", ")}, or all of ${ANTHROPIC_AUTH_VARIABLES.federation.join(", ")} (workload identity federation); an empty or whitespace-only value counts as unset`;

/** `MODEL_BACKEND=anthropic`, and no credential pi-ai accepts resolves. */
export class AnthropicCredentialMissing extends Schema.TaggedError<AnthropicCredentialMissing>()(
  "AnthropicCredentialMissing",
  {
    message: Schema.String,
    /** The variables any one of which (or the federation group, together) would have resolved. */
    accepted: Schema.Array(Schema.String),
  },
) {}

/**
 * `MODEL_BACKEND=anthropic`, and workload identity federation is the only mode that resolves, but
 * `ANTHROPIC_IDENTITY_TOKEN_FILE` names a file that does not exist. pi-ai accepts any non-empty path,
 * so without this check the boot would succeed and every request would fail on the exchange.
 */
export class AnthropicIdentityTokenFileMissing extends Schema.TaggedError<AnthropicIdentityTokenFileMissing>()(
  "AnthropicIdentityTokenFileMissing",
  {
    message: Schema.String,
    /** The path `ANTHROPIC_IDENTITY_TOKEN_FILE` names: a location, not a credential. */
    path: Schema.String,
  },
) {}

/** pi-ai's label for the federation mode, the only one that authenticates from a file. */
const FEDERATION_SOURCE = "workload identity federation";

export type ModelBackendChoice =
  | {
      readonly backend: "anthropic";
      /** Whether `MODEL_BACKEND` named it, or a credential did. */
      readonly forced: boolean;
      readonly auth: ModelAuth;
    }
  | {
      readonly backend: "faux";
      /** `true`: `MODEL_BACKEND=faux`. `false`: no credential resolved. */
      readonly forced: boolean;
      /** Variables pi-ai never reads that were set anyway (names only), when none resolved. */
      readonly unread: readonly string[];
      /**
       * Federation resolved, but `ANTHROPIC_IDENTITY_TOKEN_FILE` names a file that does not exist:
       * the path, so the warning sends the operator to it. Absent otherwise.
       */
      readonly missingIdentityTokenFile?: string;
    };

/** The variables in `UNREAD_ANTHROPIC_VARIABLES` that are set (names only). */
const unreadVariablesSet = Effect.fn("ModelBackend.unreadVariablesSet")(
  function* (context: AuthContext) {
    const set: string[] = [];
    for (const name of UNREAD_ANTHROPIC_VARIABLES) {
      const value = yield* Effect.promise(() => context.env(name));
      if (value !== undefined && value.trim() !== "") set.push(name);
    }
    return set;
  },
);

/**
 * The path `ANTHROPIC_IDENTITY_TOKEN_FILE` names, when it does not exist. A cheap, offline structural
 * check: the file's contents are never read, so whether the token is valid is still the exchange's
 * to say on the first request.
 */
const missingIdentityTokenFile = Effect.fn(
  "ModelBackend.missingIdentityTokenFile",
)(function* (context: AuthContext) {
  const path = yield* Effect.promise(() =>
    context.env("ANTHROPIC_IDENTITY_TOKEN_FILE"),
  );
  if (path === undefined || path.trim() === "") return Option.none<string>();
  const exists = yield* Effect.promise(() => context.fileExists(path));
  return exists ? Option.none<string>() : Option.some(path);
});

/** The warning for a federation whose identity token file does not exist. */
export const describeMissingIdentityTokenFile = (path: string) =>
  `ANTHROPIC_IDENTITY_TOKEN_FILE names ${path}, which does not exist, so workload identity federation cannot authenticate`;

/** The note added when a variable pi-ai never reads is set and nothing else authenticated. */
export const describeUnreadVariables = (names: readonly string[]) =>
  names.length === 0
    ? ""
    : `${names.join(", ")} is set but not read: pi-ai never reads it and this API stores no Claude Pro/Max login (README, "Model credentials")`;

/**
 * Pick the backend: `MODEL_BACKEND` when set, otherwise anthropic when pi-ai resolves a credential
 * and faux when it does not. Fails when anthropic is forced and nothing resolves.
 */
export const selectModelBackend = Effect.fn("ModelBackend.select")(
  function* (input: {
    readonly forced: Option.Option<ModelBackend>;
    /** Where credentials are read from. Absent: pi-ai's default, the process environment. */
    readonly authContext?: AuthContext | undefined;
  }) {
    if (Option.isSome(input.forced) && input.forced.value === "faux") {
      return {
        backend: "faux",
        forced: true,
        unread: [],
      } satisfies ModelBackendChoice;
    }
    const context = input.authContext ?? defaultProviderAuthContext();
    const auth = yield* checkModelAuth(
      createModelAccess("anthropic", { authContext: context }),
    );
    const missingFile =
      Option.isSome(auth) && auth.value.source === FEDERATION_SOURCE
        ? yield* missingIdentityTokenFile(context)
        : Option.none<string>();
    if (Option.isSome(missingFile)) {
      if (Option.isSome(input.forced)) {
        return yield* new AnthropicIdentityTokenFileMissing({
          message: `MODEL_BACKEND=anthropic, and workload identity federation is the only credential that resolves, but ${describeMissingIdentityTokenFile(missingFile.value)}. Point it at the identity token file, set one of ${ANTHROPIC_AUTH_VARIABLES.tokens.join(", ")}, or unset MODEL_BACKEND to run the faux provider.`,
          path: missingFile.value,
        });
      }
      return {
        backend: "faux",
        forced: false,
        unread: yield* unreadVariablesSet(context),
        missingIdentityTokenFile: missingFile.value,
      } satisfies ModelBackendChoice;
    }
    if (Option.isSome(auth)) {
      return {
        backend: "anthropic",
        forced: Option.isSome(input.forced),
        auth: auth.value,
      } satisfies ModelBackendChoice;
    }
    const unread = yield* unreadVariablesSet(context);
    if (Option.isSome(input.forced)) {
      const note = describeUnreadVariables(unread);
      return yield* new AnthropicCredentialMissing({
        message: `MODEL_BACKEND=anthropic, but no Anthropic credential resolves. Set one of ${acceptedModes()}. Or unset MODEL_BACKEND to run the faux provider.${note === "" ? "" : ` ${note}.`}`,
        accepted: ACCEPTED_ANTHROPIC_VARIABLES,
      });
    }
    return {
      backend: "faux",
      forced: false,
      unread,
    } satisfies ModelBackendChoice;
  },
);

/** The boot line: the backend, what chose it, and for anthropic the source that authenticated. */
export const describeModelBackend = (choice: ModelBackendChoice) =>
  choice.backend === "anthropic"
    ? `model backend: anthropic (${choice.forced ? "MODEL_BACKEND; " : ""}auth: ${choice.auth.source})`
    : choice.forced
      ? "model backend: faux (selected by MODEL_BACKEND)"
      : "model backend: faux (no Anthropic credential resolved)";

/**
 * The warning logged when the model backend is faux. A credential that is absent and a backend
 * someone chose are different facts: the second is not a problem to warn about, and the first sends
 * the operator to the env file with the variables that would have worked.
 */
export const describeFauxBackend = (chosenByEnv: boolean) =>
  chosenByEnv
    ? "sessions run against the faux provider and produce scripted answers (chosen by MODEL_BACKEND=faux)"
    : `no Anthropic credential: sessions run against the faux provider and produce scripted answers. Set one of ${acceptedModes()}`;

/** The warnings a choice carries: the faux warning, and a variable that was set and nothing reads. */
export const modelBackendWarnings = (
  choice: ModelBackendChoice,
): readonly string[] =>
  choice.backend === "anthropic"
    ? []
    : [
        describeFauxBackend(choice.forced),
        ...(choice.missingIdentityTokenFile === undefined
          ? []
          : [
              describeMissingIdentityTokenFile(choice.missingIdentityTokenFile),
            ]),
        ...(choice.unread.length === 0
          ? []
          : [describeUnreadVariables(choice.unread)]),
      ];
