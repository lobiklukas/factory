import { SessionService } from "@repo/core";
import { ApprovalsRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { attributed } from "./Auth";

/**
 * The approval RPC handlers (docs/design.md D11). Each one is a call into `SessionService`, which
 * owns the policy: what a request is, when a decision settles it (and resumes the session, when the
 * caller asks — LOB-53), and what the pending lists hold.
 *
 * They are served from the same `/rpc` endpoint as the session group, because `RpcApi` is their
 * merge; `Session.ts` provides both sets of handlers to that one server.
 */
export const ApprovalsRpcHandlers = ApprovalsRpc.toLayer(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return ApprovalsRpc.of({
      requestApproval: (input) => sessions.requestApproval(input),
      // The decision is the credential's actor's, not the body's (LOB-20).
      decideApproval: (input) =>
        attributed(input).pipe(Effect.flatMap(sessions.decideApproval)),
      listApprovals: (input) => sessions.listApprovals(input.sessionId),
      listPendingApprovals: (input) => sessions.listPendingApprovals(input),
    });
  }),
);
