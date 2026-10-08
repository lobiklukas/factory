/**
 * The cases `TaskService.test.ts` does not pin, written to try to break LOB-59.
 *
 * Where that file checks one refusal at a time, this one checks the two things a refusal has to
 * leave behind it: the `tasks` row and the `task_events` count. A refusal that reports the right
 * code and still bumps a revision, or still appends an event, is the failure LOB-59 exists to
 * prevent, and it is invisible to a test that only reads the refusal.
 *
 * It also pins the boundaries the 13 cases never reach: a card sitting in a column its definition
 * does not declare, a definition with no columns, a canceled card, a move to the card's own column,
 * and the one place the human gate does **not** apply (a run canceling out of a gated column).
 *
 * Same real-Postgres setup as `TaskService.test.ts`: no mocks, one board per case, boards removed
 * in `afterAll`. Expected values are the spec's own literals, never recomputed from the service.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  BoardInstanceId,
  TaskId,
  type Task,
  type TaskError,
} from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  TaskService,
  TaskServiceLive,
  type Principal,
  type TaskServiceShape,
} from "./TaskService";

const Live = Layer.provideMerge(
  TaskServiceLive,
  Layer.mergeAll(DatabaseLive, BunServices.layer),
);
const runtime = ManagedRuntime.make(Live);

const person: Principal = { kind: "person", id: "lukas" };
const run = (runId: string): Principal => ({ kind: "run", runId });

/** 32 characters, the Crockford alphabet the id patterns accept. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const randomSuffix = (length: number) =>
  Array.from(
    randomBytes(length),
    (byte) => ALPHABET[byte % ALPHABET.length],
  ).join("");

/** Every board this run created, removed in `afterAll`. */
const boards: string[] = [];
/**
 * Every definition this run wrote itself, removed in `afterAll` after the boards that pin them. The
 * storage suite counts `board_definitions` in the configured database, so a definition left behind
 * here reddens a package this file never touches.
 */
const definitions: Array<{ id: string; version: number }> = [];

/** A board instance over the seeded `default` definition, unique to one case. */
const newBoard = async (
  id = `brd_${randomSuffix(26)}`,
  definitionId = "default",
  definitionVersion = 1,
): Promise<BoardInstanceId> => {
  boards.push(id);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO board_instances (id, repo, definition_id, definition_version)
        VALUES (${id}, 'lobiklukas/factory', ${definitionId}, ${definitionVersion})
      `;
    }),
  );
  return BoardInstanceId.make(id);
};

/**
 * A board over a definition this test writes itself. `board_instances` has a foreign key to
 * `board_definitions`, so the definition row has to land first.
 */
const newBoardOver = async (
  definitionId: string,
  version: number,
  columnsJson: string,
): Promise<BoardInstanceId> => {
  const id = `brd_${randomSuffix(26)}`;
  boards.push(id);
  definitions.push({ id: definitionId, version });
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO board_definitions (id, version, name, columns)
        VALUES (${definitionId}, ${version}, 'test', ${columnsJson}::jsonb)
        ON CONFLICT (id, version) DO NOTHING
      `;
      yield* sql`
        INSERT INTO board_instances (id, repo, definition_id, definition_version)
        VALUES (${id}, 'lobiklukas/factory', ${definitionId}, ${version})
      `;
    }),
  );
  return BoardInstanceId.make(id);
};

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      for (const id of boards) {
        yield* sql`DELETE FROM board_instances WHERE id = ${id}`;
      }
      for (const definition of definitions) {
        yield* sql`
          DELETE FROM board_definitions WHERE id = ${definition.id} AND version = ${definition.version}
        `;
      }
    }),
  );
  await runtime.dispose();
});

/**
 * The whole `tasks` row as text, so a refusal can be shown to have left it byte-for-byte alone.
 * `PostgresLive`'s snake-to-camel transform has already run by the time the row reaches here, so
 * the keys are the domain's own names (`blockedColumn`, not `blocked_column`).
 */
