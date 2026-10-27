import type {
  ApprovalRequest,
  ApprovalVerdict,
  DecideApprovalInput,
} from "@repo/domain/Approval";

/**
 * Who the dashboard says made a decision or a move. A person, by construction: a run's actor is its
 * session id (B1), and this string is not one, so `TaskService` lets it cross a human gate. Identity
 * beyond an actor string is LOB-20's; `factory approve` and `factory board move` say `cli` for the
 * same reason.
 */
export const DASHBOARD_ACTOR = "dashboard";

/**
 * What a click on Approve or Deny sends (LOB-53), wherever the request is shown — the card's
 * Approvals pane, the session pane, or `/approvals`. One function so the three cannot drift.
 *
 * `resume` is always on: a person answering a parked run means the run should go on, so the service
 * hands the session the decision as a follow-up and the approved call runs on the turn it wakes —
 * the same thing `factory approve` does.
 */
export const decisionFor = (
  request: Pick<ApprovalRequest, "sessionId" | "requestId">,
  decision: ApprovalVerdict,
): DecideApprovalInput => ({
  sessionId: request.sessionId,
  requestId: request.requestId,
  decision,
  actor: DASHBOARD_ACTOR,
  resume: true,
});

/**
 * The pending requests grouped by the session that asked, in the order the server listed them: the
 * session of the oldest request first, and each session's requests oldest first. `/approvals` shows
 * one block per run so two asks from one run read as one run waiting, not two strangers.
 */
export const bySession = (
  approvals: ReadonlyArray<ApprovalRequest>,
): ReadonlyArray<{
  readonly sessionId: ApprovalRequest["sessionId"];
  readonly requests: ReadonlyArray<ApprovalRequest>;
}> => {
  const groups = new Map<
    string,
    {
      readonly sessionId: ApprovalRequest["sessionId"];
      readonly requests: ApprovalRequest[];
    }
  >();
  for (const request of approvals) {
    const group = groups.get(request.sessionId);
    if (group === undefined) {
      groups.set(request.sessionId, {
        sessionId: request.sessionId,
        requests: [request],
      });
    } else {
      group.requests.push(request);
    }
  }
  return Array.from(groups.values());
};
