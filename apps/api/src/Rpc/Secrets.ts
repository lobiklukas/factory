import { SecretService } from "@repo/core";
import { SecretsRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { attributed } from "./Auth";

/**
 * A repository's secrets over RPC (S-agent-secrets): thin calls into `SecretService`. No handler
 * here answers a value — `setSecret` answers the summary it stored, and `listSecrets` and
 * `deleteSecret` summaries — and none calls `reveal`, the store's one decrypting read, which is the
 * session service's alone. `setSecret` is the credential's actor's (LOB-20).
 */
export const SecretsRpcHandlers = SecretsRpc.toLayer(
  Effect.gen(function* () {
    const secrets = yield* SecretService;
    return SecretsRpc.of({
      setSecret: (input) => attributed(input).pipe(Effect.flatMap(secrets.set)),
      listSecrets: (input) => secrets.list(input.repo),
      deleteSecret: (input) => secrets.remove(input.repo, input.name),
    });
  }),
);