const taskRow = (taskId: TaskId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const [row] = yield* sql<{
        column: string;
        revision: number;
        priority: string;
        blockedReason: string | null;
        blockedColumn: string | null;
        blockedNote: string | null;
        blockedSince: string | null;
        createdAt: string;
        updatedAt: string;
      }>`
        SELECT "column", revision, priority, blocked_reason, blocked_column, blocked_note,
          to_char(blocked_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS blocked_since,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM tasks WHERE id = ${taskId}
      `;
      return row;
    }),
  );

/** The number of `task_events` rows a card has; a refused call must leave it where it was. */
const eventCount = (taskId: TaskId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const [row] = yield* sql<{ n: number }>`
        SELECT count(*)::int AS n FROM task_events WHERE task_id = ${taskId}
      `;
      return row?.n ?? 0;
    }),
  );

/** The `kind` of each event on a card, in the order they were written. */
const eventKinds = (taskId: TaskId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ kind: string }>`
        SELECT kind FROM task_events WHERE task_id = ${taskId} ORDER BY id
      `;
      return rows.map((row) => row.kind);
    }),
  );

/** Each event's actor, revision and payload, in the order they were written. */
const eventRows = (taskId: TaskId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        kind: string;
        actor: string;
        revision: number;
        payload: Record<string, unknown>;
      }>`
        SELECT kind, actor, revision, payload FROM task_events
        WHERE task_id = ${taskId} ORDER BY id
      `;
      return rows;
    }),
  );

/** Runs a call that must be refused, and returns the refusal. A call that succeeds fails the test. */
const refusedBy = <A>(effect: Effect.Effect<A, TaskError, TaskService>) =>
  runtime.runPromise(Effect.flip(effect));

/** Runs `use` against the service, so a call reads as one expression over the shape. */
const withService = <A>(
  use: (tasks: TaskServiceShape) => Effect.Effect<A, TaskError>,
) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return yield* use(tasks);
  });

const create = (
  boardId: BoardInstanceId,
  title: string,
  by: Principal = person,
) =>
  runtime.runPromise(
    withService((tasks) => tasks.create({ boardId, title, by })),
  );

/** One expected revision, moved forward by `to` as `by`. Returns the card at its new revision. */
const moveTo = (task: Task, to: string, by: Principal = person) =>
  runtime.runPromise(
    withService((tasks) =>
      tasks.move({ taskId: task.id, expectedRevision: task.revision, to, by }),
    ),
  );

/** Walks a card from intake through every working column as a person, to `column`. */
const advanceTo = async (task: Task, column: string): Promise<Task> => {
  const path = [
    "intake",
    "specifying",
    "planning",
    "building",
    "review",
    "done",
  ];
  let current = task;
  while (current.column !== column) {
    const next = path[path.indexOf(current.column) + 1];
    if (next === undefined) {
      throw new Error(
        `no column after ${current.column} on the way to ${column}`,
      );
    }
    current = await moveTo(current, next);
  }
  return current;
};

/** Takes the "before" snapshot a refusal is later compared against. */
const snapshotOf = async (taskId: TaskId) => {
  const row = await taskRow(taskId);
  expect(row).toBeDefined();
  return row;
};

