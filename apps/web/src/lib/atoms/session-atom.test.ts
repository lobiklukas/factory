/**
 * The session view's fold (LOB-183): the live-task list arrives in the snapshot and then as
 * `tasks` events, and each one replaces the list rather than merging it.
 *
 * Replace is the contract the server keeps: it projects the whole graph, so a task that settles is
 * *absent* from the next list. A fold that merged would keep the finished task on screen forever.
 */
import type {
  SessionEvent,
  SessionSummary,
  SessionTask,
} from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { foldSessionEvent, type SessionView } from "./session-atom";

const summary: SessionSummary = {
  id: Schema.decodeSync(SessionId)("ses_00000000000000000000000001"),
  title: "tasks",
  status: "idle",
  mode: "live",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const held: SessionTask = {
  id: "7",
  kind: "factory.test.hold",
  status: "running",
  phase: "hold",
  waitingOn: [],
  conversations: [],
};

const waiting: SessionTask = {
  id: "8",
  kind: "factory.test.wait",
  status: "waiting",
  phase: "start",
  waitingOn: ["7"],
  owner: "7",
  conversations: [],
};

const view: SessionView = {
  summary,
  entries: [],
  live: { busy: false, tools: [] },
  usage: { models: [] },
  queued: [],
  tasks: [],
};

describe("foldSessionEvent and the live-task list", () => {
  it("takes the list from the snapshot, then replaces it on each tasks event", () => {
    const attached = foldSessionEvent(view, {
      _tag: "snapshot",
      session: summary,
      workspace: { path: "/tmp/session", commands: {}, commandsSource: "none" },
      entries: [],
      live: { busy: false, tools: [] },
      usage: { models: [] },
      queued: [],
      tasks: [held, waiting],
      approvals: [],
    } satisfies SessionEvent);
    expect(attached.tasks).toEqual([held, waiting]);

    const parked = foldSessionEvent(
      foldSessionEvent(attached, {
        _tag: "tasks",
        tasks: [held],
      } satisfies SessionEvent),
      { _tag: "tasks", tasks: [] } satisfies SessionEvent,
    );
    expect(parked.tasks).toEqual([]);
  });

  it("leaves the list alone for an unrelated event", () => {
    const before: SessionView = { ...view, tasks: [held] };
    expect(
      foldSessionEvent(before, { _tag: "status", status: "busy" }).tasks,
    ).toEqual([held]);
  });
});
