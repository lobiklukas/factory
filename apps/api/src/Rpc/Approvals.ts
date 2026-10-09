import { SessionService } from "@repo/core";
import { ApprovalsRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";

/**
 * The approval RPC handlers (docs/design.md D11). Each one is a call into `SessionService`, which
 * owns the policy: what a request is, when a decision settles it, and what the pending list holds.
 *
 * They are served from the same `/rpc` endpoint as the session group, because `RpcApi` is their
 * merge; `Session.ts` provides both sets of handlers to that one server.
 */
export const ApprovalsRpcHandlers = ApprovalsRpc.toLayer(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return ApprovalsRpc.of({
      requestApproval: (input) => sessions.requestApproval(input),
      decideApproval: (input) => sessions.decideApproval(input),
      listApprovals: (input) => sessions.listApprovals(input.sessionId),
    });
  }),
);
