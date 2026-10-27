/**
 * `factory discard`'s line (LOB-268): the call that released the workspace says so, and a repeat
 * names the release that came first — its reason and time — rather than claiming it again.
 *
 * The RPC it calls is proven over the wire by `apps/api/src/Rpc/Session.test.ts` and by
 * `.pi/skills/verify-api/sigterm.sh`'s discard checks.
 */
import { SessionId } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { discardLine } from "./discard";

const SESSION = SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs");

describe("discardLine", () => {
  it("says the first discard removed the worktree and branch", () => {
    expect(
      discardLine({
        sessionId: SESSION,
        first: true,
        release: { reason: "discarded", at: "2026-10-28T00:00:00.000Z" },
      }),
    ).toBe(`discarded ${SESSION}: its worktree and branch are removed`);
  });

  it("names the earlier release on a repeat, with the reason that released it", () => {
    expect(
      discardLine({
        sessionId: SESSION,
        first: false,
        release: { reason: "merged", at: "2026-10-27T12:00:00.000Z" },
      }),
    ).toBe(
      `${SESSION} was already released (merged at 2026-10-27T12:00:00.000Z)`,
    );
  });
});
