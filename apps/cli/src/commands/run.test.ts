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
  steps: readonly string[],
  extra: {
    readonly entries?: SessionSnapshot["entries"];
    readonly approvals?: SessionSnapshot["approvals"];
  } = {},
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
    ...(extra.entries ?? []),
    ...steps.map((text, index) => ({
      id: String(10 + index),
      kind: "other" as const,
      text,
      toolCalls: [],
      prStep: true,
    })),
  ],
  live: { busy: false, tools: [] },
  usage: { models: [], tools: [] },
  queued: [],
  tasks: [],
  approvals: extra.approvals ?? [],
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

  it("does not read an approval or a page the run wrote as the step's answer", () => {
    const unrelated = [
      { id: "5", kind: "other" as const, text: "", toolCalls: [] },
      { id: "6", kind: "other" as const, text: "a page", toolCalls: [] },
    ];
    expect(
      settledPrLine(snapshot(undefined, [], { entries: unrelated }), 0),
    ).toBeUndefined();
    // The PR's own entry lands a moment before the session's link: not an answer on its own.
    expect(
      settledPrLine(
        snapshot(undefined, [], {
          entries: [{ id: "7", kind: "other", text: "", toolCalls: [] }],
        }),
        0,
      ),
    ).toBeUndefined();
    expect(
      settledPrLine(
        snapshot(undefined, ["no change"], { entries: unrelated }),
        0,
      ),
    ).toBe("pr none: no change");
  });

  it("reports a run parked on an approval as holding its pull request", () => {
    const approvals: SessionSnapshot["approvals"] = [
      {
        sessionId: SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs"),
        requestId: "apr_1",
        action: "push refs/heads/main",
        detail: "",
        requestedAt: "2026-10-28T00:00:00.000Z",
      },
    ];
    expect(settledPrLine(snapshot(undefined, [], { approvals }), 0)).toMatch(
      /^pr held: the run is waiting on an approval/,
    );
    expect(
      settledPrLine(
        snapshot("https://github.com/a/b/pull/7", [], { approvals }),
        0,
      ),
    ).toBe("pr https://github.com/a/b/pull/7");
  });
});
