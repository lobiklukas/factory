/**
 * `factory budget`'s line (C23): the cap now in force and the spend it is measured against.
 *
 * The RPC it calls is proven over the wire by `apps/api/src/Rpc/Session.test.ts`, the raise itself
 * by `packages/harness/src/budget.test.ts`, and the command in a terminal by
 * `.pi/skills/verify-cli/budget.sh`.
 */
import { SessionId, type SessionSummary } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { budgetLine } from "./budget";

const SESSION = SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs");

const summary: SessionSummary = {
  id: SESSION,
  title: "a run",
  status: "idle",
  mode: "live",
  createdAt: "2026-10-28T00:00:00.000Z",
};

describe("budgetLine", () => {
  it("names the session, the new cap and the spend, to the hundredth of a cent", () => {
    expect(
      budgetLine({
        session: summary,
        budget: { cap: 2.5, spent: 0.01 },
        message: "unused",
      }),
    ).toBe(`capped ${SESSION}: $2.5000 cap, $0.0100 spent`);
  });
});
