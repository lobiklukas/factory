/**
 * `factory approve` / `deny` without `--id`, and `factory approvals`' row (LOB-53).
 *
 * The commands themselves are proven by `.pi/skills/verify-cli/approve.sh`, which decides a gated
 * call's approval in a real terminal and reads the resumed run back. These cases are the ones a pane
 * capture would not localize: which request a bare `approve` decides, that it refuses to guess
 * between two, and which field of a row a script reads the request id from.
 */
import { Result, Schema } from "effect";
import { ApprovalRequest } from "@repo/domain/Approval";
import { SessionId } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { APPROVALS_HEADER, approvalRow, pickPending } from "./approve";

const SESSION = Schema.decodeSync(SessionId)("ses_01m5yvfya2tsyn56ycr5jj3pvs");

const request = (requestId: string, action = "sleep"): ApprovalRequest =>
  Schema.decodeSync(ApprovalRequest)({
    sessionId: SESSION,
    requestId,
    action,
    detail: "",
    requestedAt: "2026-10-27T10:00:00.000Z",
  });

describe("pickPending", () => {
  it("decides the only pending request", () => {
    const only = request("ask-bash-1");
    expect(pickPending(SESSION, [only])).toEqual(Result.succeed(only));
  });

  it("is not_found when nothing is pending, so a script cannot read it as a decision", () => {
    const picked = pickPending(SESSION, []);
    expect(Result.isFailure(picked)).toBe(true);
    if (!Result.isFailure(picked)) throw new Error("unreachable");
    expect(picked.failure.code).toBe("not_found");
    expect(picked.failure.message).toContain(SESSION);
  });

  it("refuses to guess between two, and names both ids to pass as --id", () => {
    const picked = pickPending(SESSION, [request("first"), request("second")]);
    expect(Result.isFailure(picked)).toBe(true);
    if (!Result.isFailure(picked)) throw new Error("unreachable");
    expect(picked.failure.code).toBe("invalid_input");
    expect(picked.failure.message).toContain("--id");
    expect(picked.failure.message).toContain("first, second");
  });
});

describe("approvalRow", () => {
  it("puts the request id first and the session second, and the action last", () => {
    const row = approvalRow(request("ask-bash-1", "npm publish"));
    const header = APPROVALS_HEADER.split(/\s+/);
    const fields = row.split(/\s+/);
    expect(fields[header.indexOf("request")]).toBe("ask-bash-1");
    expect(fields[header.indexOf("session")]).toBe(SESSION);
    expect(header.at(-1)).toBe("action");
    // An action with a space cannot shift the fields before it.
    expect(row.endsWith("  npm publish")).toBe(true);
  });
});
