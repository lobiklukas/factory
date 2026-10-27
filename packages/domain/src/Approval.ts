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
  /**
   * The follow-up message that handed the session this decision (LOB-53): the submission id the
   * session's queue knows it by. Present only when the caller asked to `resume` the session.
   */
  resumedWith: Schema.optional(Schema.String),
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
 * Every session's pending requests (LOB-53): what the dashboard's `/approvals` pane and
 * `factory approvals` list. A page of at most `limit` (the server clamps it), oldest first.
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
