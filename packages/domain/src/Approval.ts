/**
 * Approval contracts (docs/design.md D11): a session asks a person before a gated tool call runs,
 * and a person answers. This file is the wire shape only; the record itself is committed to the
 * session's log by `packages/core` and `packages/harness`.
 *
 * A request is identified by a caller-supplied `requestId`, so a retried request is the same
 * request. A decision names an `actor` the caller supplies: the control plane does not yet know
 * who is at the other end (LOB-20 owns identity).
 */
import { Schema } from "effect";
import { SessionId, Timestamp } from "@repo/domain/Ids";

/** What a session asks to do, and why. The request is pending until a decision settles it. */
export const ApprovalRequest = Schema.Struct({
  sessionId: SessionId,
  requestId: Schema.String,
  /** The gated action, in the words the policy used (for example `push refs/heads/main`). */
  action: Schema.String,
  /** Whatever the asker wants a person to see before deciding. May be empty. */
  detail: Schema.String,
  requestedAt: Timestamp,
});
export type ApprovalRequest = typeof ApprovalRequest.Type;

export const ApprovalVerdict = Schema.Literals(["approved", "denied"]);
export type ApprovalVerdict = typeof ApprovalVerdict.Type;

/** The settled answer to one request. `actor` is whatever the caller said it was. */
export const ApprovalDecision = Schema.Struct({
  sessionId: SessionId,
  requestId: Schema.String,
  decision: ApprovalVerdict,
  actor: Schema.String,
  decidedAt: Timestamp,
});
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const RequestApprovalInput = Schema.Struct({
  sessionId: SessionId,
  requestId: Schema.String,
  action: Schema.String,
  detail: Schema.optional(Schema.String),
});
export type RequestApprovalInput = typeof RequestApprovalInput.Type;

export const DecideApprovalInput = Schema.Struct({
  sessionId: SessionId,
  requestId: Schema.String,
  decision: ApprovalVerdict,
  actor: Schema.String,
  /**
   * Hand the session the decision as a follow-up message once it is recorded (LOB-53), so a run
   * that parked on the approval resumes: approved, the agent runs the call; denied, it carries on
   * without it. The message is deduplicated by the request id, so repeating the decision resumes
   * once. Absent or `false`: the decision is recorded and nothing else happens.
   */
  resume: Schema.optional(Schema.Boolean),
});
export type DecideApprovalInput = typeof DecideApprovalInput.Type;

/**
 * Why a recorded decision did not resume its session (LOB-53): the follow-up `send` failed after the
 * decision was committed. `code` is the `SessionError` code the send failed with.
 */
export const ApprovalResumeFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type ApprovalResumeFailure = typeof ApprovalResumeFailure.Type;

/**
 * What `decideApproval` answers: the decision on file, and — when the caller asked to `resume` — what
 * became of the follow-up. Only this answer carries the resume; the saved decision is
 * `ApprovalDecision`, which every other read returns.
 *
 * A decision is committed before the follow-up is sent, so a failed send is not a failed decision:
 * the call succeeds with `resumeFailed` and no `resumedWith`. Repeating the same decision with
 * `resume` is idempotent and sends the follow-up again under the same request id.
 */
export const DecideApprovalOutput = Schema.Struct({
  ...ApprovalDecision.fields,
  /** The follow-up's submission id, the one the session's queue knows it by. */
  resumedWith: Schema.optional(Schema.String),
  /** The decision is recorded, but the follow-up was not sent: the session is still parked. */
  resumeFailed: Schema.optional(ApprovalResumeFailure),
});
export type DecideApprovalOutput = typeof DecideApprovalOutput.Type;

/**
 * Every session's pending requests (LOB-53): what the dashboard's `/approvals` pane and
 * `factory approvals` list. A page of at most `limit` (the server clamps it), newest first — a
 * request nobody will answer (its session abandoned) never expires, so newest first is what keeps a
 * run that parked just now on the page however many stale ones have piled up.
 */
export const ListPendingApprovalsInput = Schema.Struct({
  limit: Schema.optional(Schema.Int),
});
export type ListPendingApprovalsInput = typeof ListPendingApprovalsInput.Type;

/** The requests still waiting for a decision, oldest first. */
export const ListApprovalsOutput = Schema.Struct({
  approvals: Schema.Array(ApprovalRequest),
});
export type ListApprovalsOutput = typeof ListApprovalsOutput.Type;

/**
 * One page of every session's pending requests, newest first, and how many are pending in all: when
 * `total` exceeds `approvals.length` the page was cut, and a reader says so rather than reading the
 * page's length as the count.
 */
export const ListPendingApprovalsOutput = Schema.Struct({
  approvals: Schema.Array(ApprovalRequest),
  total: Schema.Int,
});
export type ListPendingApprovalsOutput = typeof ListPendingApprovalsOutput.Type;
