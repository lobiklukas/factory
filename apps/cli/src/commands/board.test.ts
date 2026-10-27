/**
 * `factory board show`'s thread lines (LOB-73): one header per comment, then its body exactly as it
 * was typed, one printed line per body line. And its spec lines (LOB-238): the run that declared the
 * card's spec, then each list, an empty one printed `none`.
 *
 * The command itself is proven by `.pi/skills/verify-board/ask.sh`, which reads the question and the
 * answer back from a real terminal run. This case is the one a pane capture would not localize: that
 * a multi-line answer keeps its own lines and inner whitespace rather than being joined or trimmed.
 */
import { Effect, Schema } from "effect";
import { SessionError } from "@repo/domain/Session";
import {
  AttentionItem,
  BlockReason,
  NotBlocked,
  StaleRevision,
  Task,
  TaskComment,
  TaskRun,
  TaskSpec,
} from "@repo/domain/Task";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFailures } from "../errors";
import {
  MISSING_SESSION,
  NOTHING_NEEDS_A_PERSON,
  RUNS_HEADER,
  attentionLines,
  blockCard,
  runsLines,
  specLines,
  threadLines,
  unblockCard,
} from "./board";

const comment = (
  kind: TaskComment["kind"],
  actor: string,
  body: string,
): TaskComment =>
  Schema.decodeSync(TaskComment)({
    taskId: `tsk_${"0".repeat(26)}`,
    kind,
    actor,
    body,
    revision: 4,
    createdAt: "2026-10-27T00:00:00.000Z",
  });

describe("threadLines", () => {
  it("names the kind, the actor and the revision, then indents the body verbatim", () => {
    expect(
      threadLines(
        comment("answer", "person:lukas", "Postgres 16.\n  Keep 5442.  "),
      ),
    ).toEqual([
      "  [answer] person:lukas (revision 4)",
      "    Postgres 16.",
      "      Keep 5442.  ",
    ]);
  });

  it("prints a one-line question as one body line", () => {
    expect(threadLines(comment("question", "ses_run", "Which repo?"))).toEqual([
      "  [question] ses_run (revision 4)",
      "    Which repo?",
    ]);
  });
});

describe("specLines (LOB-238)", () => {
  const spec = (gaps: ReadonlyArray<string>): TaskSpec =>
    Schema.decodeSync(TaskSpec)({
      taskId: `tsk_${"0".repeat(26)}`,
      sessionId: `ses_${"1".repeat(26)}`,
      column: "specifying",
      goal: "Pin the Postgres major",
      acceptance: ["compose names one major", "the docs say which"],
      gaps,
      openQuestions: gaps.length === 0 ? [] : ["Which major?"],
      revision: 2,
      createdAt: "2026-10-27T00:00:00.000Z",
    });

  it("names the run and the revision, then the goal and each list item", () => {
    expect(specLines(spec(["which major"]))).toEqual([
      `spec      ses_${"1".repeat(26)} from specifying (revision 2)`,
      "  goal: Pin the Postgres major",
      "  acceptance: 2",
      "    - compose names one major",
      "    - the docs say which",
      "  gaps: 1",
      "    - which major",
      "  open questions: 1",
      "    - Which major?",
    ]);
  });

  it("prints an empty list as none, and a card with no spec as a dash", () => {
    const lines = specLines(spec([]));
    expect(lines).toContain("  gaps: none");
    expect(lines).toContain("  open questions: none");
    expect(specLines(null)).toEqual(["spec      -"]);
  });
});

const TASK = `tsk_${"0".repeat(26)}`;
const SESSION_A = `ses_${"a".repeat(26)}`;
const SESSION_B = `ses_${"b".repeat(26)}`;

const card = (over: Partial<Task> = {}): Task =>
  Schema.decodeSync(Task)({
    id: TASK,
    boardId: `brd_${"1".repeat(26)}`,
    title: "Pin the Postgres major",
    column: "building",
    definitionVersion: 1,
    revision: 3,
    priority: "normal",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...over,
  });

/**
 * A board holding one card, enforcing what the server enforces on these two writes: the revision
 * must be the card's own (`StaleRevision`), a card is blocked once, and a block lifts only if there
 * is one. Every write is recorded, so a case reads the revision the command actually sent.
 */
