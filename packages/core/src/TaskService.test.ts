/**
 * The task service against the real `tasks` / `task_events` tables (docs/board.md B3–B5, B7, B9).
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Each case makes its own board
 * instance over the seeded `default` definition, so cases never share a card.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  declaredTransitions,
  humanGate,
  LIST_BOARDS_LIMIT,
  type AttentionItem,
} from "@repo/domain/Task";
import {
  TaskService,
  TaskServiceLive,
  type TaskError,
  type TaskServiceShape,
} from "./TaskService";

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive)),
);

afterAll(() => runtime.dispose());

const withService = <A, E>(
  f: (service: TaskServiceShape) => Effect.Effect<A, E>,
): Promise<A> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* TaskService;
      return yield* f(service);
    }),
  );

/** The refusal an operation failed with, or a test failure if it succeeded. */
const refusal = (
  f: (service: TaskServiceShape) => Effect.Effect<unknown, TaskError>,
): Promise<TaskError> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* TaskService;
      return yield* f(service).pipe(
        Effect.match({
          onFailure: (error): TaskError => error,
          onSuccess: (): TaskError => {
            throw new Error("expected a refusal, but the operation succeeded");
          },
        }),
      );
    }),
  );

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A board instance bound to a fresh repository, over the seeded default definition. */
const newBoard = (): Promise<string> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const id = `brd_${hex(13)}`;
      yield* sql`
        INSERT INTO board_instances (id, repo, definition_id, definition_version)
        VALUES (${id}, ${`factory-test/${hex(6)}`}, 'default', 1)
      `;
      return id;
    }),
  );

/** How many `task_events` rows a card has. A refused mutation must leave this unchanged. */
const eventCount = (taskId: string): Promise<number> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ n: number }>`
        SELECT count(*)::int AS n FROM task_events WHERE task_id = ${taskId}
      `;
      return rows[0]?.n ?? -1;
    }),
  );

/** A run's actor: a session id, which is what a run is (B1). */
const RUN = "ses_0123456789abcdefghjkmnpqrs";
const LUKAS = "person:lukas";

