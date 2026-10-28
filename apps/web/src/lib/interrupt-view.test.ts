import { SessionId, type SessionSummary } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { interruptNotice } from "./interrupt-view";

const session: SessionSummary = {
  id: SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs"),
  title: "a run",
  status: "idle",
  mode: "live",
  createdAt: "2026-10-28T00:00:00.000Z",
};

describe("interruptNotice (C8)", () => {
  it("raises nothing for a stopped run: the transcript's row says it", () => {
    expect(
      interruptNotice({
        session,
        outcome: "interrupted",
        message: "session was interrupted",
      }),
    ).toBeNull();
  });

  it("tells a refused interrupt in the server's own sentence", () => {
    const message = `session ${session.id} is not running: there was no run to interrupt`;
    expect(
      interruptNotice({ session, outcome: "not_running", message }),
    ).toEqual({ title: "Nothing to interrupt", description: message });
  });
});