describe("a refused move writes nothing and changes no row", () => {
  it(
    "a stale move leaves the tasks row and the event count untouched, and the next move still works",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "stale writes nothing");
      const moved = await moveTo(task, "specifying");
      const before = await snapshotOf(moved.id);
      const eventsBefore = await eventCount(moved.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "specifying",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("stale_revision");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);

      // The refusal consumed nothing: the card is still at the revision the winner left.
      expect(moved.revision).toBe(2);
      const again = await moveTo(moved, "planning");
      expect(again.column).toBe("planning");
      expect(await eventKinds(task.id)).toEqual(["created", "moved", "moved"]);
    },
  );

  it(
    "an undeclared transition leaves the tasks row and the event count untouched",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "undeclared writes nothing");
      const before = await snapshotOf(task.id);
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "review",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("undeclared_transition");
      expect(refusal.message).toContain("intake → review");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);
    },
  );

  it(
    "a human gate a run cannot cross leaves the tasks row and the event count untouched",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const planning = await advanceTo(
        await create(boardId, "gate writes nothing"),
        "planning",
      );
      const before = await snapshotOf(planning.id);
      const eventsBefore = await eventCount(planning.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: planning.id,
            expectedRevision: planning.revision,
            to: "building",
            by: run("ses_01runrunrunrunrunrunrunrun"),
          }),
        ),
      );
      expect(refusal.code).toBe("human_gate");
      expect(refusal.message).toContain("human_move");
      expect(await taskRow(planning.id)).toEqual(before);
      expect(await eventCount(planning.id)).toBe(eventsBefore);
    },
  );

  it(
    "a move of a blocked card leaves the tasks row and the event count untouched",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "blocked writes nothing");
      const blocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.block({
            taskId: task.id,
            expectedRevision: 1,
            reason: "capability",
            by: person,
          }),
        ),
      );
      const before = await snapshotOf(task.id);
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: blocked.revision,
            to: "specifying",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("blocked");
      expect(refusal.message).toContain("capability");
      expect(refusal.message).toContain("intake");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);
    },
  );

  it(
    "a stale expected revision of 0 refuses as stale rather than matching a card",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "revision zero");
      const before = await snapshotOf(task.id);
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 0,
            to: "specifying",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("stale_revision");
      expect(refusal.message).toContain("revision 1");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);
    },
  );

  it(
    "a stale move is refused as stale even when it is also undeclared, blocked or gated",
    { timeout: 30_000 },
    async () => {
      // The revision check runs first, so a call that is wrong twice over says which of the two
      // it hit. If the order ever flips, these four say so.
      const boardId = await newBoard();
      const task = await create(boardId, "wrong twice over");
      const planning = await advanceTo(task, "planning");
      const blocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.block({
            taskId: planning.id,
            expectedRevision: planning.revision,
            reason: "transient",
            by: person,
          }),
        ),
      );

      const stale = { expectedRevision: 1 };
      const undeclared = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            ...stale,
            to: "done",
            by: person,
          }),
        ),
      );
      expect(undeclared.code).toBe("stale_revision");

      const gated = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: planning.id,
            ...stale,
            to: "building",
            by: run("ses_01runrunrunrunrunrunrunrun"),
          }),
        ),
      );
      expect(gated.code).toBe("stale_revision");

      const blockedRefusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: blocked.id,
            expectedRevision: 1,
            to: "building",
            by: person,
          }),
        ),
      );
      expect(blockedRefusal.code).toBe("stale_revision");

      expect(await eventKinds(planning.id)).toEqual([
        "created",
        "moved",
        "moved",
        "blocked",
      ]);
    },
  );
});

