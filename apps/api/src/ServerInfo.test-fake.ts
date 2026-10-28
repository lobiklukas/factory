import { createFauxModelAccess, NO_ROLE_MODELS } from "@repo/harness";
import { Layer, Option } from "effect";
import { ServerFacts } from "./ServerInfo";

/**
 * The boot facts of a faux deployment with nothing else configured, for an RPC suite that serves
 * `SessionRpcLive` and never asks `getServerInfo` (LOB-269): the router needs `ServerFacts` to
 * build, and a suite about sessions or cards has no boot to take them from.
 */
export const FauxServerFacts = Layer.succeed(ServerFacts, {
  choice: { backend: "faux", forced: true, unread: [] },
  model: createFauxModelAccess().access,
  roleModels: NO_ROLE_MODELS,
  approvalRequired: [],
  defaultBudget: Option.none(),
  webhooks: [],
  githubTokenSet: false,
  linearStates: undefined,
  reviewer: "none",
  sandbox: "in-process",
});
