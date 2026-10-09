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
import { ApprovalRequest, SessionId, Timestamp } from "./Session";

/** What a session asks to do, and why. The request is pending until a decision settles it. */
export { ApprovalRequest };

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
});
export type DecideApprovalInput = typeof DecideApprovalInput.Type;

/** The requests still waiting for a decision, oldest first. */
export const ListApprovalsOutput = Schema.Struct({
  approvals: Schema.Array(ApprovalRequest),
});
export type ListApprovalsOutput = typeof ListApprovalsOutput.Type;
