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
import { SessionError, SessionId } from "@repo/domain/Session";
import {
  AttentionItem,
  BlockReason,
  BoardInstanceId,
  BoardNotFound,
  CreatedBoard,
  CreateTaskInput,
  MAX_TASK_BODY_CHARS,
  NotBlocked,
  runPrompt,
  StaleRevision,
  Task,
  TaskComment,
  TaskRun,
  TaskExit,
  TaskSpec,
  TaskPlan,
} from "@repo/domain/Task";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFailures } from "../errors";
import {
  MISSING_SESSION,
  NOTHING_NEEDS_A_PERSON,
  RUNS_HEADER,
  addCard,
  addFlagsToCard,
  attentionLines,
  blockCard,
  bodyLines,
  createdLines,
  runsLines,
  specLines,
  planLines,
  exitLines,
  startCard,
  type StartClient,
  updateCard,
  threadLines,
  unblockCard,
  warningLines,
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

describe("bodyLines (LOB-260)", () => {
  const card = (fields: Record<string, string>): Task =>
    Schema.decodeSync(Task)({
      id: `tsk_${"0".repeat(26)}`,
      boardId: `brd_${"0".repeat(26)}`,
      title: "release notes",
      column: "intake",
      definitionVersion: 3,
      revision: 1,
      priority: "normal",
      createdAt: "2026-10-28T00:00:00.000Z",
      updatedAt: "2026-10-28T00:00:00.000Z",
      ...fields,
    });

  /** Mutation: trim each body line, or join them — the indented markdown loses its own shape. */
  it("prints the base ref, the external ref, then the body's lines verbatim", () => {
    expect(
      bodyLines(
        card({
          body: "## Goal\n  keep 5442  \n",
          baseRef: "release",
          externalRef: "LOB-42",
        }),
      ),
    ).toEqual([
      "base      release",
      "external  LOB-42",
      "body      2 lines",
      "    ## Goal",
      "      keep 5442  ",
    ]);
  });

  /** Mutation: count `split("\n")` as is — `"a\n"` reads as two lines and prints a blank one. */
  it("counts neither a trailing newline nor the empty line after it", () => {
    expect(bodyLines(card({ body: "a\n\n" })).slice(2)).toEqual([
      "body      1 line",
      "    a",
    ]);
    expect(bodyLines(card({ body: "a\n\nb" })).slice(2)).toEqual([
      "body      3 lines",
      "    a",
      "    ",
      "    b",
    ]);
  });

  it("prints the issue's link under its ref when the card carries one (LOB-254)", () => {
    expect(
      bodyLines(
        card({
          externalRef: "linear:iss-7",
          externalUrl: "https://linear.app/acme/issue/ENG-7",
        }),
      ).slice(1, 3),
    ).toEqual([
      "external  linear:iss-7",
      "link      https://linear.app/acme/issue/ENG-7",
    ]);
  });

  it("prints a dash for each a card does not have", () => {
    expect(bodyLines(card({}))).toEqual([
      "base      -",
      "external  -",
      "body      -",
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

describe("planLines (D10)", () => {
  const plan = (risks: ReadonlyArray<string>): TaskPlan =>
    Schema.decodeSync(TaskPlan)({
      taskId: `tsk_${"0".repeat(26)}`,
      sessionId: `ses_${"1".repeat(26)}`,
      column: "planning",
      summary: "Export the card count",
      steps: ["add apps/web/src/card.ts", "verify web"],
      surfaces: ["web"],
      risks,
      revision: 5,
      createdAt: "2026-10-28T00:00:00.000Z",
    });

  /** Mutation: print the spec's labels — `goal` where the plan has a summary. */
  it("names the run and the revision, then the summary and each step, surface and risk", () => {
    expect(planLines(plan(["the count is read early"]))).toEqual([
      `plan      ses_${"1".repeat(26)} from planning (revision 5)`,
      "  summary: Export the card count",
      "  steps: 2",
      "    - add apps/web/src/card.ts",
      "    - verify web",
      "  surfaces: 1",
      "    - web",
      "  risks: 1",
      "    - the count is read early",
    ]);
  });

  it("prints no risks as none, and a card with no plan as a dash", () => {
    expect(planLines(plan([]))).toContain("  risks: none");
    expect(planLines(null)).toEqual(["plan      -"]);
  });
});

describe("exitLines (D9)", () => {
  const exit = (
    requirements: TaskExit["requirements"],
    column = "building",
  ): TaskExit =>
    Schema.decodeSync(TaskExit)({
      taskId: `tsk_${"0".repeat(26)}`,
      column,
      revision: 3,
      requirements,
    });

  it("lists each requirement as met, unmet with its reason, or not checked", () => {
    expect(
      exitLines(
        exit([
          {
            key: "run_completed",
            description: "the run finished",
            status: "met",
          },
          {
            key: "non_empty_diff",
            description: "the branch changes a file",
            status: "unmet",
            reason: "the latest run's branch changes no file",
          },
          { key: "human_move", description: "a human move", status: "unchecked" },
        ]),
      ),
    ).toEqual([
      "leaves    building when",
      "  run_completed: met (the run finished)",
      "  non_empty_diff: unmet (the branch changes a file)",
      "    the latest run's branch changes no file",
      "  human_move: not checked (a human move)",
    ]);
  });

  it("says a column with no requirements has none", () => {
    expect(exitLines(exit([], "triage"))).toEqual([
      "leaves    triage when (no requirements)",
    ]);
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

  it("keeps a multi-line card title on the head row", () => {
    const lines = attentionLines(
      item(
        { _tag: "question", since: "2026-10-27T11:00:00.000Z" },
        { title: "Pin the\nPostgres  major" },
      ),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `question  ${TASK}  verify-board/fixture  building  r3  Pin the Postgres major`,
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

  it("prints a card-less approval with dashes for the card fields and the session's title (LOB-271)", () => {
    const lines = attentionLines(
      Schema.decodeSync(AttentionItem)({
        sessionTitle: "Scratch\n  session",
        reason: {
          _tag: "approval",
          sessionId: SESSION_A,
          requestId: "ask-1",
          action: "npm publish",
          detail: "",
          requestedAt: "2026-10-27T10:00:00.000Z",
        },
      }),
    );
    expect(lines).toEqual([
      "approval  -  -  -  -  Scratch session",
      `  ${SESSION_A} asks npm publish (request ask-1, since 2026-10-27T10:00:00.000Z)`,
    ]);
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

describe("createdLines and warningLines (LOB-263)", () => {
  const made = (warning?: string) =>
    Schema.decodeSync(CreatedBoard)({
      id: `brd_${"0".repeat(26)}`,
      repo: "acme/widgets",
      definitionId: "default",
      definitionVersion: 3,
      createdAt: "2026-10-28T00:00:00.000Z",
      ...(warning === undefined ? {} : { warning }),
    });
  const board = made();

  /** Mutation: drop the warning from the output — a path-less repo's operator reads nothing. */
  it("prints the server's warning under the board, with the command that fixes it", () => {
    const warning =
      "repo acme/widgets has no local checkout registered: register one with `factory repo add acme/widgets --path <dir>`";
    const lines = createdLines(made(warning));
    expect(lines).toEqual([
      `board       ${board.id}`,
      "repo        acme/widgets",
      "definition  default v3",
      `warning     ${warning}`,
    ]);
    expect(lines.at(-1)).toContain(
      "factory repo add acme/widgets --path <dir>",
    );
  });

  it("prints exactly the three lines it always did when the repo has a checkout", () => {
    expect(createdLines(board)).toHaveLength(3);
    expect(warningLines(undefined, "warning ")).toEqual([]);
  });
});

describe("addCard (LOB-261)", () => {
  const BOARD = Schema.decodeSync(BoardInstanceId)(`brd_${"1".repeat(26)}`);
  const flags = (over: Partial<Parameters<typeof addCard>[1]> = {}) => ({
    boardId: BOARD,
    title: "Pin the Postgres major",
    repo: undefined,
    priority: undefined,
    body: undefined,
    baseRef: undefined,
    actor: "cli",
    ...over,
  });

  /**
   * A board that makes the card `createTask` makes: revision 1 in `intake`, the input recorded as
   * it was sent. A card on a board it does not know is the server's `BoardNotFound`.
   */
  const server = () => {
    const sent: CreateTaskInput[] = [];
    const client = {
      createTask: (input: CreateTaskInput) => {
        sent.push(input);
        return input.boardId === BOARD
          ? Effect.succeed(
              card({ column: "intake", revision: 1, title: input.title }),
            )
          : Effect.fail(
              new BoardNotFound({
                boardId: input.boardId,
                message: `no board ${input.boardId}`,
              }),
            );
      },
    };
    return { client, sent };
  };

  /** Mutation: print the title or the board, or drop a field — the next command has no id to use. */
  it("prints the card's id, revision and column on one line", async () => {
    const s = server();
    const lines = await Effect.runPromise(
      addCard(s.client, flags({ body: "Compose names one major." })),
    );
    expect(lines).toEqual([`task ${TASK} revision 1 column intake`]);
  });

  /**
   * The input is exactly the one the dashboard's form sends. Mutation: send `repo: undefined` for
   * no repo — `toStrictEqual` tells a missing key from an undefined one, and over JSON they differ
   * for nothing but a reader of the input — or default the priority here and not at the server.
   */
  it("sends only the fields it was given, trimming the title and keeping the body as typed", async () => {
    const s = server();
    await Effect.runPromise(
      addCard(s.client, flags({ title: "  Pin the Postgres major\n" })),
    );
    await Effect.runPromise(
      addCard(
        s.client,
        flags({
          repo: "acme/widgets" as never,
          priority: "urgent",
          body: "## Goal\n  keep 5442  \n",
          baseRef: "release",
          actor: "person:lukas",
        }),
      ),
    );
    expect(s.sent).toStrictEqual([
      { boardId: BOARD, title: "Pin the Postgres major", actor: "cli" },
      {
        boardId: BOARD,
        title: "Pin the Postgres major",
        repo: "acme/widgets",
        priority: "urgent",
        body: "## Goal\n  keep 5442  \n",
        baseRef: "release",
        actor: "person:lukas",
      },
    ]);
  });

  /** Mutation: skip the title check, or check `=== ""` without trimming — a blank card is made. */
  it("refuses an empty or blank title as invalid_input before any request", async () => {
    for (const title of ["", "   ", "\n\t"]) {
      const s = server();
      const error = await Effect.runPromise(
        Effect.flip(addCard(s.client, flags({ title }))),
      );
      expect(error).toBeInstanceOf(SessionError);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(s.sent).toEqual([]);
    }
  });

  /** Mutation: drop the length checks — an oversize body is a payload that cannot be encoded. */
  it("refuses a body or a base ref over the card's limit, naming the limit, before any request", async () => {
    const s = server();
    const body = await Effect.runPromise(
      Effect.flip(
        addCard(s.client, flags({ body: "x".repeat(MAX_TASK_BODY_CHARS + 1) })),
      ),
    );
    expect(body).toMatchObject({ code: "invalid_input" });
    expect(body.message).toContain(String(MAX_TASK_BODY_CHARS));
    const ref = await Effect.runPromise(
      Effect.flip(addCard(s.client, flags({ baseRef: "r".repeat(1_025) }))),
    );
    expect(ref).toMatchObject({ code: "invalid_input" });
    expect(s.sent).toEqual([]);
    // The limit itself is a body a card takes.
    await Effect.runPromise(
      addCard(s.client, flags({ body: "x".repeat(MAX_TASK_BODY_CHARS) })),
    );
    expect(s.sent).toHaveLength(1);
  });

  describe("what the terminal prints for a refusal", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const printed = async (title: string, boardId = BOARD) => {
      const lines: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const s = server();
      await Effect.runPromise(
        reportFailures(addCard(s.client, flags({ title, boardId }))),
      );
      return { lines, codes: exit.mock.calls.map(([code]) => code), s };
    };

    /** Mutation: swallow the refusal or print a generic one — a script cannot branch on it. */
    it("prints an unknown board as the server's board_not_found, verbatim, and exits 1", async () => {
      const other = Schema.decodeSync(BoardInstanceId)(`brd_${"2".repeat(26)}`);
      const out = await printed("a card", other);
      expect(out.lines).toEqual([
        `error: board_not_found: no board brd_${"2".repeat(26)}`,
      ]);
      expect(out.codes).toEqual([1]);
      expect(out.s.sent).toHaveLength(1);
    });

    it("prints an empty title as invalid_input, exits 1, and sends nothing", async () => {
      const out = await printed("  ");
      expect(out.lines).toEqual([
        "error: invalid_input: --title is empty: a card needs a title",
      ]);
      expect(out.codes).toEqual([1]);
      expect(out.s.sent).toEqual([]);
    });
  });
});

describe("addFlagsToCard (LOB-261)", () => {
  const BOARD_ID = `brd_${"1".repeat(26)}`;
  const raw = (over: Partial<Parameters<typeof addFlagsToCard>[0]> = {}) => ({
    board: BOARD_ID,
    title: "Pin the Postgres major",
    body: undefined,
    bodyFile: undefined,
    repo: undefined,
    priority: undefined,
    baseRef: undefined,
    actor: "cli",
    ...over,
  });
  /** A disk with the files named; any other path is unreadable, as the real reader reports it. */
  const disk = (files: Record<string, string>) => {
    const read: string[] = [];
    return {
      read,
      readFile: (path: string) => {
        read.push(path);
        return path in files
          ? Effect.succeed(files[path] as string)
          : Effect.fail(
              new SessionError({
                code: "invalid_input",
                message: `--body-file "${path}" cannot be read: no such file`,
              }),
            );
      },
    };
  };
  const refusal = async (over: Partial<Parameters<typeof addFlagsToCard>[0]>) =>
    Effect.runPromise(
      Effect.flip(addFlagsToCard(raw(over), disk({ "spec.md": "x" }).readFile)),
    );

  it("decodes the board and repo and carries every other flag through", async () => {
    const decoded = await Effect.runPromise(
      addFlagsToCard(
        raw({ repo: "acme/api", priority: "urgent", baseRef: "release" }),
        disk({}).readFile,
      ),
    );
    expect(decoded).toMatchObject({
      boardId: BOARD_ID,
      repo: "acme/api",
      priority: "urgent",
      baseRef: "release",
      body: undefined,
    });
  });

  it("takes the body from --body-file, verbatim, without touching the disk for --body", async () => {
    const d = disk({ "spec.md": "# Spec\n\nline\n" });
    const fromFile = await Effect.runPromise(
      addFlagsToCard(raw({ bodyFile: "spec.md" }), d.readFile),
    );
    expect(fromFile.body).toBe("# Spec\n\nline\n");
    const typed = await Effect.runPromise(
      addFlagsToCard(raw({ body: "typed" }), d.readFile),
    );
    expect(typed.body).toBe("typed");
    expect(d.read).toEqual(["spec.md"]);
  });

  it("refuses --body with --body-file as invalid_input, reading nothing", async () => {
    const d = disk({ "spec.md": "x" });
    const error = await Effect.runPromise(
      Effect.flip(
        addFlagsToCard(raw({ body: "typed", bodyFile: "spec.md" }), d.readFile),
      ),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("name one");
    expect(d.read).toEqual([]);
  });

  it("refuses a malformed --board or --repo as invalid_input, naming the flag", async () => {
    const board = await refusal({ board: "not-a-board" });
    expect(board.code).toBe("invalid_input");
    expect(board.message).toContain('--board "not-a-board"');
    for (const repo of ["not-a-slug", "a/b/c", ""]) {
      const error = await refusal({ repo });
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain(`--repo "${repo}"`);
    }
  });

  it("refuses an unreadable --body-file as invalid_input naming the path", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        addFlagsToCard(raw({ bodyFile: "/nonexistent" }), disk({}).readFile),
      ),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain('--body-file "/nonexistent"');
  });
});

describe("startCard (C6)", () => {
  const SESSION = Schema.decodeSync(SessionId)(SESSION_A);
  const requires = [
    { key: "non_empty_diff", description: "the run left a change" },
  ];
  const columns = [
    { name: "specifying", requires: [] },
    { name: "building", requires },
  ];

  /**
   * A server with one card, a board pinned at definition version 1, and a version 2 whose building
   * column asks for something else. Every call is recorded in order, so a case reads what the command
   * sent and when.
   */
  const server = (
    over: {
      readonly card?: Task;
      readonly board?: "unreadable";
      readonly warning?: string;
      readonly refuse?: string;
    } = {},
  ) => {
    const calls: Array<string> = [];
    const sent: Array<string> = [];
    const opened: Array<{ taskColumn: string; actor: string }> = [];
    const client = {
      getTask: () => Effect.succeed(over.card ?? card()),
      getBoard: () =>
        over.board === "unreadable"
          ? Effect.fail(new SessionError({ code: "storage", message: "down" }))
          : Effect.succeed({
              instance: { definitionId: "default" as never },
              definition: { version: 1, columns },
            }),
      getDefinition: (input: { version: number }) => {
        calls.push(`getDefinition v${input.version}`);
        return Effect.succeed({
          columns: [
            {
              name: "building",
              requires: [{ key: "tests_pass", description: "the tests pass" }],
            },
          ],
        });
      },
      createSession: (input: { taskColumn: string; actor: string }) => {
        calls.push("createSession");
        opened.push({ taskColumn: input.taskColumn, actor: input.actor });
        return Effect.succeed({ id: SESSION });
      },
      getSession: () =>
        Effect.succeed({
          workspace: {
            warning: over.warning,
          },
        }),
      sendMessage: (input: { sessionId: SessionId; content: string }) => {
        calls.push("sendMessage");
        sent.push(input.content);
        return over.refuse === undefined
          ? Effect.succeed({})
          : Effect.fail(
              new SessionError({ code: "at_capacity", message: over.refuse }),
            );
      },
    };
    return { client, calls, sent, opened };
  };
  /** `startCard`'s lines, in the order it emitted them — also when it fails after some were. */
  const startLines = <B, S>(
    client: StartClient<B, S>,
    given: Parameters<typeof startCard>[1],
  ) => {
    const lines: Array<string> = [];
    const run = startCard(client, given, (line) =>
      Effect.sync(() => {
        lines.push(line);
      }),
    );
    return { lines, run };
  };
  const input = (
    over: Partial<Parameters<typeof startCard>[1]> = {},
  ): Parameters<typeof startCard>[1] => ({
    taskId: TASK as never,
    column: undefined,
    prompt: undefined,
    idle: false,
    actor: "cli",
    ...over,
  });

  /**
   * The acceptance: no `--prompt` is the card's own prompt — what the card pane pre-fills — sent to
   * the run that was just opened. Mutation: send nothing, send the title alone, build it from a
   * different column, or send before the session exists.
   */
  it("sends the card's default prompt when none was given, after the session opens", async () => {
    const withBody = card({ body: "Compose names one major.\n" });
    const s = server({ card: withBody });
    const { lines, run } = startLines(s.client, input());
    await Effect.runPromise(run);
    expect(s.calls).toEqual(["createSession", "sendMessage"]);
    expect(s.sent).toEqual([runPrompt(withBody, columns[1])]);
    expect(s.sent[0]).toContain("Pin the Postgres major");
    expect(s.sent[0]).toContain("Compose names one major.");
    expect(s.sent[0]).toContain("non_empty_diff: the run left a change");
    expect(lines).toEqual([
      `session ${SESSION_A}`,
      `task    ${TASK} in building`,
      "sent    Pin the Postgres major (the card's default prompt)",
    ]);
  });

  it("sends a given prompt as typed, and none of the card's", async () => {
    const s = server({ card: card({ body: "B" }) });
    const { lines, run } = startLines(
      s.client,
      input({ prompt: "specify this card" }),
    );
    await Effect.runPromise(run);
    expect(s.sent).toEqual(["specify this card"]);
    expect(lines.at(-1)).toBe("sent    specify this card");
  });

  it("sends nothing with --idle, and the session still opens", async () => {
    const s = server();
    const { lines, run } = startLines(s.client, input({ idle: true }));
    await Effect.runPromise(run);
    expect(s.calls).toEqual(["createSession"]);
    expect(lines).toEqual([
      `session ${SESSION_A}`,
      `task    ${TASK} in building`,
    ]);
  });

  it("names the column the run starts in, which --column overrides", async () => {
    const s = server();
    await Effect.runPromise(
      startLines(s.client, input({ column: "specifying" })).run,
    );
    expect(s.opened).toEqual([{ taskColumn: "specifying", actor: "cli" }]);
    expect(s.sent[0]).toContain("Work this card in the specifying column.");
    expect(s.sent[0]).not.toContain("non_empty_diff");
  });

  /** Mutation: read the board's current version for every card — a card pinned earlier is told another's exit. */
  it("reads the column from the version the card pinned, not the board's", async () => {
    const s = server({ card: card({ definitionVersion: 2 }) });
    await Effect.runPromise(startLines(s.client, input()).run);
    expect(s.calls).toContain("getDefinition v2");
    expect(s.sent[0]).toContain("tests_pass: the tests pass");
    expect(s.sent[0]).not.toContain("non_empty_diff");
  });

  /** Mutation: let the definition read fail the start — a run is not refused for want of a sentence. */
  it("still starts the run, with the title and body, when the definition cannot be read", async () => {
    const s = server({ card: card({ body: "B" }), board: "unreadable" });
    await Effect.runPromise(startLines(s.client, input()).run);
    expect(s.sent).toEqual(["Pin the Postgres major\n\nB"]);
  });

  it("prints the repo warning between the task line and the sent line", async () => {
    const s = server({ warning: "no checkout" });
    const { lines, run } = startLines(s.client, input());
    await Effect.runPromise(run);
    expect(lines.slice(0, 3)).toEqual([
      `session ${SESSION_A}`,
      `task    ${TASK} in building`,
      "warning no checkout",
    ]);
  });

  /**
   * The run is open and bound to the card before the first message is sent, so a refused message must
   * not take the session id (or the repo warning) with it. Mutation: collect the lines and return them
   * at the end — the operator sees the refusal and no run to find.
   */
  it("reports the open session and warning before a refused first message fails the start", async () => {
    const s = server({ warning: "no checkout", refuse: "at capacity" });
    const { lines, run } = startLines(s.client, input());
    const exit = await Effect.runPromiseExit(run);
    expect(exit._tag).toBe("Failure");
    expect(lines).toEqual([
      `session ${SESSION_A}`,
      `task    ${TASK} in building`,
      "warning no checkout",
    ]);
    expect(lines.some((line) => line.startsWith("sent"))).toBe(false);
  });
});

describe("updateCard (C11)", () => {
  /** A card enforcing the revision, recording what the command sent. */
  const editable = (initial: Task) => {
    let current = initial;
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      getTask: (): Effect.Effect<Task, StaleRevision> =>
        Effect.succeed(current),
      updateTask: (input: {
        expectedRevision: number;
        title?: string;
        priority?: Task["priority"];
      }): Effect.Effect<Task, StaleRevision> => {
        sent.push(input);
        if (input.expectedRevision !== current.revision)
          return Effect.fail(
            new StaleRevision({
              taskId: TASK,
              expected: input.expectedRevision,
              actual: current.revision,
              message: `task ${TASK} is at revision ${current.revision}, not ${input.expectedRevision}`,
            }),
          );
        const title = input.title ?? current.title;
        const priority = input.priority ?? current.priority;
        if (title === current.title && priority === current.priority)
          return Effect.succeed(current);
        current = {
          ...current,
          title,
          priority,
          revision: current.revision + 1,
        };
        return Effect.succeed(current);
      },
    };
    return { client, sent, read: () => current };
  };

  it("sends only what was named at the card's current revision, and prints the card as it now reads", async () => {
    const b = editable(card());
    const lines = await Effect.runPromise(
      updateCard(b.client, {
        taskId: TASK as never,
        title: undefined,
        priority: "urgent",
        actor: "cli",
        expectedRevision: undefined,
      }),
    );
    expect(b.sent).toEqual([
      { taskId: TASK, expectedRevision: 3, priority: "urgent", actor: "cli" },
    ]);
    expect(lines).toEqual([
      `updated ${TASK} (revision 4)`,
      `title     ${b.read().title}`,
      "priority  urgent",
    ]);
  });

  it("says nothing changed for a value the card already has, and sends a stale named revision as named", async () => {
    const b = editable(card({ priority: "urgent" }));
    const lines = await Effect.runPromise(
      updateCard(b.client, {
        taskId: TASK as never,
        title: undefined,
        priority: "urgent",
        actor: "cli",
        expectedRevision: undefined,
      }),
    );
    expect(lines[0]).toBe(`unchanged ${TASK} (revision 3)`);
    // Naming the current revision does not make a no-op an edit.
    const named = await Effect.runPromise(
      updateCard(b.client, {
        taskId: TASK as never,
        title: undefined,
        priority: "urgent",
        actor: "cli",
        expectedRevision: 3,
      }),
    );
    expect(named[0]).toBe(`unchanged ${TASK} (revision 3)`);
    const stale = await Effect.runPromise(
      Effect.flip(
        updateCard(b.client, {
          taskId: TASK as never,
          title: "late",
          priority: undefined,
          actor: "cli",
          expectedRevision: 1,
        }),
      ),
    );
    expect(stale).toBeInstanceOf(StaleRevision);
    expect(b.sent.at(-1)).toMatchObject({ expectedRevision: 1, title: "late" });
    expect(b.read().revision).toBe(3);
  });
});