const board = (initial: Task) => {
  let current = initial;
  const writes: Array<{ op: string; expectedRevision: number }> = [];
  const stale = (expected: number) =>
    new StaleRevision({
      taskId: TASK,
      expected,
      actual: current.revision,
      message: `task ${TASK} is at revision ${current.revision}, not ${expected}`,
    });
  type Refused = StaleRevision | NotBlocked;
  const client = {
    getTask: (): Effect.Effect<Task, Refused> => Effect.succeed(current),
    blockTask: (input: {
      expectedRevision: number;
      reason: BlockReason;
      note?: string;
    }): Effect.Effect<Task, Refused> => {
      writes.push({ op: "block", expectedRevision: input.expectedRevision });
      if (input.expectedRevision !== current.revision)
        return Effect.fail(stale(input.expectedRevision));
      current = {
        ...current,
        revision: current.revision + 1,
        blocked: {
          reason: input.reason,
          column: current.column,
          since: "2026-10-27T12:00:00.000Z",
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      };
      return Effect.succeed(current);
    },
    unblockTask: (input: {
      expectedRevision: number;
    }): Effect.Effect<Task, Refused> => {
      writes.push({ op: "unblock", expectedRevision: input.expectedRevision });
      if (input.expectedRevision !== current.revision)
        return Effect.fail(stale(input.expectedRevision));
      if (current.blocked === undefined)
        return Effect.fail(
          new NotBlocked({ taskId: TASK, message: `${TASK} is not blocked` }),
        );
      const { blocked: _lifted, ...rest } = current;
      current = { ...rest, revision: current.revision + 1 };
      return Effect.succeed(current);
    },
  };
  return { client, writes, read: () => current };
};

describe("blockCard / unblockCard (LOB-264)", () => {
  it("blocks at the card's current revision when none is named, and says why and from where", async () => {
    const b = board(card());
    const lines = await Effect.runPromise(
      blockCard(b.client, {
        taskId: TASK as never,
        reason: "dependency",
        note: "waiting on the schema PR",
        actor: "cli",
        expectedRevision: undefined,
      }),
    );
    expect(b.writes).toEqual([{ op: "block", expectedRevision: 3 }]);
    expect(b.read().blocked).toMatchObject({
      reason: "dependency",
      column: "building",
      note: "waiting on the schema PR",
    });
    expect(lines).toEqual([
      `blocked ${TASK} (revision 4): dependency in building`,
      "note    waiting on the schema PR",
    ]);
  });

  it("sends a named revision as named, so a stale one is the typed conflict and blocks nothing", async () => {
    const b = board(card({ revision: 5 }));
    const exit = await Effect.runPromise(
      Effect.flip(
        blockCard(b.client, {
          taskId: TASK as never,
          reason: "capability",
          note: undefined,
          actor: "cli",
          expectedRevision: 3,
        }),
      ),
    );
    expect(exit).toBeInstanceOf(StaleRevision);
    expect(b.writes).toEqual([{ op: "block", expectedRevision: 3 }]);
    expect(b.read().blocked).toBeUndefined();
    expect(b.read().revision).toBe(5);
  });

  it("unblocks a blocked card, restoring it to the column it blocked from", async () => {
    const b = board(card());
    await Effect.runPromise(
      blockCard(b.client, {
        taskId: TASK as never,
        reason: "transient",
        note: undefined,
        actor: "cli",
        expectedRevision: undefined,
      }),
    );
    const lines = await Effect.runPromise(
      unblockCard(b.client, {
        taskId: TASK as never,
        actor: "cli",
        expectedRevision: undefined,
      }),
    );
    expect(b.writes.at(-1)).toEqual({ op: "unblock", expectedRevision: 4 });
    expect(b.read().blocked).toBeUndefined();
    expect(b.read().column).toBe("building");
    expect(lines).toEqual([
      `unblocked ${TASK} (revision 5): back in building (was transient since 2026-10-27T12:00:00.000Z)`,
    ]);
  });

  it("refuses to unblock a card that is not blocked, and a stale unblock, as typed refusals", async () => {
    const b = board(card());
    const notBlocked = await Effect.runPromise(
      Effect.flip(
        unblockCard(b.client, {
          taskId: TASK as never,
          actor: "cli",
          expectedRevision: undefined,
        }),
      ),
    );
    expect(notBlocked).toBeInstanceOf(NotBlocked);
    const stale = await Effect.runPromise(
      Effect.flip(
        unblockCard(b.client, {
          taskId: TASK as never,
          actor: "cli",
          expectedRevision: 1,
        }),
      ),
    );
    expect(stale).toBeInstanceOf(StaleRevision);
  });

  describe("what the terminal prints for a refusal", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("prints a stale block as stale_revision with the server's message, and exits 1", async () => {
      const printed: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        printed.push(String(line));
      });
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const b = board(card({ revision: 5 }));
      await Effect.runPromise(
        reportFailures(
          blockCard(b.client, {
            taskId: TASK as never,
            reason: "dependency",
            note: undefined,
            actor: "cli",
            expectedRevision: 3,
          }),
        ),
      );
      expect(printed).toEqual([
        `error: stale_revision: task ${TASK} is at revision 5, not 3`,
      ]);
      expect(exit.mock.calls.map(([code]) => code)).toEqual([1]);
    });
  });
});

