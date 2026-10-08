/**
 * The board's cards, driven through `TaskService` against real Postgres (docs/board.md B3–B5, B7, B9).
 *
 * Postgres only, never mocked: the refusals this file asserts are decided by SQL (the compare-and-set
 * `UPDATE`, the rows a failed call must not leave) as much as by TypeScript. It runs against
 * `DATABASE_URL` (`docker compose up -d --wait postgres`), and each case mints its own board instance,
 * so cases never read each other's cards. The boards are removed at the end; `ON DELETE CASCADE` from
 * `board_instances` takes their cards and events with them.
 *
 * Refusals are asserted by their code and by a message that names the failing requirement, because a
 * refusal that names the wrong requirement is the failure this suite exists to catch. The refusals that
 * could have written anything (stale, undeclared, human gate, blocked) assert that they wrote nothing:
 * the event count after them equals the count before.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  BoardInstanceId,
  TaskId,
  type BlockReason,
  type Task,
  type TaskError,
} from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
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

/** A board instance over the seeded `default` definition, unique to one case. */
const newBoard = async (): Promise<BoardInstanceId> => {
  const id = `brd_${randomSuffix(26)}`;
  boards.push(id);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO board_instances (id, repo, definition_id, definition_version)
        VALUES (${id}, 'lobiklukas/factory', 'default', 1)
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
    }),
  );
  await runtime.dispose();
});

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
  const path = ["specifying", "planning", "building", "review", "done"];
  let current = task;
  for (const next of path) {
    if (current.column === column) return current;
    current = await moveTo(current, next);
  }
  return current;
};

/**
 * Resolves once `count` UPDATEs on `tasks` are waiting on a lock, and fails at a deadline.
 *
 * This waits for a fact in the database rather than for a duration: `pg_stat_activity` says which
 * backends are parked on a lock and which statement they are running. The sleep only sets how often
 * that fact is read, and the deadline bounds the wait so a broken case fails rather than hangs.
 */
const waitUntilParked = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = yield* sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND position('UPDATE tasks' IN query) > 0
      `;
      if ((row?.n ?? 0) >= count) return;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(
      new Error(`no ${count} UPDATEs parked on a lock within the deadline`),
    );
  });

describe("creating and reading cards", () => {
  it(
    "creates a card in intake at revision 1, pinned to the board's definition, with one created event",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "first card");

      expect(task).toMatchObject({
        boardId,
        title: "first card",
        column: "intake",
        revision: 1,
        definitionVersion: 1,
        priority: "normal",
      });
      expect(task.blocked).toBeUndefined();
      expect(await eventKinds(task.id)).toEqual(["created"]);
    },
  );

  it(
    "reads back the card it created, and refuses an unknown id as not_found",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "readable");

      const read = await runtime.runPromise(
        withService((tasks) => tasks.get(task.id)),
      );
      expect(read).toEqual(task);

      const missing = TaskId.make(`tsk_${randomSuffix(26)}`);
      const refusal = await refusedBy(
        withService((tasks) => tasks.get(missing)),
      );
      expect(refusal.code).toBe("not_found");
      expect(refusal.message).toContain(missing);
    },
  );

  it(
    "lists a board's cards urgent first, then first in first out, and filters by column",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const first = await create(boardId, "first");
      const second = await create(boardId, "second");
      const urgent = await runtime.runPromise(
        withService((tasks) =>
          tasks.create({
            boardId,
            title: "urgent",
            priority: "urgent",
            by: person,
          }),
        ),
      );

      const listed = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId })),
      );
      expect(listed.map((task) => task.id)).toEqual([
        urgent.id,
        first.id,
        second.id,
      ]);

      const inIntake = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId, column: "intake" })),
      );
      expect(inIntake).toHaveLength(3);

      const inSpecifying = await runtime.runPromise(
        withService((tasks) => tasks.list({ boardId, column: "specifying" })),
      );
      expect(inSpecifying).toEqual([]);

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.list({
            boardId: BoardInstanceId.make(`brd_${randomSuffix(26)}`),
          }),
        ),
      );
      expect(refusal.code).toBe("not_found");
    },
  );
});

describe("moving cards", () => {
  it(
    "a declared move bumps the revision and appends exactly one moved event",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "moves");

      const moved = await moveTo(task, "specifying");

      expect(moved).toMatchObject({ column: "specifying", revision: 2 });
      expect(await eventKinds(task.id)).toEqual(["created", "moved"]);
    },
  );

  it(
    "a stale expected revision refuses, names both revisions, and writes no event",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "stale");
      await moveTo(task, "specifying");
      const before = await eventCount(task.id);

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
      expect(refusal.message).toContain("revision 2");
      expect(refusal.message).toContain("expected 1");
      expect(await eventCount(task.id)).toBe(before);
    },
  );

  it(
    "three moves racing on one revision leave exactly one standing and one event for it",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "race");
      const attempt = (who: string) =>
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "specifying",
            by: { kind: "person", id: who },
          }),
        ).pipe(
          Effect.map(() => "moved" as const),
          Effect.catch((refusal) => Effect.succeed(refusal.code)),
        );

      const outcomes = await runtime.runPromise(
        Effect.all([attempt("ana"), attempt("ben"), attempt("cy")], {
          concurrency: "unbounded",
        }),
      );

      expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome === "stale_revision"),
      ).toHaveLength(2);
      expect(await eventKinds(task.id)).toEqual(["created", "moved"]);
    },
  );

  it(
    "a move that passed its precheck still loses to a commit it did not see",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "held");
      const attempt = (who: string) =>
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "specifying",
            by: { kind: "person", id: who },
          }),
        ).pipe(
          Effect.map(() => "moved" as const),
          Effect.catch((refusal) => Effect.succeed(refusal.code)),
        );

      // The racers' prechecks are plain SELECTs, which do not wait on a row lock, so while this
      // holder keeps `FOR UPDATE` on the card every racer passes its precheck at revision 1 and then
      // parks on its own UPDATE. Only the SQL predicate `AND revision = …` can then tell them apart:
      // without it all three UPDATEs run in turn and three moves land. The test does not depend on
      // scheduling, because the release waits until the database reports all three parked.
      const outcomes = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const locked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT id FROM tasks WHERE id = ${task.id} FOR UPDATE`;
                yield* Deferred.succeed(locked, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );
          yield* Deferred.await(locked);
          const racers = yield* Effect.forkChild(
            Effect.all([attempt("ana"), attempt("ben"), attempt("cy")], {
              concurrency: "unbounded",
            }),
          );
          yield* waitUntilParked(3);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          return yield* Fiber.join(racers);
        }),
      );

      expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome === "stale_revision"),
      ).toHaveLength(2);
      expect(await eventKinds(task.id)).toEqual(["created", "moved"]);
    },
  );

  it(
    "an undeclared transition refuses, names the column and the transition, and writes nothing",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "skips");

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: task.id,
            expectedRevision: 1,
            to: "building",
            by: person,
          }),
        ),
      );

      expect(refusal.code).toBe("undeclared_transition");
      expect(refusal.message).toContain("intake → building");
      expect(await eventKinds(task.id)).toEqual(["created"]);
    },
  );

  it(
    "a terminal card has no transition out, and cancel is declared from every column before it",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const done = await advanceTo(await create(boardId, "finished"), "done");
      expect(done.column).toBe("done");

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: done.id,
            expectedRevision: done.revision,
            to: "canceled",
            by: person,
          }),
        ),
      );
      expect(refusal.code).toBe("undeclared_transition");
      expect(refusal.message).toContain("done → canceled");

      const canceled = await moveTo(
        await create(boardId, "dropped"),
        "canceled",
      );
      expect(canceled.column).toBe("canceled");
    },
  );

  it(
    "a run may not cross the plan approval gate, and a person may",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const planning = await advanceTo(
        await create(boardId, "gated"),
        "planning",
      );
      expect(planning.column).toBe("planning");
      const before = await eventCount(planning.id);

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
      expect(refusal.message).toContain("planning");
      expect(await eventCount(planning.id)).toBe(before);

      const building = await moveTo(planning, "building", person);
      expect(building.column).toBe("building");
    },
  );

  it(
    "a run may not cross the merge gate, and a person may",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const review = await advanceTo(await create(boardId, "merged"), "review");
      expect(review.column).toBe("review");

      const refusal = await refusedBy(
        withService((tasks) =>
          tasks.move({
            taskId: review.id,
            expectedRevision: review.revision,
            to: "done",
            by: run("ses_01runrunrunrunrunrunrunrun"),
          }),
        ),
      );

      expect(refusal.code).toBe("human_gate");
      expect(refusal.message).toContain("human_merge");

      const done = await moveTo(review, "done", person);
      expect(done.column).toBe("done");
    },
  );

  it(
    "a blocked card cannot move until it is unblocked",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "held");
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
      expect(refusal.message).toContain("needs_input");

      const unblocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.unblock({
            taskId: task.id,
            expectedRevision: blocked.revision,
            by: person,
          }),
        ),
      );
      const moved = await moveTo(unblocked, "specifying");
      expect(moved.column).toBe("specifying");
    },
  );
});