describe("TaskService", () => {
  it("creates a card in intake at revision 1 with one created event", async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "first card", actor: LUKAS }),
    );
    expect(task.column).toBe("intake");
    expect(task.revision).toBe(1);
    expect(task.definitionVersion).toBe(1);
    expect(task.priority).toBe("normal");
    expect(await eventCount(task.id)).toBe(1);
  });

  it("refuses a move at a stale revision, names the current revision, and writes no event", async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "stale", actor: LUKAS }),
    );
    const moved = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: 1,
        to: "specifying",
        actor: LUKAS,
      }),
    );
    expect(moved.revision).toBe(2);

    const err = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: 1,
        to: "specifying",
        actor: LUKAS,
      }),
    );
    expect(err._tag).toBe("StaleRevision");
    if (err._tag !== "StaleRevision") throw new Error("unreachable");
    expect(err.expected).toBe(1);
    expect(err.actual).toBe(2);
    // One created and one moved; the refused move added nothing.
    expect(await eventCount(task.id)).toBe(2);
  });

  it("lets exactly one of two concurrent moves at the same revision win", async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "race", actor: LUKAS }),
    );
    const outcomes = await Promise.all(
      ["racer-1", "racer-2"].map((who) =>
        withService((s) =>
          s
            .move({
              taskId: task.id,
              expectedRevision: 1,
              to: "specifying",
              actor: `person:${who}`,
            })
            .pipe(
              Effect.match({
                onFailure: (e) => e._tag,
                onSuccess: () => "won" as const,
              }),
            ),
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "StaleRevision")).toHaveLength(1);

    const current = await withService((s) => s.get(task.id));
    expect(current.column).toBe("specifying");
    expect(current.revision).toBe(2);
    expect(await eventCount(task.id)).toBe(2);
  });

  it("refuses an undeclared transition and names both columns", async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "skip", actor: LUKAS }),
    );
    const err = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: 1,
        to: "building",
        actor: LUKAS,
      }),
    );
    expect(err._tag).toBe("UndeclaredTransition");
    expect(err.message).toContain('"intake"');
    expect(err.message).toContain('"building"');
    expect(await eventCount(task.id)).toBe(1);
  });

  it("keeps the plan approval and merge gates for a person, and refuses a run", async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "gated", actor: LUKAS }),
    );
    // intake → specifying → planning, all by a person.
    const planning = await withService((s) =>
      Effect.gen(function* () {
        const a = yield* s.move({
          taskId: task.id,
          expectedRevision: 1,
          to: "specifying",
          actor: LUKAS,
        });
        return yield* s.move({
          taskId: task.id,
          expectedRevision: a.revision,
          to: "planning",
          actor: LUKAS,
        });
      }),
    );
    expect(planning.column).toBe("planning");

    const gate = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: planning.revision,
        to: "building",
        actor: RUN,
      }),
    );
    expect(gate._tag).toBe("HumanGateRequired");
    expect(gate.message).toContain("plan approval");
    const stillPlanning = await withService((s) => s.get(task.id));
    expect(stillPlanning.column).toBe("planning");
    expect(stillPlanning.revision).toBe(planning.revision);
    expect(await eventCount(task.id)).toBe(3);

    const building = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: planning.revision,
        to: "building",
        actor: LUKAS,
      }),
    );
    const review = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: building.revision,
        to: "review",
        actor: RUN,
      }),
    );
    const mergeGate = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: review.revision,
        to: "done",
        actor: RUN,
      }),
    );
    expect(mergeGate._tag).toBe("HumanGateRequired");
    expect(mergeGate.message).toContain("merge");
    const done = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: review.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(done.column).toBe("done");
    // created + 5 accepted moves; both refused gates added nothing.
    expect(await eventCount(task.id)).toBe(6);
  });

  it("accepts every move the shared table declares out of a column, and refuses every other", async () => {
    // The card pane offers `declaredTransitions(column)` (LOB-76); this is the server half of "a
    // move the API would refuse is not offered": one fresh card per target, so each answer is the
    // service's own for that single move out of `intake`.
    const boardId = await newBoard();
    const { definition } = await withService((s) => s.getBoard(boardId));
    const offered = declaredTransitions("intake");
    for (const column of definition.columns) {
      const task = await withService((s) =>
        s.create({ boardId, title: `to ${column.name}`, actor: LUKAS }),
      );
      const outcome = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* TaskService;
          return yield* service
            .move({
              taskId: task.id,
              expectedRevision: 1,
              to: column.name,
              actor: LUKAS,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error._tag,
                onSuccess: (moved) => moved.column,
              }),
            );
        }),
      );
      expect([column.name, outcome]).toEqual([
        column.name,
        offered.includes(column.name) ? column.name : "UndeclaredTransition",
      ]);
    }
    // And every target the table names is a column the seeded definition declares.
    const names = definition.columns.map((column) => column.name);
    for (const column of names) {
      for (const to of declaredTransitions(column)) {
        expect(names).toContain(to);
      }
      expect(humanGate(column, column)).toBeUndefined();
    }
  });

  it("lists a card's runs newest first, empty for a card with none, and refuses an unknown card", async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "runs", actor: LUKAS }),
    );
    expect(await withService((s) => s.listRuns(task.id))).toEqual([]);

    const first = `ses_${"0".repeat(10)}${hex(8)}`;
    const second = `ses_${"1".repeat(10)}${hex(8)}`;
    // Insert and read in one transaction. These sessions have no commits, and a concurrent
    // `rebuildIndexes` (SessionService.test.ts shares this database) deletes every `task_runs` row
    // whose session has none — but it cannot see rows this transaction has not committed yet.
    const runs = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const service = yield* TaskService;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO task_runs (id, task_id, session_id, "column", started_at)
              VALUES (${first}, ${task.id}, ${first}, 'specifying', now() - interval '1 minute'),
                     (${second}, ${task.id}, ${second}, 'planning', now())
            `;
            return yield* service.listRuns(task.id);
          }),
        );
      }),
    );
    expect(runs.map((run) => [run.sessionId, run.column])).toEqual([
      [second, "planning"],
      [first, "specifying"],
    ]);
    expect(runs.every((run) => run.taskId === task.id)).toBe(true);
    expect(runs[0]?.finishedAt).toBeUndefined();

    const err = await refusal((s) => s.listRuns(`tsk_${"0".repeat(26)}`));
    expect(err._tag).toBe("TaskNotFound");
  });

  it("round-trips every typed block reason through get, then unblocks", async () => {
    const boardId = await newBoard();
    const reasons = [
      "dependency",
      "needs_input",
      "capability",
      "transient",
    ] as const;
    for (const reason of reasons) {
      const task = await withService((s) =>
        s.create({ boardId, title: `block ${reason}`, actor: LUKAS }),
      );
      const blocked = await withService((s) =>
        s.block({
          taskId: task.id,
          expectedRevision: 1,
          reason,
          note: "waiting on the answer",
          actor: RUN,
        }),
      );
      const read = await withService((s) => s.get(task.id));
      expect(read.blocked).toEqual({
        reason,
        column: "intake",
        note: "waiting on the answer",
        since: blocked.blocked?.since,
      });
      expect(read.revision).toBe(2);

      const cleared = await withService((s) =>
        s.unblock({
          taskId: task.id,
          expectedRevision: read.revision,
          actor: LUKAS,
        }),
      );
      expect(cleared.blocked).toBeUndefined();
      expect(await eventCount(task.id)).toBe(3);
    }
  });

  it("reads a board as its instance plus the definition version it binds", async () => {
    const boardId = await newBoard();
    const board = await withService((s) => s.getBoard(boardId));

    expect(board.instance.id).toBe(boardId);
    expect(board.instance.definitionId).toBe("default");
    expect(board.instance.definitionVersion).toBe(1);
    // The seeded pipeline in definition order: lanes are printed from this array, so the order is
    // part of the contract rather than an accident of the JSON.
    expect(board.definition.columns.map((column) => column.name)).toEqual([
      "intake",
      "specifying",
      "planning",
      "building",
      "review",
      "done",
      "canceled",
    ]);
    expect(board.definition.columns[0]?.kind).toBe("resting");
  });

  it("lists boards newest first, capped at LIST_BOARDS_LIMIT", async () => {
    // One more than the cap, dated a day ahead so they are the newest rows in a database other
    // suites write into concurrently: the first page must be exactly these, newest first. Deleted
    // afterwards, so a dashboard on the same database does not list them for a day — and rows an
    // earlier run left behind (killed between the insert and the `finally`) are deleted first, by
    // the repo pattern every run of this case shares, so they cannot outrank real boards for long.
    const tag = hex(4);
    const ids = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`DELETE FROM board_instances WHERE repo LIKE 'factory-test/list-%' AND created_at > now()`;
        const rows = yield* sql<{ id: string }>`
          INSERT INTO board_instances (id, repo, definition_id, definition_version, created_at)
          SELECT 'brd_' || ${tag} || lpad(n::text, 18, '0'),
                 'factory-test/list-' || ${tag} || '-' || n,
                 'default', 1,
                 now() + interval '1 day' + n * interval '1 second'
          FROM generate_series(1, ${LIST_BOARDS_LIMIT + 1}) AS n
          RETURNING id
        `;
        return rows.map((row) => row.id);
      }),
    );
    try {
      expect(ids).toHaveLength(LIST_BOARDS_LIMIT + 1);
      const boards = await withService((s) => s.listBoards);
      expect(boards).toHaveLength(LIST_BOARDS_LIMIT);
      // Newest first: the last inserted (n = 101) leads, and the oldest of the batch (n = 1) is the
      // one the cap drops.
      expect(boards.map((board) => board.id)).toEqual(
        // The id carries `n` zero-padded, so a lexicographic sort is the insertion order.
        [...ids].sort().reverse().slice(0, LIST_BOARDS_LIMIT),
      );
      expect(boards[0]?.definitionId).toBe("default");
      expect(boards[0]?.definitionVersion).toBe(1);
      expect(boards[0]?.repo).toBe(
        `factory-test/list-${tag}-${LIST_BOARDS_LIMIT + 1}`,
      );
    } finally {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`DELETE FROM board_instances WHERE id LIKE ${`brd_${tag}%`}`;
        }),
      );
    }
  });

  it("refuses to read a board that does not exist, naming the id", async () => {
    const err = await refusal((s) => s.getBoard(`brd_${hex(13)}`));
    expect(err._tag).toBe("BoardNotFound");
  });

  it("lists urgent cards first, then FIFO, and filters by column", async () => {
    const boardId = await newBoard();
    const a = await withService((s) =>
      s.create({ boardId, title: "a", actor: LUKAS }),
    );
    const b = await withService((s) =>
      s.create({ boardId, title: "b", priority: "urgent", actor: LUKAS }),
    );
    const c = await withService((s) =>
      s.create({ boardId, title: "c", actor: LUKAS }),
    );

    const all = await withService((s) => s.list({ boardId }));
    expect(all.map((t) => t.id)).toEqual([b.id, a.id, c.id]);

    await withService((s) =>
      s.move({
        taskId: c.id,
        expectedRevision: 1,
        to: "specifying",
        actor: LUKAS,
      }),
    );
    const intake = await withService((s) =>
      s.list({ boardId, column: "intake" }),
    );
    expect(intake.map((t) => t.id)).toEqual([b.id, a.id]);
  });
});

/**
 * The thread on a card (B7, LOB-73): a run's question, a person's answer, and every refusal on the
 * way — each refusal checked against the event count, because a refused ask that left a comment
 * behind would be a question nobody can tell was never asked.
 */
describe("TaskService — the ask and the thread", () => {
  /** The `kind` column of every event a card has, in write order. */
  const eventKinds = (taskId: string): Promise<ReadonlyArray<string>> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ kind: string }>`
          SELECT kind FROM task_events WHERE task_id = ${taskId} ORDER BY id
        `;
        return rows.map((row) => row.kind);
      }),
    );

  /** A card moved into `specifying`, at revision 2. */
  const inSpecifying = async () => {
    const boardId = await newBoard();
    const task = await withService((s) =>
      s.create({ boardId, title: "thin", actor: LUKAS }),
    );
    return withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: 1,
        to: "specifying",
        actor: LUKAS,
      }),
    );
  };

  it("asks: a question comment and a needs_input block from the card's column, in one mutation", async () => {
    const task = await inSpecifying();
    const asked = await withService((s) =>
      s.ask({ taskId: task.id, question: "Which repo?", actor: RUN }),
    );
    expect(asked.blocked?.reason).toBe("needs_input");
    expect(asked.blocked?.column).toBe("specifying");
    expect(asked.blocked?.note).toBe("Which repo?");
    // Two events, one revision each: the comment at 2, the block at 3, the card now at 4.
    expect(asked.revision).toBe(4);
    expect(await eventKinds(task.id)).toEqual([
      "created",
      "moved",
      "commented",
      "blocked",
    ]);
    const thread = await withService((s) => s.comments(task.id));
    expect(thread).toEqual([
      {
        taskId: task.id,
        kind: "question",
        actor: RUN,
        body: "Which repo?",
        revision: 2,
        createdAt: thread[0]?.createdAt,
      },
    ]);
  });

  it("records an ask once per ask id, so a replayed tool call asks nothing twice", async () => {
    const task = await inSpecifying();
    const ask = { taskId: task.id, question: "Which repo?", actor: RUN };
    const first = await withService((s) =>
      s.ask({ ...ask, askId: `${RUN}:call-1` }),
    );
    const replayed = await withService((s) =>
      s.ask({ ...ask, askId: `${RUN}:call-1` }),
    );
    expect(replayed.revision).toBe(first.revision);
    expect(await eventCount(task.id)).toBe(4);
    // A different call is a second question on the same wait: it joins the thread, the block stays.
    const again = await withService((s) =>
      s.ask({ ...ask, question: "And which branch?", askId: `${RUN}:call-2` }),
    );
    expect(again.blocked?.reason).toBe("needs_input");
    expect(again.blocked?.since).toBe(first.blocked?.since);
    expect(again.revision).toBe(first.revision + 1);
    const thread = await withService((s) => s.comments(task.id));
    expect(thread.map((comment) => comment.body)).toEqual([
      "Which repo?",
      "And which branch?",
    ]);
  });

  it("refuses an ask on a card blocked for another reason, and an empty question, writing nothing", async () => {
    const task = await inSpecifying();
    await withService((s) =>
      s.block({
        taskId: task.id,
        expectedRevision: task.revision,
        reason: "dependency",
        actor: LUKAS,
      }),
    );
    const blocked = await refusal((s) =>
      s.ask({ taskId: task.id, question: "Which repo?", actor: RUN }),
    );
    expect(blocked._tag).toBe("AlreadyBlocked");
    expect(blocked.message).toContain("dependency");

    const other = await inSpecifying();
    const empty = await refusal((s) =>
      s.ask({ taskId: other.id, question: "  \n ", actor: RUN }),
    );
    expect(empty._tag).toBe("EmptyComment");
    const missing = await refusal((s) =>
      s.ask({ taskId: `tsk_${hex(13)}`, question: "?", actor: RUN }),
    );
    expect(missing._tag).toBe("TaskNotFound");

    expect(await eventCount(task.id)).toBe(3);
    expect(await eventCount(other.id)).toBe(2);
  });

  it("takes a person's comment on a needs_input card as the answer, and lifts the block", async () => {
    const task = await inSpecifying();
    const asked = await withService((s) =>
      s.ask({ taskId: task.id, question: "Which repo?", actor: RUN }),
    );
    const answered = await withService((s) =>
      s.comment({
        taskId: task.id,
        expectedRevision: asked.revision,
        body: "lobiklukas/factory",
        actor: LUKAS,
      }),
    );
    expect(answered.blocked).toBeUndefined();
    expect(answered.column).toBe("specifying");
    expect(answered.revision).toBe(asked.revision + 2);
    expect((await eventKinds(task.id)).slice(-2)).toEqual([
      "commented",
      "unblocked",
    ]);
    const thread = await withService((s) => s.comments(task.id));
    expect(thread.map((comment) => [comment.kind, comment.actor])).toEqual([
      ["question", RUN],
      ["answer", LUKAS],
    ]);
    expect(thread[1]?.revision).toBe(asked.revision);
  });

  it("keeps a run's own comment and a comment on an unblocked card as notes", async () => {
    const task = await inSpecifying();
    const asked = await withService((s) =>
      s.ask({ taskId: task.id, question: "Which repo?", actor: RUN }),
    );
    // Only a person answers: the run adding to its own question leaves the card parked.
    const byRun = await withService((s) =>
      s.comment({
        taskId: task.id,
        expectedRevision: asked.revision,
        body: "or a fork of it",
        actor: RUN,
      }),
    );
    expect(byRun.blocked?.reason).toBe("needs_input");
    expect(byRun.revision).toBe(asked.revision + 1);

    const plain = await inSpecifying();
    const noted = await withService((s) =>
      s.comment({
        taskId: plain.id,
        expectedRevision: plain.revision,
        body: "context for later",
        actor: LUKAS,
      }),
    );
    expect(noted.blocked).toBeUndefined();
    expect(noted.revision).toBe(plain.revision + 1);
    const kinds = async (id: string) =>
      (await withService((s) => s.comments(id))).map((c) => c.kind);
    expect(await kinds(task.id)).toEqual(["question", "note"]);
    expect(await kinds(plain.id)).toEqual(["note"]);
  });

  it("reads the thread in event-id order, not in the text order of the ids", async () => {
    const task = await inSpecifying();
    // Two comments whose ids sort one way as numbers and the other as text: -…9 is written first
    // (it is the smaller number) but "-…9" sorts after "-…8". Negative ids are below anything the
    // identity hands out, and the run's random stem keeps them unique across runs of this suite.
    const stem = Number.parseInt(hex(5), 16) + 1;
    const ids = [-(stem * 10 + 9), -(stem * 10 + 8)];
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const [index, id] of ids.entries()) {
          const payload = JSON.stringify({
            _tag: "commented",
            taskId: task.id,
            actor: LUKAS,
            body: index === 0 ? "first" : "second",
            revision: task.revision,
            kind: "note",
          });
          yield* sql`
            INSERT INTO task_events (id, task_id, kind, actor, revision, payload)
            OVERRIDING SYSTEM VALUE
            VALUES (${id}, ${task.id}, 'commented', ${LUKAS}, ${task.revision}, ${payload}::jsonb)
          `;
        }
      }),
    );
    const thread = await withService((s) => s.comments(task.id));
    expect(thread.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("refuses a stale comment and an empty one, writing nothing, and a thread of no card", async () => {
    const task = await inSpecifying();
    const stale = await refusal((s) =>
      s.comment({
        taskId: task.id,
        expectedRevision: task.revision - 1,
        body: "late",
        actor: LUKAS,
      }),
    );
    expect(stale._tag).toBe("StaleRevision");
    const empty = await refusal((s) =>
      s.comment({
        taskId: task.id,
        expectedRevision: task.revision,
        body: "",
        actor: LUKAS,
      }),
    );
    expect(empty._tag).toBe("EmptyComment");
    expect(await eventCount(task.id)).toBe(2);
    const none = await refusal((s) => s.comments(`tsk_${hex(13)}`));
    expect(none._tag).toBe("TaskNotFound");
  });
});

describe("TaskService — what needs a person (LOB-77)", () => {
  /** A card walked by a person from `intake` along `path`, one declared move at a time. */
  const cardIn = async (
    boardId: string,
    title: string,
    path: ReadonlyArray<string>,
  ) => {
    let task = await withService((s) =>
      s.create({ boardId, title, actor: LUKAS }),
    );
    for (const to of path) {
      const at = task;
      task = await withService((s) =>
        s.move({
          taskId: at.id,
          expectedRevision: at.revision,
          to,
          actor: LUKAS,
        }),
      );
    }
    return task;
  };

  const newSession = () => `ses_${hex(13)}`;

  /** The failure that rolls a seeded transaction back, carrying the reads made inside it. */
  class Rollback {
    constructor(
      readonly answers: ReadonlyArray<ReadonlyArray<AttentionItem>>,
    ) {}
  }

  type Seed = {
    readonly runs: ReadonlyArray<{
      readonly taskId: string;
      readonly column: string;
      readonly status: "idle" | "busy";
      /** Seconds before now the run started, so "newest in the column" is decided by the seed. */
      readonly ago: number;
      readonly sessionId?: string;
    }>;
    readonly approvals: ReadonlyArray<{
      readonly sessionId: string;
      readonly requestId: string;
      readonly action: string;
      readonly ago: number;
      readonly decided?: boolean;
    }>;
  };

  /**
   * Seeds sessions, their activity, the card runs and the approvals, then reads `attention` in the
   * same transaction. These sessions have no commits, and a concurrent `rebuildIndexes`
   * (SessionService.test.ts shares this database) deletes index rows of a session with none — but
   * it cannot see rows this transaction has not committed. The transaction is rolled back, so the
   * rows never outlive the case.
   */
  const attentionWith = (
    seed: Seed,
    boards: ReadonlyArray<string | undefined>,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const service = yield* TaskService;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              for (const run of seed.runs) {
                const id = run.sessionId ?? newSession();
                yield* sql`INSERT INTO sessions (id) VALUES (${id})`;
                yield* sql`
                  INSERT INTO session_activity (session_id, status) VALUES (${id}, ${run.status})
                `;
                yield* sql`
                  INSERT INTO task_runs (id, task_id, session_id, "column", started_at)
                  VALUES (${id}, ${run.taskId}, ${id}, ${run.column},
                          now() - make_interval(secs => ${run.ago}))
                `;
              }
              for (const approval of seed.approvals) {
                yield* approval.decided === true
                  ? sql`
                      INSERT INTO session_approvals
                        (session_id, request_id, action, requested_at, decision, actor, decided_at)
                      VALUES (${approval.sessionId}, ${approval.requestId}, ${approval.action},
                              now() - make_interval(secs => ${approval.ago}),
                              'approved', ${LUKAS}, now())
                    `
                  : sql`
                      INSERT INTO session_approvals (session_id, request_id, action, requested_at)
                      VALUES (${approval.sessionId}, ${approval.requestId}, ${approval.action},
                              now() - make_interval(secs => ${approval.ago}))
                    `;
              }
              const answers: Array<ReadonlyArray<AttentionItem>> = [];
              for (const board of boards) {
                answers.push(yield* service.attention(board));
              }
              // Roll the seed back: the case's rows exist only for the reads above.
              return yield* Effect.fail(new Rollback(answers));
            }),
          )
          .pipe(
            Effect.catchIf(
              (failure): failure is Rollback => failure instanceof Rollback,
              (rollback) => Effect.succeed(rollback.answers),
            ),
          );
      }),
    );

  /** `[reason, card title]` per row, in the order the service answered. */
  const rows = (
    items: ReadonlyArray<{
      readonly task: { readonly title: string };
      readonly reason: { readonly _tag: string };
    }>,
  ) => items.map((item) => [item.reason._tag, item.task.title]);

  it("lists approvals, then questions, then done runs at a human gate — and nothing else", async () => {
    const boardId = await newBoard();
    const resting = await cardIn(boardId, "resting in intake", []);
    const gated = await cardIn(boardId, "plan waits", [
      "specifying",
      "planning",
    ]);
    const merge = await cardIn(boardId, "merge waits", [
      "specifying",
      "planning",
      "building",
      "review",
    ]);
    const busy = await cardIn(boardId, "run still busy", [
      "specifying",
      "planning",
    ]);
    const noRun = await cardIn(boardId, "no run in planning yet", [
      "specifying",
      "planning",
    ]);
    const waiting = await cardIn(boardId, "blocked on a dependency", [
      "specifying",
      "planning",
    ]);
    const building = await cardIn(boardId, "idle in building", [
      "specifying",
      "planning",
      "building",
    ]);
    const asked = await cardIn(boardId, "asked twice", ["specifying"]);
    const byHand = await cardIn(boardId, "blocked needs_input by hand", [
      "specifying",
    ]);
    const approval = await cardIn(boardId, "approval pending", [
      "specifying",
      "planning",
      "building",
    ]);
    const capability = await cardIn(boardId, "blocked, but asked to push", [
      "specifying",
    ]);
    const planAsks = await cardIn(boardId, "plan run waits on an approval", [
      "specifying",
      "planning",
    ]);

    await withService((s) =>
      Effect.gen(function* () {
        yield* s.block({
          taskId: waiting.id,
          expectedRevision: waiting.revision,
          reason: "dependency",
          actor: LUKAS,
        });
        yield* s.block({
          taskId: capability.id,
          expectedRevision: capability.revision,
          reason: "capability",
          actor: LUKAS,
        });
        yield* s.ask({
          taskId: asked.id,
          question: "Which repo?",
          actor: RUN,
        });
        yield* s.ask({
          taskId: asked.id,
          question: "And which branch?",
          actor: RUN,
        });
        yield* s.block({
          taskId: byHand.id,
          expectedRevision: byHand.revision,
          reason: "needs_input",
          note: "Pick a database first.",
          actor: LUKAS,
        });
      }),
    );

    const newestPlanRun = newSession();
    const approvalRun = newSession();
    const capabilityRun = newSession();
    const planAskRun = newSession();
    const [onBoard, everywhere, clean] = await attentionWith(
      {
        runs: [
          // The newest run of the card is in `specifying`; the gate names the newest *planning* run.
          { taskId: gated.id, column: "planning", status: "idle", ago: 300 },
          {
            taskId: gated.id,
            column: "planning",
            status: "idle",
            ago: 200,
            sessionId: newestPlanRun,
          },
          { taskId: gated.id, column: "specifying", status: "idle", ago: 100 },
          { taskId: merge.id, column: "review", status: "idle", ago: 50 },
          // Busy anywhere keeps the card off the gate, even with an idle run in the column.
          { taskId: busy.id, column: "planning", status: "idle", ago: 90 },
          { taskId: busy.id, column: "specifying", status: "busy", ago: 80 },
          { taskId: noRun.id, column: "specifying", status: "idle", ago: 70 },
          { taskId: waiting.id, column: "planning", status: "idle", ago: 60 },
          { taskId: building.id, column: "building", status: "idle", ago: 40 },
          {
            taskId: approval.id,
            column: "building",
            status: "busy",
            ago: 30,
            sessionId: approvalRun,
          },
          {
            taskId: capability.id,
            column: "specifying",
            status: "idle",
            ago: 20,
            sessionId: capabilityRun,
          },
          // Parked on an approval is idle (LOB-52), but the run waits on a decision, not a move.
          {
            taskId: planAsks.id,
            column: "planning",
            status: "idle",
            ago: 15,
            sessionId: planAskRun,
          },
        ],
        approvals: [
          {
            sessionId: approvalRun,
            requestId: "push",
            action: "push refs/heads/main",
            ago: 10,
          },
          {
            sessionId: approvalRun,
            requestId: "settled",
            action: "push refs/heads/old",
            ago: 30,
            decided: true,
          },
          {
            sessionId: capabilityRun,
            requestId: "first",
            action: "open a PR",
            ago: 20,
          },
          {
            sessionId: planAskRun,
            requestId: "plan-push",
            action: "git push",
            ago: 5,
          },
        ],
      },
      [boardId, undefined, await newBoard()],
    );

    expect(rows(onBoard ?? [])).toEqual([
      ["approval", "blocked, but asked to push"],
      ["approval", "approval pending"],
      ["approval", "plan run waits on an approval"],
      ["question", "asked twice"],
      ["question", "blocked needs_input by hand"],
      ["gate", "plan waits"],
      ["gate", "merge waits"],
    ]);
    const listed = new Set((onBoard ?? []).map((item) => item.task.id));
    for (const absent of [resting, busy, noRun, waiting, building]) {
      expect(listed.has(absent.id)).toBe(false);
    }

    const reasons = (onBoard ?? []).map((item) => item.reason);
    expect(reasons[1]).toMatchObject({
      _tag: "approval",
      sessionId: approvalRun,
      requestId: "push",
      action: "push refs/heads/main",
    });
    // The newest question in the thread, and the block's note when no run asked.
    // An idle planning run holding an undecided approval is the approval row only, never a gate.
    expect(
      (onBoard ?? []).filter((item) => item.task.id === planAsks.id),
    ).toHaveLength(1);
    expect(reasons[2]).toMatchObject({
      _tag: "approval",
      sessionId: planAskRun,
      requestId: "plan-push",
    });
    expect(reasons[3]).toMatchObject({
      _tag: "question",
      question: "And which branch?",
    });
    expect(reasons[4]).toMatchObject({
      _tag: "question",
      question: "Pick a database first.",
    });
    expect(reasons[5]).toEqual({
      _tag: "gate",
      gate: "plan approval",
      to: "building",
      sessionId: newestPlanRun,
    });
    expect(reasons[6]).toMatchObject({
      _tag: "gate",
      gate: "merge",
      to: "done",
    });
    expect(
      (onBoard ?? []).every(
        (item) => item.task.boardId === boardId && item.repo.length > 0,
      ),
    ).toBe(true);

    // Every board: this board's rows are all there, in the same order.
    expect(
      rows((everywhere ?? []).filter((item) => item.task.boardId === boardId)),
    ).toEqual(rows(onBoard ?? []));
    // A board where nothing needs a person answers an empty list, not an error.
    expect(clean).toEqual([]);
  });

  it("drops a question once a person answers it, and refuses a board that does not exist", async () => {
    const boardId = await newBoard();
    const task = await cardIn(boardId, "answer me", ["specifying"]);
    const parked = await withService((s) =>
      s.ask({ taskId: task.id, question: "Which repo?", actor: RUN }),
    );
    expect(rows(await withService((s) => s.attention(boardId)))).toEqual([
      ["question", "answer me"],
    ]);
    await withService((s) =>
      s.comment({
        taskId: task.id,
        expectedRevision: parked.revision,
        body: "factory.",
        actor: LUKAS,
      }),
    );
    expect(await withService((s) => s.attention(boardId))).toEqual([]);

    // Blocked `needs_input` again by hand: the answered question is the old block's, not this one's.
    const answered = await withService((s) => s.get(task.id));
    const reblocked = await withService((s) =>
      s.block({
        taskId: task.id,
        expectedRevision: answered.revision,
        reason: "needs_input",
        note: "Pick a database first.",
        actor: LUKAS,
      }),
    );
    expect(
      (await withService((s) => s.attention(boardId))).map((i) => i.reason),
    ).toEqual([
      {
        _tag: "question",
        question: "Pick a database first.",
        since: reblocked.blocked?.since,
      },
    ]);

    // With no note either, the row says nothing was asked rather than repeating the old question.
    const other = await cardIn(boardId, "asked, answered, blocked bare", [
      "specifying",
    ]);
    const otherParked = await withService((s) =>
      s.ask({ taskId: other.id, question: "Which branch?", actor: RUN }),
    );
    const otherAnswered = await withService((s) =>
      s.comment({
        taskId: other.id,
        expectedRevision: otherParked.revision,
        body: "main.",
        actor: LUKAS,
      }),
    );
    await withService((s) =>
      s.block({
        taskId: other.id,
        expectedRevision: otherAnswered.revision,
        reason: "needs_input",
        actor: LUKAS,
      }),
    );
    const bare = (await withService((s) => s.attention(boardId))).find(
      (item) => item.task.id === other.id,
    );
    expect(bare?.reason).toMatchObject({ _tag: "question" });
    expect(bare?.reason).not.toHaveProperty("question");

    const missing = await refusal((s) => s.attention(`brd_${hex(13)}`));
    expect(missing._tag).toBe("BoardNotFound");
  });
});