describe("the race, with real concurrency", () => {
  it(
    "five racers on one revision: exactly one wins, the card moves once, and two events exist",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "five way race");
      const attempt = (who: number) =>
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "specifying",
            by: { kind: "person", id: `racer${who}` },
          }),
        ).pipe(
          Effect.map(() => "moved" as const),
          Effect.catch((refusal) => Effect.succeed(refusal.code)),
        );

      const outcomes = await runtime.runPromise(
        Effect.all([0, 1, 2, 3, 4].map(attempt), { concurrency: "unbounded" }),
      );

      expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome === "stale_revision"),
      ).toHaveLength(4);

      // Not clobbered: one move, one revision bump, one event. A loser that wrote anyway would
      // leave the card at revision 3 and a second `moved` event behind.
      const after = await runtime.runPromise(
        withService((tasks) => tasks.get(task.id)),
      );
      expect(after).toMatchObject({ column: "specifying", revision: 2 });
      expect(await eventKinds(task.id)).toEqual(["created", "moved"]);
    },
  );

  it(
    "racers aiming at different targets: exactly one target is applied, and it is one of theirs",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "race for two targets");
      const attempt = (to: string) =>
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to,
            by: person,
          }),
        ).pipe(
          Effect.map(() => to),
          Effect.catch((refusal) => Effect.succeed(refusal.code)),
        );

      const outcomes = await runtime.runPromise(
        Effect.all([attempt("specifying"), attempt("canceled")], {
          concurrency: "unbounded",
        }),
      );

      const winners = outcomes.filter(
        (outcome) => outcome === "specifying" || outcome === "canceled",
      );
      expect(winners).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome === "stale_revision"),
      ).toHaveLength(1);

      const after = await runtime.runPromise(
        withService((tasks) => tasks.get(task.id)),
      );
      expect(after.column).toBe(winners[0]);
      expect(after.revision).toBe(2);
      expect(await eventKinds(task.id)).toEqual(["created", "moved"]);
    },
  );

  it(
    "a race won by a run leaves the winner's actor on the event, not the losers'",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "run races");
      const attempt = (runId: string) =>
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "specifying",
            by: run(runId),
          }),
        ).pipe(
          Effect.map(() => runId),
          Effect.catch((refusal) => Effect.succeed(refusal.code)),
        );

      const outcomes = await runtime.runPromise(
        Effect.all(
          ["ses_01aaaaaaaaaaaaaaaa", "ses_01bbbbbbbbbbbbbbbb"].map(attempt),
          { concurrency: "unbounded" },
        ),
      );

      const winners = outcomes.filter((outcome) => outcome.startsWith("ses_"));
      expect(winners).toHaveLength(1);
      const rows = await eventRows(task.id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        kind: "moved",
        actor: `run:${winners[0]}`,
        revision: 1,
      });
      const movedEvent = rows[1];
      if (movedEvent === undefined) throw new Error("no second event");
      const payload = movedEvent.payload as { from: string; to: string };
      expect(payload.from).toBe("intake");
      expect(payload.to).toBe("specifying");
    },
  );
});

describe("block and unblock under a stale revision", () => {
  it(
    "a stale block refuses, writes no event, and leaves the card unblocked at its revision",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "stale block");
      const moved = await moveTo(task, "specifying");
      const before = await snapshotOf(moved.id);
      const eventsBefore = await eventCount(moved.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.block({
            taskId: moved.id,
            expectedRevision: 1,
            reason: "dependency",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("stale_revision");
      expect(refusal.message).toContain("revision 2");
      expect(refusal.message).toContain("expected 1");
      expect(await taskRow(moved.id)).toEqual(before);
      expect(await eventCount(moved.id)).toBe(eventsBefore);

      // Still unblocked, so it can still move.
      const planning = await moveTo(moved, "planning");
      expect(planning.column).toBe("planning");
    },
  );

  it(
    "a stale unblock refuses, writes no event, and leaves the block standing",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "stale unblock");
      const blocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.block({
            taskId: task.id,
            expectedRevision: 1,
            reason: "needs_input",
            by: person,
          }),
        ),
      );
      const before = await snapshotOf(task.id);
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.unblock({
            taskId: task.id,
            expectedRevision: 1,
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("stale_revision");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);

      // The block survived the refusal, so the card still cannot move.
      const still = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: blocked.revision,
            to: "specifying",
            by: person,
          }),
        ),
      );
      expect(still.code).toBe("blocked");
    },
  );

  it(
    "a stale block of an already-blocked card says stale, not already_blocked",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "stale and blocked");
      const blocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.block({
            taskId: task.id,
            expectedRevision: 1,
            reason: "transient",
            by: person,
          }),
        ),
      );
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.block({
            taskId: task.id,
            expectedRevision: 1,
            reason: "transient",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("stale_revision");
      expect(await eventCount(task.id)).toBe(eventsBefore);
      expect((await taskRow(task.id))?.blockedReason).toBe("transient");
      expect(blocked.revision).toBe(2);
    },
  );

  it(
    "a block records the column it blocked from, and an unblock clears it and says so",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const building = await advanceTo(
        await create(boardId, "blocks where it sits"),
        "building",
      );
      expect(building.column).toBe("building");

      const blocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.block({
            taskId: building.id,
            expectedRevision: building.revision,
            reason: "capability",
            note: "no builder available",
            by: person,
          }),
        ),
      );
      expect(blocked.blocked).toEqual({
        reason: "capability",
        column: "building",
        note: "no builder available",
        since: expect.any(String),
      });
      expect((await taskRow(building.id))?.blockedColumn).toBe("building");

      const unblocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.unblock({
            taskId: building.id,
            expectedRevision: blocked.revision,
            by: person,
          }),
        ),
      );
      expect(unblocked.blocked).toBeUndefined();
      expect(unblocked.revision).toBe(blocked.revision + 1);
      expect((await taskRow(building.id))?.blockedReason).toBeNull();

      const rows = await eventRows(building.id);
      expect(rows.map((row) => row.kind)).toEqual([
        "created",
        "moved",
        "moved",
        "moved",
        "blocked",
        "unblocked",
      ]);
      expect(rows[4]).toMatchObject({
        kind: "blocked",
        actor: "person:lukas",
        revision: blocked.revision - 1,
      });
      expect(rows[5]).toMatchObject({
        kind: "unblocked",
        actor: "person:lukas",
        revision: blocked.revision,
      });
    },
  );

  it(
    "a block without a note carries no note, and its event records the reason and column",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "block without a note");

      const blocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.block({
            taskId: task.id,
            expectedRevision: 1,
            reason: "dependency",
            by: person,
          }),
        ),
      );
      expect(blocked.blocked).toEqual({
        reason: "dependency",
        column: "intake",
        since: expect.any(String),
      });
      expect("note" in (blocked.blocked ?? {})).toBe(false);

      const rows = await eventRows(task.id);
      expect(rows[1]).toMatchObject({
        kind: "blocked",
        actor: "person:lukas",
        revision: 1,
      });
      expect(rows[1]?.payload).toMatchObject({
        reason: "dependency",
        column: "intake",
      });
    },
  );
});

