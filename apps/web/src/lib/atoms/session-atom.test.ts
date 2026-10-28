/**
 * The session view's fold (LOB-183): the live-task list arrives in the snapshot and then as
 * `tasks` events, and each one replaces the list rather than merging it.
 *
 * Replace is the contract the server keeps: it projects the whole graph, so a task that settles is
 * *absent* from the next list. A fold that merged would keep the finished task on screen forever.
 */
import type {
  SessionBudget,
  SessionEvent,
  SessionSummary,
  SessionTask,
} from "@repo/domain/Session";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  foldSessionEvent,
  startSession,
  type SessionView,
} from "./session-atom";

const slug = Schema.decodeSync(RepoSlug);

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
  usage: { models: [], tools: [] },
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
      usage: { models: [], tools: [] },
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

describe("foldSessionEvent and the no-checkout warning (LOB-263)", () => {
  const snapshotOf = (warning?: string): SessionEvent => ({
    _tag: "snapshot",
    session: summary,
    workspace: {
      path: "/tmp/session",
      commands: {},
      commandsSource: "none",
      ...(warning === undefined ? {} : { warning }),
    },
    entries: [],
    live: { busy: false, tools: [] },
    usage: { models: [], tools: [] },
    queued: [],
    tasks: [],
    approvals: [],
  });

  /** Mutation: drop the field from the fold — the pane has nothing to show. */
  it("keeps the workspace's warning from the snapshot, and none when the snapshot has none", () => {
    expect(
      foldSessionEvent(view, snapshotOf("repo a/b has no local checkout"))
        .workspaceWarning,
    ).toBe("repo a/b has no local checkout");
    // A re-attach after the repo was registered replaces it rather than keeping the old one.
    const warned: SessionView = { ...view, workspaceWarning: "stale" };
    expect("workspaceWarning" in foldSessionEvent(warned, snapshotOf())).toBe(
      false,
    );
  });
});

describe("foldSessionEvent and a stop the snapshot shows as raised (C23)", () => {
  const stopEntry = {
    id: "e1",
    kind: "budget" as const,
    text: "x",
    toolCalls: [],
  };
  const snapshotWith = (
    budget: SessionBudget | undefined,
    entries = [stopEntry],
  ): SessionEvent => ({
    _tag: "snapshot",
    session: summary,
    workspace: { path: "/tmp/session", commands: {}, commandsSource: "none" },
    entries,
    live: { busy: false, tools: [] },
    usage: { models: [], tools: [] },
    queued: [],
    tasks: [],
    approvals: [],
    budget,
  });

  /** Mutation: always offering on a newest stop — a reload offers Raise cap on a cap raised elsewhere. */
  it("marks the newest stop settled when the budget reports no stop", () => {
    expect(
      foldSessionEvent(view, snapshotWith({ cap: 2, spent: 1 })).settledStop,
    ).toBe("e1");
  });

  it("marks nothing settled while the budget still reports the stop, or without a budget", () => {
    const stopped = {
      cap: 1,
      spent: 1,
      stopped: { at: "2026-10-28T00:00:00.000Z", spent: 1, cap: 1 },
    };
    expect("settledStop" in foldSessionEvent(view, snapshotWith(stopped))).toBe(
      false,
    );
    expect(
      "settledStop" in foldSessionEvent(view, snapshotWith(undefined)),
    ).toBe(false);
  });
});

/**
 * What the New session form's submit does (E6): `createSession` with the form's payload exactly,
 * then the prompt verbatim, and a refused first message that is not mistaken for a refused create.
 */
describe("startSession", () => {
  type Refusal = { readonly _tag: "SessionError"; readonly message: string };
  const refusal = (message: string): Refusal => ({
    _tag: "SessionError",
    message,
  });
  const recorder = (outcome: {
    readonly create?: Refusal;
    readonly send?: Refusal;
  }) => {
    const calls: Array<{ readonly tag: string; readonly input: unknown }> = [];
    return {
      calls,
      client: {
        createSession: (input: unknown) => {
          calls.push({ tag: "createSession", input });
          return outcome.create === undefined
            ? Effect.succeed(summary)
            : Effect.fail(outcome.create);
        },
        sendMessage: (input: unknown) => {
          calls.push({ tag: "sendMessage", input });
          return outcome.send === undefined
            ? Effect.succeed({})
            : Effect.fail(outcome.send);
        },
      },
    };
  };
  const input = {
    create: { actor: "dashboard", repo: slug("acme/widgets"), baseRef: "main" },
    content: "  Fix it\n  verbatim\n",
  };

  it("creates with the form's payload, then sends the prompt verbatim to that session", async () => {
    const { calls, client } = recorder({});
    const result = await Effect.runPromise(startSession(client, input));
    expect(result).toEqual({ session: summary });
    expect(calls).toEqual([
      { tag: "createSession", input: input.create },
      {
        tag: "sendMessage",
        input: { sessionId: summary.id, content: input.content },
      },
    ]);
  });

  it("fails with the server's refusal and sends nothing when the create is refused", async () => {
    const { calls, client } = recorder({
      create: refusal("repo acme/widgets: failed to create worktree at main"),
    });
    const exit = await Effect.runPromiseExit(startSession(client, input));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Exit.isFailure(exit) &&
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    ).toEqual(refusal("repo acme/widgets: failed to create worktree at main"));
    expect(calls.map((call) => call.tag)).toEqual(["createSession"]);
  });

  it("answers the session it made, and the refusal, when only the first message is refused", async () => {
    const { client } = recorder({ send: refusal("session is at capacity") });
    const result = await Effect.runPromise(startSession(client, input));
    expect(result).toEqual({
      session: summary,
      sendFailure: "session is at capacity",
    });
  });
});