describe("blocking cards", () => {
  it(
    "typed block reasons round-trip through the service unchanged, with their note",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "blocked in turn");
      const reasons: ReadonlyArray<BlockReason> = [
        "dependency",
        "needs_input",
        "capability",
        "transient",
      ];

      let current = task;
      for (const reason of reasons) {
        current = await runtime.runPromise(
          withService((tasks) =>
            tasks.block({
              taskId: task.id,
              expectedRevision: current.revision,
              reason,
              note: `why ${reason}`,
              by: person,
            }),
          ),
        );
        const read = await runtime.runPromise(
          withService((tasks) => tasks.get(task.id)),
        );
        expect(read.blocked).toEqual({
          reason,
          column: "intake",
          note: `why ${reason}`,
          since: expect.any(String),
        });
        expect(read).toEqual(current);

        current = await runtime.runPromise(
          withService((tasks) =>
            tasks.unblock({
              taskId: task.id,
              expectedRevision: current.revision,
              by: person,
            }),
          ),
        );
        expect(current.blocked).toBeUndefined();
      }

      expect(current.revision).toBe(1 + reasons.length * 2);
      expect(await eventKinds(task.id)).toEqual([
        "created",
        ...reasons.flatMap(() => ["blocked", "unblocked"]),
      ]);
    },
  );

  it(
    "blocking a blocked card and unblocking an unblocked one refuse by code, and write nothing",
    { timeout: 30_000 },
    async () => {
      const boardId = await newBoard();
      const task = await create(boardId, "already");
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
      const before = await eventCount(task.id);

      const twice = await refusedBy(
        withService((tasks) =>
          tasks.block({
            taskId: task.id,
            expectedRevision: blocked.revision,
            reason: "transient",
            by: person,
          }),
        ),
      );
      expect(twice.code).toBe("already_blocked");

      const unblocked = await runtime.runPromise(
        withService((tasks) =>
          tasks.unblock({
            taskId: task.id,
            expectedRevision: blocked.revision,
            by: person,
          }),
        ),
      );
      const again = await refusedBy(
        withService((tasks) =>
          tasks.unblock({
            taskId: task.id,
            expectedRevision: unblocked.revision,
            by: person,
          }),
        ),
      );
      expect(again.code).toBe("not_blocked");
      expect(await eventCount(task.id)).toBe(before + 1);
    },
  );
});