describe("the edges of the transition table", () => {
  it(
    "a canceled card has no transition out, and says so as 'no column'",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const canceled = await moveTo(
        await create(boardId, "canceled card"),
        "canceled",
      );
      expect(canceled.column).toBe("canceled");
      const before = await snapshotOf(canceled.id);
      const eventsBefore = await eventCount(canceled.id);

      for (const to of ["done", "intake", "specifying"]) {
        const refusal = await refusedBy(
          withService((tasks) =>
            tasks.move({
              taskId: canceled.id,
              expectedRevision: canceled.revision,
              to,
              by: person,
            }),
          ),
        );
        expect(refusal.code).toBe("undeclared_transition");
        expect(refusal.message).toContain(`canceled → ${to}`);
        expect(refusal.message).toContain("no column");
      }
      expect(await taskRow(canceled.id)).toEqual(before);
      expect(await eventCount(canceled.id)).toBe(eventsBefore);
    },
  );

  it(
    "a move to the card's own column is undeclared, and names what is declared",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "stays put");
      const before = await snapshotOf(task.id);
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "intake",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("undeclared_transition");
      expect(refusal.message).toContain("intake → intake");
      expect(refusal.message).toContain("specifying, canceled");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);
    },
  );

  it(
    "a column the definition does not declare is undeclared, not missing",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "unknown target");
      const before = await snapshotOf(task.id);
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "limbo",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("undeclared_transition");
      expect(refusal.message).toContain("intake → limbo");
      expect(await taskRow(task.id)).toEqual(before);
      expect(await eventCount(task.id)).toBe(eventsBefore);
    },
  );

  it(
    "a run may enter a gated column but may not leave one, and may cancel out of one",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "run and the gate");

      // Entering `planning` is fine: `requires[]` is checked on the way out, not the way in.
      const specifying = await moveTo(
        task,
        "specifying",
        run("ses_01runrunrunrunrunrunrunrun"),
      );
      const planning = await moveTo(
        specifying,
        "planning",
        run("ses_01runrunrunrunrunrunrunrun"),
      );
      expect(planning.column).toBe("planning");

      // Leaving it for the next column is not.
      const refused = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: planning.id,
            expectedRevision: planning.revision,
            to: "building",
            by: run("ses_01runrunrunrunrunrunrunrun"),
          }),
        ),
      );
      expect(refused.code).toBe("human_gate");
      expect(refused.message).toContain("human_move");

      // Canceling out of it is: the gate guards the pipeline's forward edges, not the exit.
      const canceled = await runtime.runPromise(
        withService((tasks) =>
          tasks.move({
            taskId: planning.id,
            expectedRevision: planning.revision,
            to: "canceled",
            by: run("ses_01runrunrunrunrunrunrunrun"),
          }),
        ),
      );
      expect(canceled.column).toBe("canceled");
      expect(await eventKinds(planning.id)).toEqual([
        "created",
        "moved",
        "moved",
        "moved",
      ]);
    },
  );

  it(
    "a person may cancel out of a gated column, and a run may not cross the merge gate to done",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const review = await advanceTo(
        await create(boardId, "person cancels, run cannot merge"),
        "review",
      );
      expect(review.column).toBe("review");

      const canceled = await moveTo(review, "canceled", person);
      expect(canceled.column).toBe("canceled");

      const fresh = await advanceTo(
        await create(boardId, "run cannot merge"),
        "review",
      );
      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: fresh.id,
            expectedRevision: fresh.revision,
            to: "done",
            by: run("ses_01runrunrunrunrunrunrunrun"),
          }),
        ),
      );
      expect(refusal.code).toBe("human_gate");
      expect(refusal.message).toContain("human_merge");
      expect(refusal.message).toContain("from review to done");
    },
  );
});

