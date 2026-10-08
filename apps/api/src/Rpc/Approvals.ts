import { SessionService } from "@repo/core";
import { ApprovalRequest, ApprovalDecision, RpcApi } from "@repo/domain/Rpc";
import { Effect, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

const ApprovalsRpcHandlers = RpcApi.toLayer(
  Effect.gen(function* () {
    const service = yield* SessionService;
    return RpcApi.of({
      createApproval: (input) => service.createApproval(input),
      decideApproval: (input) => service.decideApproval(input),
    });
  }),
);

export const ApprovalsRpcLive = RpcServer.layerHttp({
  group: RpcApi,
  path: "/rpc/approvals",
  protocol: "http",
}).pipe(
  Layer.provide(ApprovalsRpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
);
