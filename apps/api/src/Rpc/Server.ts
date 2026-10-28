import { CredentialProvider } from "@repo/core";
import { ServerRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { describeServer, ServerFacts } from "../ServerInfo";

/**
 * What the control plane is running, over RPC (LOB-269): the boot's resolved facts, described by
 * `describeServer`, with the PR step's credential source read from the provider the process built.
 * Nothing here reads the database or a credential's value, so the answer is the same while Postgres
 * is down and holds nothing a log line could not.
 */
export const ServerRpcHandlers = ServerRpc.toLayer(
  Effect.gen(function* () {
    const facts = yield* ServerFacts;
    const credentials = yield* CredentialProvider;
    const info = describeServer(facts, credentials.source);
    return ServerRpc.of({
      getServerInfo: () => Effect.succeed(info),
    });
  }),
);
