/**
 * What the dashboard's Approve and Deny send, and how `/approvals` groups what is waiting (LOB-53).
 *
 * The pane itself is driven by `.pi/skills/verify-web/drive.mjs`, which clicks Approve and reads the
 * request off the wire. These cases are the ones a click would not localize: that every decision
 * asks the service to resume the session, and that the grouping keeps the server's order.
 */
import { Schema } from "effect";
import { ApprovalRequest } from "@repo/domain/Approval";
import { describe, expect, it } from "vitest";
import { DASHBOARD_ACTOR, bySession, decisionFor } from "./approvals-view";

const ONE = "ses_01m5yvfya2tsyn56ycr5jj3pvs";
const TWO = "ses_01m5yvfya2tsyn56ycr5jj3pvt";

const request = (sessionId: string, requestId: string): ApprovalRequest =>
  Schema.decodeSync(ApprovalRequest)({
    sessionId,
    requestId,
    action: "sleep",
    detail: "",
    requestedAt: "2026-10-27T10:00:00.000Z",
  });

describe("decisionFor", () => {
  it("decides as the dashboard, and resumes the session it decides for", () => {
    expect(decisionFor(request(ONE, "ask-1"), "approved")).toEqual({
      sessionId: ONE,
      requestId: "ask-1",
      decision: "approved",
      actor: DASHBOARD_ACTOR,
      resume: true,
    });
    expect(decisionFor(request(TWO, "ask-2"), "denied")).toMatchObject({
      sessionId: TWO,
      decision: "denied",
      resume: true,
    });
  });
});

describe("bySession", () => {
  it("groups by the asking session in the order the server listed them", () => {
    const a = request(ONE, "a");
    const b = request(TWO, "b");
    const c = request(ONE, "c");
    expect(bySession([a, b, c])).toEqual([
      { sessionId: ONE, requests: [a, c] },
      { sessionId: TWO, requests: [b] },
    ]);
    expect(bySession([])).toEqual([]);
  });
});
