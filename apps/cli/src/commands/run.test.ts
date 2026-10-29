/**
 * What `factory run --open-pr` prints once the run settled (F17): the PR's link when the settle-time
 * step recorded one, the step's own sentence when it opened none, and nothing while neither is
 * there. The command is proven in a terminal by `.pi/skills/verify-cli/open-pr.sh`.
 */
import { SessionId, type SessionSnapshot } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { settledPrLine } from "./run";

const snapshot = (
  prUrl: string | undefined,
  others: readonly string[],
): SessionSnapshot => ({
  session: {
    id: SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs"),
    title: "a run",
    status: "idle",
    mode: "live",
    createdAt: "2026-10-28T00:00:00.000Z",
    ...(prUrl === undefined ? {} : { prUrl }),
  },
  workspace: { path: "/work/ses", commands: {}, commandsSource: "none" },
  entries: [
    { id: "1", kind: "user", text: "task", toolCalls: [] },
    { id: "2", kind: "assistant", text: "done", toolCalls: [] },
    ...others.map((text, index) => ({
      id: String(10 + index),
      kind: "other" as const,
      text,
      toolCalls: [],
    })),
  ],
  live: { busy: false, tools: [] },
  usage: { models: [], tools: [] },
  queued: [],
  tasks: [],
  approvals: [],
});

describe("settledPrLine", () => {
  it("prints the PR link once the session records one", () => {
    expect(
      settledPrLine(snapshot("https://github.com/a/b/pull/7", []), 0),
    ).toBe("pr https://github.com/a/b/pull/7");
  });

  it("prints the step's sentence when it wrote one and opened none", () => {
    expect(
      settledPrLine(
        snapshot(undefined, ["no change: the branch has nothing to publish"]),
        0,
      ),
    ).toBe("pr none: no change: the branch has nothing to publish");
  });

  it("waits while neither is there, and ignores a step line from before the run", () => {
    expect(settledPrLine(snapshot(undefined, []), 0)).toBeUndefined();
    expect(
      settledPrLine(snapshot(undefined, ["an earlier step"]), 1),
    ).toBeUndefined();
  });
});
