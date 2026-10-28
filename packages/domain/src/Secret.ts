/**
 * Scoped secrets (S-agent-secrets): named values a repository's own commands need — a registry
 * token for `install`, a test API key for `verify` — stored by the control plane, injected only into
 * the commands that declare them, and never answered back.
 *
 * **Write-only.** A value crosses the wire once, inward, on `setSecret`, and no member of any group
 * answers it again: a secret is listed by its name, its repository and who set it when. The payload's
 * `value` is a `Redacted` on both sides of the wire (`Schema.RedactedFromValue`), so the client and
 * the server hold it as a value that prints `<redacted>` in a log line, a span or an error.
 *
 * **Scoped to a repository.** A secret belongs to one registered repo, and a run of that repo gets
 * only the names the repo's `.factory/config` declares for the step that runs (`RepoSecretNeeds`),
 * read at the base the session was cut from — never the names an agent's branch declares.
 */
import { Schema } from "effect";
import { Timestamp } from "@repo/domain/Ids";
import { RepoNotFound, RepoSlug, SessionActor } from "@repo/domain/Session";

/**
 * A secret's name: the environment variable a command reads it as, so it is spelled as one —
 * uppercase letters, digits and underscores, not starting with a digit.
 */
export const SecretName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/)),
  Schema.check(Schema.isMaxLength(128)),
);
export type SecretName = typeof SecretName.Type;

/**
 * The shortest value the store takes. A value is masked wherever a command prints it, and masking a
 * three-letter string would black out ordinary words in every output; eight characters is past any
 * word a log line is made of and short of every real token.
 */
export const SECRET_MIN_LENGTH = 8;

/** The longest value the store takes: past a PEM private key, short of a file nobody means. */
export const SECRET_MAX_LENGTH = 64 * 1024;

/**
 * Which secrets a repository's commands need, as its `.factory/config` declares them:
 * `{"secrets": {"setup": ["NPM_TOKEN"], "verify": ["TEST_API_KEY"]}}`. `setup` covers the setup's
 * `install` and `build`; `verify` the `verify` tool's commands. A name nobody declares reaches no
 * command, whatever the store holds.
 */
export const RepoSecretNeeds = Schema.Struct({
  setup: Schema.optional(Schema.Array(SecretName)),
  verify: Schema.optional(Schema.Array(SecretName)),
});
export type RepoSecretNeeds = typeof RepoSecretNeeds.Type;

/** What the factory answers about a stored secret: everything but its value. */
export const SecretSummary = Schema.Struct({
  repo: RepoSlug,
  name: SecretName,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The control-plane actor whose credential last set it (LOB-20); empty when unattributed. */
  updatedBy: Schema.String,
});
export type SecretSummary = typeof SecretSummary.Type;

/** Store a secret, replacing any value it held. The answer is its summary, never the value. */
export const SetSecretInput = Schema.Struct({
  repo: RepoSlug,
  name: SecretName,
  value: Schema.RedactedFromValue(Schema.String),
  /** Set by the control plane from the caller's credential (LOB-20), as a skill put's actor is. */
  actor: Schema.optional(SessionActor),
});
export type SetSecretInput = typeof SetSecretInput.Type;

/** Every secret's summary, or one repository's. */
export const ListSecretsInput = Schema.Struct({
  repo: Schema.optional(RepoSlug),
});
export type ListSecretsInput = typeof ListSecretsInput.Type;

export const DeleteSecretInput = Schema.Struct({
  repo: RepoSlug,
  name: SecretName,
});
export type DeleteSecretInput = typeof DeleteSecretInput.Type;

/** A value the store refuses before anything is written: too short, too long, or not text. */
export class InvalidSecret extends Schema.TaggedError<InvalidSecret>()(
  "InvalidSecret",
  { name: Schema.String, message: Schema.String },
) {}

/**
 * The control plane holds no key to encrypt a secret with (`FACTORY_SECRETS_KEY`), so it stores
 * none: a value is never written in the clear.
 */
export class SecretsUnconfigured extends Schema.TaggedError<SecretsUnconfigured>()(
  "SecretsUnconfigured",
  { message: Schema.String },
) {}

export class SecretNotFound extends Schema.TaggedError<SecretNotFound>()(
  "SecretNotFound",
  { repo: Schema.String, name: Schema.String, message: Schema.String },
) {}

export class SecretStorageError extends Schema.TaggedError<SecretStorageError>()(
  "SecretStorageError",
  { message: Schema.String },
) {}

export type SecretError =
  | InvalidSecret
  | SecretsUnconfigured
  | SecretNotFound
  | RepoNotFound
  | SecretStorageError;

/** Every refusal the secrets RPC group answers, on the wire. */
export const SecretErrorSchema = Schema.Union([
  InvalidSecret,
  SecretsUnconfigured,
  SecretNotFound,
  RepoNotFound,
  SecretStorageError,
]);

/**
 * The placeholder an injected value is replaced by wherever a command's output reaches the log:
 * the secret's name, so a reader can tell which value was there, and nothing of the value.
 */
export const secretPlaceholder = (name: string): string => `[secret:${name}]`;
