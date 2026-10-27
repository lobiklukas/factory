import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { CheckSquareIcon } from "lucide-react";
import { pendingApprovalsAtom } from "@/lib/atoms/board-atom";
import { bySession } from "@/lib/approvals-view";
import { ApprovalItem } from "@/components/approvals";
import { EmptyPane } from "@/components/empty-pane";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/approvals")({
  component: ApprovalsRoute,
});

/**
 * Every run's pending approvals, decided in place (LOB-53): the operator's inbox.
 *
 * A server read and nothing else — `listPendingApprovals`, the same index each run's Approvals pane
 * reads, without the session filter — polled, and re-read at once when a decision from this page
 * lands. One block per run, oldest ask first, each naming the session it parks and linking to it.
 * An approval still belongs to a run (LOB-76): the card's Approvals pane is where a person working a
 * card answers it, and this pane is where someone who is not working any card finds what waits.
 *
 * A decision resumes its session (`decisionFor`): the parked run wakes with the answer, so the row
 * leaves this list and the run goes on without anyone typing a message.
 */
function ApprovalsRoute() {
  const result = useAtomValue(pendingApprovalsAtom);

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading approvals</span>
        {[0, 1].map((row) => (
          <Skeleton key={row} className="h-20 w-full max-w-xl" aria-hidden />
        ))}
      </div>
    );
  }

  if (AsyncResult.isFailure(result)) {
    return (
      <EmptyPane
        icon={<CheckSquareIcon strokeWidth={1.75} />}
        title="The approvals did not load"
        detail={Cause.pretty(result.cause)}
        visible
      />
    );
  }

  const { approvals } = result.value;
  return (
    <EmptyPane
      icon={<CheckSquareIcon strokeWidth={1.75} />}
      title="No approvals pending"
      detail="No run is waiting on a person. A command this deployment gates (APPROVAL_REQUIRED) parks its run here until someone approves or denies it."
      visible={approvals.length === 0}
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6"
        data-approvals-inbox
      >
        <h1 className="mb-1 text-sm font-medium">Approvals</h1>
        <p className="mb-4 max-w-xl text-xs text-muted-foreground">
          {approvals.length === 1
            ? "1 request is waiting for a person."
            : `${approvals.length} requests are waiting for a person.`}{" "}
          A decision resumes the run that asked.
        </p>
        <div className="flex max-w-xl flex-col gap-4">
          {bySession(approvals).map(({ sessionId, requests }) => (
            <section
              key={sessionId}
              aria-label={`Waiting in ${sessionId}`}
              className="flex flex-col gap-2"
            >
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId }}
                className="truncate font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {sessionId}
              </Link>
              <ul className="flex flex-col gap-2">
                {requests.map((request) => (
                  <ApprovalItem key={request.requestId} request={request} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </EmptyPane>
  );
}
