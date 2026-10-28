import type { CredentialSource, LinearStates } from "@repo/core";
import type { ServerInfo, WebhookRouteState } from "@repo/domain/Server";
import {
  catalogModels,
  modelKey,
  type ModelAccess,
  type RoleModels,
} from "@repo/harness";
import { Context, Option } from "effect";
import { type Env, WEBHOOK_ROUTES } from "./Api/WebhookBoot";
import {
  describeModelBackend,
  modelBackendWarnings,
  type ModelBackendChoice,
} from "./ModelBackend";

/**
 * What `getServerInfo` answers from (LOB-269): the values the boot resolved, held as the boot holds
 * them, so the answer and the boot's log lines are computed from one set of facts and cannot drift.
 *
 * No credential is in here, by construction: the model backend's choice holds pi-ai's *label* for
 * what authenticated, the webhook routes are resolved at boot to armed-or-not (the secrets' values
 * never enter this service), the forge contributes whether a static token is set, the Linear
 * write-back its state names (its key stays in `LinearConfig`), and the reviewer the identity kind
 * the boot selected. `describeServer` is the one place a fact becomes an answer, and
 * `Rpc/Server.test.ts` and `boot.test.ts` assert a known credential appears nowhere in it.
 */
export type ServerFactsShape = {
  readonly choice: ModelBackendChoice;
  /** The deployment's model access: its default model and the catalog it serves. */
  readonly model: ModelAccess;
  /** `ROLE_MODELS`, resolved against the catalog. */
  readonly roleModels: RoleModels;
  readonly approvalRequired: readonly string[];
  readonly defaultBudget: Option.Option<number>;
  /** Every webhook route and whether its secret is set, resolved at boot (`webhookRouteStates`). */
  readonly webhooks: ReadonlyArray<WebhookRouteState>;
  /**
   * Whether `GITHUB_TOKEN` is set to a non-empty value. Under the static-token provider an unset one
   * means no forge credential is in use, which the answer reports as `none`.
   */
  readonly githubTokenSet: boolean;
  /** The write-back's state names when a Linear key is configured; absent when none is. */
  readonly linearStates: LinearStates | undefined;
  readonly reviewer: "github-app" | "token" | "none";
  /** The sandbox runtime sessions' commands run through. */
  readonly sandbox: string;
};

/** The boot's resolved configuration, provided beside the RPC handlers that read it. */
export class ServerFacts extends Context.Service<
  ServerFacts,
  ServerFactsShape
>()("@repo/api/ServerFacts") {}

/** Every webhook route and whether its secret is set — the variable's name, never its value. */
export const webhookRouteStates = (
  env: Env,
): ReadonlyArray<WebhookRouteState> =>
  WEBHOOK_ROUTES.map(({ route, variable }) => ({
    route,
    armed: (env[variable] ?? "") !== "",
    variable,
  }));

/**
 * The answer to `getServerInfo`. `forge` is the credential source the PR step's provider selected,
 * read from the provider itself rather than from the configuration that chose it; a static-token
 * provider with no token behind it is reported as `none`, the way `model` is `null` and `reviewer`
 * is `none` when nothing authenticates them.
 */
export const describeServer = (
  facts: ServerFactsShape,
  forge: CredentialSource,
): ServerInfo => ({
  backend: facts.choice.backend,
  selectedBy: facts.choice.forced
    ? "MODEL_BACKEND"
    : facts.choice.backend === "anthropic"
      ? "credential"
      : "no_credential",
  reason: describeModelBackend(facts.choice),
  warnings: [...modelBackendWarnings(facts.choice)],
  defaultModel: modelKey(facts.model),
  roleModels: [...facts.roleModels]
    .map(([role, access]) => ({ role, model: modelKey(access) }))
    .sort((a, b) => a.role.localeCompare(b.role)),
  models: [...catalogModels(facts.model)],
  approvalRequired: [...facts.approvalRequired],
  ...Option.match(facts.defaultBudget, {
    onNone: () => ({}),
    onSome: (budget) => ({ defaultBudget: budget }),
  }),
  credentialMode: {
    model:
      facts.choice.backend === "anthropic"
        ? { source: facts.choice.auth.source, type: facts.choice.auth.type }
        : null,
    forge: forge === "static-token" && !facts.githubTokenSet ? "none" : forge,
    reviewer: facts.reviewer,
  },
  webhooks: [...facts.webhooks],
  linearWriteBack:
    facts.linearStates === undefined
      ? { enabled: false }
      : { enabled: true, states: { ...facts.linearStates } },
  sandbox: facts.sandbox,
});
