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
 * what authenticated, the webhook routes are read from the environment as set-or-not, the Linear
 * write-back contributes its state names (its key stays in `LinearConfig`), and the reviewer is the
 * identity kind the boot selected. `describeServer` is the one place a fact becomes an answer, and
 * `ServerInfo.test.ts` asserts a known credential appears nowhere in it.
 */
export type ServerFactsShape = {
  readonly choice: ModelBackendChoice;
  /** The deployment's model access: its default model and the catalog it serves. */
  readonly model: ModelAccess;
  /** `ROLE_MODELS`, resolved against the catalog. */
  readonly roleModels: RoleModels;
  readonly approvalRequired: readonly string[];
  readonly defaultBudget: Option.Option<number>;
  /** The webhook secrets' environment: each route is armed when its variable is set. */
  readonly webhookEnv: Env;
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
 * read from the provider itself rather than from the configuration that chose it.
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
    forge,
    reviewer: facts.reviewer,
  },
  webhooks: [...webhookRouteStates(facts.webhookEnv)],
  linearWriteBack:
    facts.linearStates === undefined
      ? { enabled: false }
      : { enabled: true, states: { ...facts.linearStates } },
  sandbox: facts.sandbox,
});
