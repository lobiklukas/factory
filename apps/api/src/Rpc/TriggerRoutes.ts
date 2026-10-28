import { TriggerRoutes } from "@repo/core";
import { TriggerRoutesRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";

/**
 * The stored trigger routes over RPC (LOB-266): thin calls into `TriggerRoutes`, which holds the
 * policy (a route names a registered repo) the CLI and the dashboard must not each re-derive.
 */
export const TriggerRoutesRpcHandlers = TriggerRoutesRpc.toLayer(
  Effect.gen(function* () {
    const routes = yield* TriggerRoutes;
    return TriggerRoutesRpc.of({
      addTriggerRoute: (input) => routes.add(input),
      listTriggerRoutes: () =>
        routes.list.pipe(Effect.map((list) => ({ routes: list }))),
      removeTriggerRoute: (input) => routes.remove(input.id),
    });
  }),
);
