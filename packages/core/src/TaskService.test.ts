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
import { LIST_BOARDS_LIMIT } from "@repo/domain/Task";
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
    // afterwards, so a dashboard on the same database does not list them for a day.
    const tag = hex(4);
    const ids = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
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