describe("rows the definition cannot account for", () => {
  it(
    "a card in a column its definition does not declare refuses as storage, and changes nothing",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const orphanId = TaskId.make(`tsk_${randomSuffix(26)}`);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, priority)
            VALUES (${orphanId}, ${boardId}, 'orphan', 'limbo', 1, 1, 'normal')
          `;
        }),
      );

      // A typed refusal, not a thrown driver error: the caller can branch on the code.
      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: orphanId,
            expectedRevision: 1,
            to: "intake",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("storage");
      expect(refusal.message).toContain("limbo");
      expect((await taskRow(orphanId))?.column).toBe("limbo");
      expect(await eventCount(orphanId)).toBe(0);

      // Reading it back is fine: `column` is a name, and only the move path asks the definition.
      const read = await runtime.runPromise(
        withService((tasks) => tasks.get(orphanId)),
      );
      expect(read.column).toBe("limbo");
    },
  );

  it(
    "a definition with no columns refuses as storage rather than inventing a first column",
    { timeout: 30_000 },
    async () => {
      const definitionId = `empty_${randomSuffix(10)}`;
      const boardId = await newBoardOver(definitionId, 1, "[]");

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.create({ boardId, title: "nowhere to go", by: person }),
        ),
      );
      expect(refusal.code).toBe("storage");
      expect(refusal.message).toContain("no columns");
    },
  );

  it(
    "an unknown board or task refuses as not_found, and writes nothing anywhere",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "known");
      const eventsBefore = await eventCount(task.id);

      const noBoard = await refusedBy(
        withService((tasks) =>
          tasks.create({
            boardId: BoardInstanceId.make(`brd_${randomSuffix(26)}`),
            title: "nowhere",
            by: person,
          }),
        ),
      );
      expect(noBoard.code).toBe("not_found");

      const missing = TaskId.make(`tsk_${randomSuffix(26)}`);
      for (const refusal of [
        await refusedBy(withService((tasks) => tasks.get(missing))),
        await refusedBy(
          withService((tasks) =>
            tasks.move({
              taskId: missing,
              expectedRevision: 1,
              to: "specifying",
              by: person,
            }),
          ),
        ),
        await refusedBy(
          withService((tasks) =>
            tasks.block({
              taskId: missing,
              expectedRevision: 1,
              reason: "transient",
              by: person,
            }),
          ),
        ),
        await refusedBy(
          withService((tasks) =>
            tasks.unblock({ taskId: missing, expectedRevision: 1, by: person }),
          ),
        ),
      ]) {
        expect(refusal.code).toBe("not_found");
        expect(refusal.message).toContain(missing);
      }

      expect(await eventCount(task.id)).toBe(eventsBefore);
    },
  );
});

describe("listing a board", () => {
  it(
    "orders several urgent and normal cards urgent first, then first in first out",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const normal = async (title: string) => create(boardId, title);
      const urgent = (title: string) =>
        runtime.runPromise(
          withService((tasks) =>
            tasks.create({ boardId, title, priority: "urgent", by: person }),
          ),
        );

      // Created in this order, alternating, so neither priority nor arrival alone decides.
      await normal("n1");
      await urgent("u1");
      await normal("n2");
      await urgent("u2");
      await normal("n3");
      await urgent("u3");

      const listed = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId })),
      );
      expect(listed.map((task) => task.title)).toEqual([
        "u1",
        "u2",
        "u3",
        "n1",
        "n2",
        "n3",
      ]);
    },
  );

  it(
    "breaks a tie on created_at by id, so the order is total and repeatable",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      // One statement, one transaction, one `now()`: the two cards share a created_at, so only the
      // id can order them.
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO tasks (id, board_id, title, "column", definition_version, revision, priority)
            VALUES ('tsk_000000000000000000000000bb', ${boardId}, 'bbb', 'intake', 1, 1, 'normal'),
                   ('tsk_000000000000000000000000aa', ${boardId}, 'aaa', 'intake', 1, 1, 'normal')
          `;
        }),
      );

      const listed = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId })),
      );
      expect(listed.map((task) => task.title)).toEqual(["aaa", "bbb"]);
    },
  );

  it(
    "follows a card across columns, and never leaks another board's cards",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const otherId = await newBoard();
      const mine = await create(boardId, "mine");
      const moved = await moveTo(mine, "specifying");
      await create(otherId, "theirs");

      const intake = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId, column: "intake" })),
      );
      expect(intake).toEqual([]);

      const specifying = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId, column: "specifying" })),
      );
      expect(specifying.map((task) => task.id)).toEqual([moved.id]);

      // A column name no definition declares is a filter that matches nothing, not a refusal.
      const limbo = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId, column: "limbo" })),
      );
      expect(limbo).toEqual([]);

      const all = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId })),
      );
      expect(all).toHaveLength(1);
      expect(all[0]?.title).toBe("mine");
    },
  );
});