describe("attentionLines (LOB-264)", () => {
  const item = (
    reason: (typeof AttentionItem.Encoded)["reason"],
    over: Partial<Task> = {},
  ): AttentionItem =>
    Schema.decodeSync(AttentionItem)({
      task: card(over),
      repo: "verify-board/fixture",
      reason,
    });

  it("leads an approval with its kind and card id, then the session, action and request", () => {
    expect(
      attentionLines(
        item({
          _tag: "approval",
          sessionId: SESSION_A,
          requestId: "ask-bash-1",
          action: "npm publish",
          detail: "publish\n  the package",
          requestedAt: "2026-10-27T10:00:00.000Z",
        }),
      ),
    ).toEqual([
      `approval  ${TASK}  verify-board/fixture  building  r3  Pin the Postgres major`,
      `  ${SESSION_A} asks npm publish (request ask-bash-1, since 2026-10-27T10:00:00.000Z): publish the package`,
    ]);
  });

  it("prints a question on one line, and a block with no question as just the block", () => {
    const asked = attentionLines(
      item({
        _tag: "question",
        question: "Which major?\nPG 15 or 16?",
        since: "2026-10-27T11:00:00.000Z",
      }),
    );
    expect(asked[0]?.split("  ").slice(0, 2)).toEqual(["question", TASK]);
    expect(asked[1]).toBe(
      "  blocked needs_input since 2026-10-27T11:00:00.000Z: Which major? PG 15 or 16?",
    );
    expect(
      attentionLines(
        item({ _tag: "question", since: "2026-10-27T11:00:00.000Z" }),
      )[1],
    ).toBe("  blocked needs_input since 2026-10-27T11:00:00.000Z");
  });

  it("names a gate, the idle run and the column the person's move goes to", () => {
    const lines = attentionLines(
      item(
        {
          _tag: "gate",
          gate: "plan approval",
          to: "building",
          sessionId: SESSION_B,
        },
        { column: "planning" },
      ),
    );
    expect(lines[0]).toBe(
      `gate  ${TASK}  verify-board/fixture  planning  r3  Pin the Postgres major`,
    );
    expect(lines[1]).toBe(
      `  plan approval: ${SESSION_B} is idle; planning → building is a person's`,
    );
  });

  it("puts the card id second in every row, whatever the reason", () => {
    const rows = [
      item({
        _tag: "approval",
        sessionId: SESSION_A,
        requestId: "r",
        action: "a",
        detail: "",
        requestedAt: "2026-10-27T10:00:00.000Z",
      }),
      item({ _tag: "question", since: "2026-10-27T11:00:00.000Z" }),
      item({ _tag: "gate", gate: "g", to: "x", sessionId: SESSION_A }),
    ].map((i) => attentionLines(i)[0]?.split("  ")[1]);
    expect(rows).toEqual([TASK, TASK, TASK]);
  });

  it("has a sentence for nothing, not a blank", () => {
    expect(NOTHING_NEEDS_A_PERSON).toBe("nothing needs a person");
  });
});

describe("runsLines (LOB-264)", () => {
  const run = (sessionId: string, column: string, startedAt: string) =>
    Schema.decodeSync(TaskRun)({
      id: `run_${sessionId}`,
      taskId: TASK,
      sessionId,
      column,
      startedAt,
    });
  const summary = (status: "idle" | "busy", prUrl?: string) => ({
    session: { status, ...(prUrl === undefined ? {} : { prUrl }) },
  });

  it("prints each run's session id, column, status and PR URL, in the server's order", async () => {
    const lines = await Effect.runPromise(
      runsLines(
        {
          listTaskRuns: () =>
            Effect.succeed([
              run(SESSION_B, "review", "2026-10-27T13:00:00.000Z"),
              run(SESSION_A, "building", "2026-10-27T12:00:00.000Z"),
            ]),
          getSession: ({ sessionId }) =>
            Effect.succeed(
              sessionId === SESSION_B
                ? summary("busy")
                : summary("idle", "https://github.com/o/r/pull/7"),
            ),
        },
        TASK as never,
      ),
    );
    expect(lines).toEqual([
      RUNS_HEADER,
      `${SESSION_B}  review  busy  -  2026-10-27T13:00:00.000Z`,
      `${SESSION_A}  building  idle  https://github.com/o/r/pull/7  2026-10-27T12:00:00.000Z`,
    ]);
  });

  it("says no runs for a card with none, and does not read a session", async () => {
    const lines = await Effect.runPromise(
      runsLines(
        {
          listTaskRuns: () => Effect.succeed([]),
          getSession: () => Effect.die("no run, no session read"),
        },
        TASK as never,
      ),
    );
    expect(lines).toEqual(["no runs"]);
  });

  it("reads only a session the server says is gone as missing; any other failure fails the command", async () => {
    const one = {
      listTaskRuns: () =>
        Effect.succeed([
          run(SESSION_A, "building", "2026-10-27T12:00:00.000Z"),
        ]),
    };
    const gone = await Effect.runPromise(
      runsLines(
        {
          ...one,
          getSession: () =>
            Effect.fail(
              new SessionError({ code: "not_found", message: "no session" }),
            ),
        },
        TASK as never,
      ),
    );
    expect(gone[1]).toBe(
      `${SESSION_A}  building  ${MISSING_SESSION}  -  2026-10-27T12:00:00.000Z`,
    );
    const failed = await Effect.runPromise(
      Effect.flip(
        runsLines(
          {
            ...one,
            getSession: () =>
              Effect.fail(
                new SessionError({ code: "storage", message: "db down" }),
              ),
          },
          TASK as never,
        ),
      ),
    );
    expect(failed).toBeInstanceOf(SessionError);
  });
});
