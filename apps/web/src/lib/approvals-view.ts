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
 * The terminal retry for a decision that was recorded but did not resume its session (LOB-53). It
 * names the request: once the decision is on file nothing is pending, so a bare `factory approve`
 * would find nothing to decide, while the same decision by id is idempotent and resends.
 */
export const resumeRetryCommand = (
  request: Pick<ApprovalRequest, "sessionId" | "requestId">,
  decision: ApprovalVerdict,
): string =>
  `factory ${decision === "approved" ? "approve" : "deny"} ${request.sessionId} --id ${request.requestId}`;

/**
 * The pending requests grouped by the session that asked, in the order the server listed them: the
 * session of the newest request first, and each session's requests newest first. `/approvals` shows
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

/**
 * The count `/approvals` reads out (LOB-53). The server answers one page, newest first, and the
 * total pending; when the page was cut the sentence says how many are shown of how many, so the
 * page's length is never read as the count.
 */
export const inboxSummary = (shown: number, total: number): string => {
  const waiting =
    total === 1
      ? "1 request is waiting for a person."
      : `${total} requests are waiting for a person.`;
  return total > shown
    ? `${waiting} Showing the newest ${shown}; deciding them brings the rest in.`
    : waiting;
};