describe("what an accepted move records", () => {
  it(
    "writes one created event naming its actor, and one moved event naming from, to and actor",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "recorded", person);
      const moved = await moveTo(
        task,
        "specifying",
        run("ses_01runrunrunrunrunrunrunrun"),
      );

      const rows = await eventRows(task.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        kind: "created",
        actor: "person:lukas",
        revision: 1,
      });
      expect(rows[0]?.payload).toMatchObject({
        title: "recorded",
        column: "intake",
      });
      expect(rows[1]).toMatchObject({
        kind: "moved",
        actor: "run:ses_01runrunrunrunrunrunrunrun",
        revision: 1,
      });
      expect(rows[1]?.payload).toMatchObject({
        from: "intake",
        to: "specifying",
      });

      // The event records the revision the mutation expected, which is the revision the card was
      // at before the bump, not the one it holds now.
      expect(rows[1]?.revision).toBe(1);
      expect(moved.revision).toBe(2);
    },
  );

  it(
    "a refused move between two accepted ones leaves no gap in the history",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "no gap");
      const specifying = await moveTo(task, "specifying");
      const eventsBefore = await eventCount(task.id);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "planning",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("stale_revision");

      const planning = await moveTo(specifying, "planning");
      expect(planning.column).toBe("planning");
      expect(planning.revision).toBe(3);
      expect(await eventKinds(task.id)).toEqual(["created", "moved", "moved"]);
      expect(await eventCount(task.id)).toBe(eventsBefore + 1);
    },
  );
});
