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
import {
  DASHBOARD_ACTOR,
  bySession,
  decisionFor,
  inboxSummary,
  resumeRetryCommand,
} from "./approvals-view";

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

describe("inboxSummary", () => {
  it("reads the total, not the page length", () => {
    expect(inboxSummary(1, 1)).toBe("1 request is waiting for a person.");
    expect(inboxSummary(3, 3)).toBe("3 requests are waiting for a person.");
  });

  it("says the page was cut when more are pending than shown", () => {
    const summary = inboxSummary(100, 140);
    expect(summary).toContain("140 requests are waiting");
    expect(summary).toContain("Showing the newest 100");
  });
});

describe("resumeRetryCommand", () => {
  it("names the request, because nothing is pending once the decision is on file", () => {
    expect(resumeRetryCommand(request(ONE, "ask-1"), "approved")).toBe(
      `factory approve ${ONE} --id ask-1`,
    );
    expect(resumeRetryCommand(request(TWO, "ask-2"), "denied")).toBe(
      `factory deny ${TWO} --id ask-2`,
    );
  });
});
