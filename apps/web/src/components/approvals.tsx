import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit } from "effect";
import { ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import type { ApprovalRequest, ApprovalVerdict } from "@repo/domain/Approval";
import type { SessionId } from "@repo/domain/Session";
import { approvalsAtom, decideApprovalAtom } from "@/lib/atoms/board-atom";
import { decisionFor } from "@/lib/approvals-view";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * One pending approval (D11) with the decision beside it: the action the gate named, what the asker
 * wanted a person to see, and Approve / Deny. The same row in the card's Approvals pane, the session
 * pane, and `/approvals` (LOB-53), so a decision reads and behaves one way wherever it is made.
 *
 * The click sends `decisionFor`, which resumes the session: the parked run wakes with the answer.
 * The row is not removed here — it leaves when the pending list the server answers no longer holds
 * it, so "decided" on screen is the server's word, not this page's.
 */
export const ApprovalItem = ({
  request,
}: {
  readonly request: ApprovalRequest;
}) => {
  const decide = useAtomSet(decideApprovalAtom, { mode: "promiseExit" });
  // In flight: both buttons stay disabled until the RPC answers, so a double click cannot send two
  // decisions.
  const [deciding, setDeciding] = useState(false);

  const onDecide = (decision: ApprovalVerdict) => {
    setDeciding(true);
    void decide(decisionFor(request, decision))
      .then((exit) => {
        if (Exit.isFailure(exit)) {
          toast.error("The decision was not recorded", {
            description: Cause.pretty(exit.cause),
          });
        }
      })
      .finally(() => setDeciding(false));
  };

  return (
    <li
      data-approval={request.requestId}
      data-approval-session={request.sessionId}
      className="flex flex-col gap-1.5 border border-border p-3"
    >
      <span className="font-mono text-[11px]">{request.action}</span>
      {request.detail.length === 0 ? null : (
        <span className="font-mono text-[11px] break-all text-muted-foreground">
          {request.detail}
        </span>
      )}
      <span className="font-mono text-[10px] text-muted-foreground">
        {request.requestId} · asked {request.requestedAt}
      </span>
      <span className="flex gap-2">
        {(["approved", "denied"] as const).map((decision) => (
          <Button
            key={decision}
            type="button"
            size="sm"
            variant={decision === "approved" ? "default" : "outline"}
            data-decide={decision}
            disabled={deciding}
            aria-busy={deciding}
            onClick={() => onDecide(decision)}
          >
            {decision === "approved" ? "Approve" : "Deny"}
          </Button>
        ))}
      </span>
    </li>
  );
};

/**
 * What one run is waiting on a person for: its pending approvals, oldest first. The card pane's
 * Approvals tab (LOB-76), which says so when the run is waiting on nothing.
 */
export const RunApprovals = ({
  sessionId,
}: {
  readonly sessionId: SessionId;
}) => {
  const pending = useAtomValue(approvalsAtom(sessionId));

  if (AsyncResult.isInitial(pending)) {
    return <Spinner className="m-4 size-3.5 text-muted-foreground" />;
  }
  if (AsyncResult.isFailure(pending)) {
    return (
      <p className="p-4 text-xs text-destructive">
        The approvals did not load: {Cause.pretty(pending.cause)}
      </p>
    );
  }
  if (pending.value.approvals.length === 0) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-no-approvals>
        This run is not waiting on an approval.
      </p>
    );
  }
  return (
    <ul aria-label="Pending approvals" className="flex flex-col gap-2 p-4">
      {pending.value.approvals.map((request) => (
        <ApprovalItem key={request.requestId} request={request} />
      ))}
    </ul>
  );
};

/**
 * The session pane's notice (LOB-53): a run parked on an approval says so above its transcript, with
 * the decision in reach. Nothing at all while the list loads or is empty — a session that is not
 * waiting has nothing to announce, and a strip that blinked in and out on every poll would be noise.
 */
export const SessionApprovals = ({
  sessionId,
}: {
  readonly sessionId: SessionId;
}) => {
  const pending = useAtomValue(approvalsAtom(sessionId));
  if (!AsyncResult.isSuccess(pending)) return null;
  const { approvals } = pending.value;
  if (approvals.length === 0) return null;
  return (
    <section
      aria-label="Waiting for approval"
      data-session-approvals={sessionId}
      className="shrink-0 border-b border-border bg-muted/40 px-4 py-3"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-xs font-medium">
          <ShieldAlertIcon className="size-3.5" strokeWidth={1.75} />
          {approvals.length === 1
            ? "This run is waiting for an approval"
            : `This run is waiting for ${approvals.length} approvals`}
        </h2>
        <Link
          to="/approvals"
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Every run&apos;s approvals
        </Link>
      </div>
      <ul className="flex flex-col gap-2">
        {approvals.map((request) => (
          <ApprovalItem key={request.requestId} request={request} />
        ))}
      </ul>
    </section>
  );
};
