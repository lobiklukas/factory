import { createFileRoute } from "@tanstack/react-router";
import { EmptyPane } from "@/components/empty-pane";

export const Route = createFileRoute("/approvals")({
  component: ApprovalsRoute,
});

/**
 * Deliberately empty.
 *
 * There is no approval RPC group: `packages/domain`'s `RpcApi` is still
 * `SessionRpc` alone, and policy enforcement is M3 (docs/handoff.md). Claiming a
 * pending-approval list here would be a table with no source behind it, which is
 * worse than an honest gap — a user would file a bug against work that does not
 * exist yet.
 */
function ApprovalsRoute() {
  return (
    <EmptyPane
      title="No approvals pending"
      detail="Policy enforcement and durable approval memos are M3 (docs/handoff.md). Tool calls are not gated yet, so there is nothing to approve or deny."
      visible
    />
  );
}
