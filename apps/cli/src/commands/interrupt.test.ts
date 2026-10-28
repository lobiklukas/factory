/**
 * `factory interrupt`'s line (C8): a stopped run names the status the session settled in, and a
 * session with no run says `not running` first, so a script can match it.
 *
 * The RPC it calls is proven over the wire by `apps/api/src/Rpc/Session.test.ts`, the stop itself by
 * `packages/core/src/SessionService.interrupt.test.ts`, and the command in a terminal by
 * `.pi/skills/verify-cli/interrupt.sh`.
 */
import { SessionId, type SessionSummary } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { interruptLine } from "./interrupt";

const SESSION = SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs");

const summary: SessionSummary = {
  id: SESSION,
  title: "a run",
  status: "idle",
  mode: "live",
  createdAt: "2026-10-28T00:00:00.000Z",
};

describe("interruptLine", () => {
  it("names the settled status of a run it stopped", () => {
    expect(
      interruptLine({
        session: summary,
        outcome: "interrupted",
        message: "unused",
      }),
    ).toBe(`interrupted ${SESSION}: idle`);
  });

  it("leads with not running when there was no run to stop", () => {
    expect(
      interruptLine({
        session: summary,
        outcome: "not_running",
        message: "unused",
      }),
    ).toBe(`not running: ${SESSION} is idle`);
  });
});
