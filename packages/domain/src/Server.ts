import { Schema } from "effect";

/**
 * What the control plane is running (LOB-269): the answer to `getServerInfo`.
 *
 * Until this existed the only place an operator could learn which model a session talks to was one
 * boot line inside turbo's TUI. Every field here is configuration the process resolved at boot, and
 * none of it is a secret: a credential appears as the *mode* that authenticated (the variable's name
 * or pi-ai's label for it), never as its value, and a webhook route as whether its secret is set.
 * The dashboard and the CLI read it to say which backend they are on and why.
 */

/** The model backend the process runs: pi-ai's Anthropic provider, or its scripted faux one. */
export const ServerModelBackend = Schema.Literals(["anthropic", "faux"]);
export type ServerModelBackend = typeof ServerModelBackend.Type;

/**
 * What chose the backend (LOB-258): `MODEL_BACKEND` named it, a credential pi-ai accepts resolved
 * (so anthropic), or none did (so faux).
 */
export const BackendSelection = Schema.Literals([
  "MODEL_BACKEND",
  "credential",
  "no_credential",
]);
export type BackendSelection = typeof BackendSelection.Type;

/** One `ROLE_MODELS` row as the boot resolved it: a board role and the `provider/modelId` it runs. */
export const RoleModelRow = Schema.Struct({
  role: Schema.String,
  model: Schema.String,
});
export type RoleModelRow = typeof RoleModelRow.Type;

/**
 * How the model backend authenticates: pi-ai's label for the source (`ANTHROPIC_API_KEY`,
 * `workload identity federation`) and the credential's type. A name, never a value.
 */
export const ModelAuthMode = Schema.Struct({
  source: Schema.String,
  type: Schema.Literals(["api_key", "oauth"]),
});
export type ModelAuthMode = typeof ModelAuthMode.Type;

/**
 * Which credential each outbound identity uses — the mode, never the credential.
 *
 * - `model`: what authenticates the model backend; `null` under faux, which needs none (a key that is
 *   set while `MODEL_BACKEND=faux` is not in use, so it is not reported as one).
 * - `forge`: what the PR step pushes and opens with (LOB-51): one static token, or a GitHub App;
 *   `none` when neither is configured (no `GITHUB_TOKEN`, no `GITHUB_APP_ID`), so every PR step fails
 *   with `missing`.
 * - `reviewer`: the review agent's own identity (LOB-36), or `none`, when reviews are recorded and
 *   not posted.
 */
export const CredentialMode = Schema.Struct({
  model: Schema.NullOr(ModelAuthMode),
  forge: Schema.Literals(["static-token", "github-app", "none"]),
  reviewer: Schema.Literals(["github-app", "token", "none"]),
});
export type CredentialMode = typeof CredentialMode.Type;

/**
 * One inbound webhook route (LOB-266): armed when the variable holding its secret is set. An unarmed
 * route answers every delivery `503`. `variable` is the name to set, not its value.
 */
export const WebhookRouteState = Schema.Struct({
  route: Schema.String,
  armed: Schema.Boolean,
  variable: Schema.String,
});
export type WebhookRouteState = typeof WebhookRouteState.Type;

/**
 * Whether the PR step and a merge are mirrored on the Linear issue a session came from (LOB-15), and
 * through which workflow states. The states are present exactly when it is on.
 */
export const LinearWriteBackState = Schema.Struct({
  enabled: Schema.Boolean,
  states: Schema.optional(
    Schema.Struct({
      started: Schema.String,
      inReview: Schema.String,
      done: Schema.String,
    }),
  ),
});
export type LinearWriteBackState = typeof LinearWriteBackState.Type;

export const ServerInfo = Schema.Struct({
  backend: ServerModelBackend,
  selectedBy: BackendSelection,
  /** The boot's own line for the choice: `model backend: faux (selected by MODEL_BACKEND)`. */
  reason: Schema.String,
  /**
   * What the boot warned about the choice: under faux, that sessions get scripted answers, and how
   * to get a real model. Empty on anthropic. A client shows these rather than inventing its own.
   */
  warnings: Schema.Array(Schema.String),
  /** The model a session with no role row talks to, `provider/modelId` (`faux/faux-1` under faux). */
  defaultModel: Schema.String,
  /** The `ROLE_MODELS` rows, resolved against the catalog at boot, by role. */
  roleModels: Schema.Array(RoleModelRow),
  /** Every model the catalog serves, `provider/modelId`, sorted: what a replay may name. */
  models: Schema.Array(Schema.String),
  /** The command prefixes that wait for a person's approval (`APPROVAL_REQUIRED`, D15). */
  approvalRequired: Schema.Array(Schema.String),
  /** The spend ceiling a session gets when its create names none (`SESSION_BUDGET`), in USD. */
  defaultBudget: Schema.optional(Schema.Finite),
  credentialMode: CredentialMode,
  webhooks: Schema.Array(WebhookRouteState),
  linearWriteBack: LinearWriteBackState,
  /** Where sessions' commands run (LOB-244): the configured `SandboxRuntime`'s name. */
  sandbox: Schema.String,
});
export type ServerInfo = typeof ServerInfo.Type;

/** `getServerInfo` takes nothing: there is one control plane per process. */
export const GetServerInfoInput = Schema.Struct({});
export type GetServerInfoInput = typeof GetServerInfoInput.Type;
