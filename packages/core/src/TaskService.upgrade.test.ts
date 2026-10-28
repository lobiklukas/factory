/**
 * `TaskService.upgradeBoard` against the real `board_instances` / `tasks` / `task_events` tables (D5):
 * the pin moves at the version the caller expected, a card made before it keeps its version and its
 * moves while a card made after it gets the new ones, and `migrateCards` re-pins every card with a
 * `repinned` event — or, when one cannot move, none, and the pin stays where it was.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. The cases that need moves of
 * their own define an id of their own (never `default`), removed with their boards when the file is
 * done; the cases about `verified` bind fresh boards over the seeded `default` v2 and v3.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import { RepoSlug } from "@repo/domain/Session";
import {
  type BoardColumn,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  REVIEW_VERDICT_REQUIREMENT,
  type Task,
  VERIFIED_REQUIREMENT,
} from "@repo/domain/Task";
import type { DefinitionLibrary } from "./boardDefine";
import {
  TaskService,
  TaskServiceLive,
  type TaskError,
  type TaskServiceShape,
} from "./TaskService";

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive)),
);

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const madeIds: Array<string> = [];
afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      if (madeIds.length === 0) return;
      yield* sql`DELETE FROM board_instances WHERE definition_id IN ${sql.in(madeIds)}`;
      yield* sql`DELETE FROM board_definitions WHERE id IN ${sql.in(madeIds)}`;
    }),
  );
  await runtime.dispose();
});

const withService = <A, E>(
  f: (service: TaskServiceShape) => Effect.Effect<A, E>,
): Promise<A> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* TaskService;
      return yield* f(service);
    }),
  );

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

const LUKAS = "person:lukas";
const LIBRARY: DefinitionLibrary = { skills: new Set(), roles: new Set() };
const newRepo = () => RepoSlug.make(`factory-test/${hex(6)}`);

const terminal = (name: string): BoardColumn => ({
  name,
  kind: "terminal",
  skills: [],
  requires: [],
  transitions: [],
});

/** v1: todo → doing → done. */
const V1: ReadonlyArray<BoardColumn> = [
  {
    name: "todo",
    kind: "resting",
    skills: [],
    requires: [],
    transitions: [{ to: "doing" }, { to: "canceled" }],
  },
  {
    name: "doing",
    kind: "working",
    skills: [],
    requires: [],
    transitions: [{ to: "done" }, { to: "canceled" }],
  },
  terminal("done"),
  terminal("canceled"),
];

/** v2: `doing` is renamed `review`, so todo's move is todo → review and todo → doing is gone. */
const V2: ReadonlyArray<BoardColumn> = [
  {
    name: "todo",
    kind: "resting",
    skills: [],
    requires: [],
    transitions: [{ to: "review" }, { to: "canceled" }],
  },
  {
    name: "review",
    kind: "working",
    skills: [],
    requires: [],
    transitions: [{ to: "done" }, { to: "canceled" }],
  },
  terminal("done"),
  terminal("canceled"),
];

/** A definition of its own at v1 and v2, and a board over it pinned to v1. */
const twoVersions = async () => {
  const id = DefinitionId.make(`upg${hex(4)}`);
  madeIds.push(id);
  for (const columns of [V1, V2]) {
    await withService((s) =>
      s.defineBoard(
        { id, name: "Upgraded", columns, initialColumn: "todo" },
        LIBRARY,
      ),
    );
  }
  const board = await withService((s) =>
    s.createBoard({ repo: newRepo(), definitionId: id, definitionVersion: 1 }),
  );
  return { definitionId: id, boardId: board.id };
};

const defaultBoard = (version: number) =>
  withService((s) =>
    s.createBoard({
      repo: newRepo(),
      definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
      definitionVersion: version,
    }),
  ).then((board) => board.id);

const card = (boardId: string, title = "card") =>
  withService((s) => s.create({ boardId, title, actor: LUKAS }));

const move = (task: Task, to: string) =>
  withService((s) =>
    s.move({
      taskId: task.id,
      expectedRevision: task.revision,
      to,
      actor: LUKAS,
    }),
  );

/** Every card on the board and its event count: the oracle that a refusal wrote nothing. */
const snapshot = (boardId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const pin = yield* sql<{ version: number }>`
        SELECT definition_version AS version FROM board_instances WHERE id = ${boardId}
      `;
      const cards = yield* sql<{
        id: string;
        column: string;
        version: number;
        revision: number;
        events: number;
      }>`
        SELECT t.id, t."column", t.definition_version AS version, t.revision,
               (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id) AS events
        FROM tasks t WHERE t.board_id = ${boardId} ORDER BY t.id
      `;
      return { pin: pin[0]?.version, cards };
    }),
  );

/**
 * A run on the card, written as `createSession` writes it (a `task_runs` row): unfinished unless
 * `finished`. The rows are written and the upgrade run in one transaction (the upgrade's own nests
 * as a savepoint), because a concurrent `rebuildIndexes` in another suite deletes every `task_runs`
 * row whose session has no commits, and it cannot see rows this transaction has not committed.
 */
const withRuns = <A, E>(
  runs: ReadonlyArray<{ readonly taskId: string; readonly finished: boolean }>,
  f: (service: TaskServiceShape) => Effect.Effect<A, E>,
): Promise<A> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const service = yield* TaskService;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const run of runs) {
            const session = `ses_${"0".repeat(10)}${hex(8)}`;
            yield* sql`
              INSERT INTO task_runs (id, task_id, session_id, "column", finished_at)
              VALUES (${session}, ${run.taskId}, ${session}, 'doing',
                      CASE WHEN ${run.finished} THEN now() END)
            `;
          }
          return yield* f(service);
        }),
      );
    }),
  );

describe("TaskService.upgradeBoard", () => {
  /**
   * Mutation: re-pin the existing cards without `migrateCards` — the old card's todo → doing is
   * refused as undeclared. Mutation: leave the instance's pin — the new card starts on v1.
   */
  it("moves the pin: an old card keeps its version and moves, a new card gets the new ones", async () => {
    const { boardId } = await twoVersions();
    const old = await card(boardId, "old");
    expect(old.definitionVersion).toBe(1);

    const upgraded = await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 1,
        actor: LUKAS,
      }),
    );
    expect(upgraded.instance.definitionVersion).toBe(2);
    expect(upgraded.fromVersion).toBe(1);
    expect(upgraded.repinned).toEqual([]);
    expect(upgraded.unmigrated).toBe(1);
    expect(
      (await withService((s) => s.getBoard(boardId))).definition.version,
    ).toBe(2);

    // The old card is untouched: same version, revision and history, and v1's moves.
    const kept = await withService((s) => s.get(old.id));
    expect(kept).toMatchObject({ definitionVersion: 1, revision: 1 });
    expect(
      (
        await refusal((s) =>
          s.move({
            taskId: old.id,
            expectedRevision: 1,
            to: "review",
            actor: LUKAS,
          }),
        )
      )._tag,
    ).toBe("UndeclaredTransition");
    expect((await move(kept, "doing")).column).toBe("doing");

    // A new card pins v2 and moves by v2's: todo → review, and no todo → doing.
    const fresh = await card(boardId, "new");
    expect(fresh.definitionVersion).toBe(2);
    expect(
      (
        await refusal((s) =>
          s.move({
            taskId: fresh.id,
            expectedRevision: 1,
            to: "doing",
            actor: LUKAS,
          }),
        )
      )._tag,
    ).toBe("UndeclaredTransition");
    expect((await move(fresh, "review")).column).toBe("review");
  });

  /** Mutation: drop the expected-version check — the stale call upgrades the board a second time. */
  it("refuses a stale expectedVersion, naming the pin, and writes nothing", async () => {
    const { boardId } = await twoVersions();
    await card(boardId);
    const before = await snapshot(boardId);
    const err = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 2,
        migrateCards: { todo: "todo" },
        actor: LUKAS,
      }),
    );
    expect(err._tag).toBe("StaleBoardVersion");
    expect(err).toMatchObject({ boardId, expected: 2, actual: 1 });
    expect(err.message).toContain("v1, not v2");
    expect(await snapshot(boardId)).toEqual(before);
  });

  it("refuses a version that is not newer, or not held, and an unknown board", async () => {
    const { boardId } = await twoVersions();
    await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 1,
        actor: LUKAS,
      }),
    );
    const down = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 1,
        expectedVersion: 2,
        actor: LUKAS,
      }),
    );
    expect(down).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "toVersion",
    });
    // The pin itself is no upgrade unless it carries a migration of the cards left behind.
    const same = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 2,
        actor: LUKAS,
      }),
    );
    expect(same).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "toVersion",
    });
    const missing = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 9,
        expectedVersion: 2,
        actor: LUKAS,
      }),
    );
    expect(missing).toMatchObject({ _tag: "DefinitionNotFound", version: 9 });
    const noBoard = await refusal((s) =>
      s.upgradeBoard({
        boardId: `brd_${"0".repeat(26)}`,
        toVersion: 2,
        expectedVersion: 1,
        actor: LUKAS,
      }),
    );
    expect(noBoard._tag).toBe("BoardNotFound");
    expect((await snapshot(boardId)).pin).toBe(2);
  });

  /**
   * Mutation: skip the event — the history has no `repinned`. Mutation: keep the card's column — the
   * card in `doing` is a stray under v2. Mutation: no revision bump — a move at the old revision goes
   * through on a card whose moves changed under it.
   */
  it("migrates every card through the mapping, with a repinned event and a new revision each", async () => {
    const { boardId } = await twoVersions();
    const waiting = await card(boardId, "waiting");
    const working = await move(await card(boardId, "working"), "doing");
    const blocked = await withService((s) =>
      s.block({
        taskId: working.id,
        expectedRevision: working.revision,
        reason: "dependency",
        actor: LUKAS,
      }),
    );
    const mapping = { todo: "todo", doing: "review", done: "done" };

    const upgraded = await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 1,
        migrateCards: mapping,
        actor: LUKAS,
      }),
    );
    expect(upgraded.unmigrated).toBe(0);
    expect(upgraded.repinned).toEqual([
      {
        taskId: waiting.id,
        fromVersion: 1,
        from: "todo",
        to: "todo",
        revision: 2,
      },
      {
        taskId: blocked.id,
        fromVersion: 1,
        from: "doing",
        to: "review",
        revision: blocked.revision + 1,
      },
    ]);

    const after = await withService((s) => s.get(blocked.id));
    expect(after).toMatchObject({
      definitionVersion: 2,
      column: "review",
      revision: blocked.revision + 1,
      blocked: { reason: "dependency", column: "review" },
    });
    const events = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{
          kind: string;
          actor: string;
          revision: number;
          payload: unknown;
        }>`
          SELECT kind, actor, revision, payload FROM task_events
          WHERE task_id = ${blocked.id} ORDER BY id
        `;
      }),
    );
    const last = events.at(-1);
    expect(last).toMatchObject({
      kind: "repinned",
      actor: LUKAS,
      revision: blocked.revision,
      payload: {
        _tag: "repinned",
        taskId: blocked.id,
        fromVersion: 1,
        toVersion: 2,
        from: "doing",
        to: "review",
        mapping,
      },
    });
    // The history still says what the card is (LOB-260): the fold follows the repin.
    expect(await withService((s) => s.replay(blocked.id))).toMatchObject({
      column: "review",
      revision: after.revision,
      blocked: { reason: "dependency", column: "review" },
    });

    // The old revision is stale now, and the card moves by v2's moves.
    const stale = await refusal((s) =>
      s.unblock({
        taskId: blocked.id,
        expectedRevision: blocked.revision,
        actor: LUKAS,
      }),
    );
    expect(stale._tag).toBe("StaleRevision");
    const unblocked = await withService((s) =>
      s.unblock({
        taskId: blocked.id,
        expectedRevision: after.revision,
        actor: LUKAS,
      }),
    );
    expect((await move(unblocked, "done")).column).toBe("done");
  });

  /**
   * Mutation: write each card as it is judged — the migratable card is re-pinned before the refusal.
   * Mutation: move the pin before judging the cards — the board is left on v2.
   */
  it("refuses the whole batch for a card with an unfinished run or an unmapped column, naming each, and writes nothing", async () => {
    const { boardId } = await twoVersions();
    const movable = await card(boardId, "movable");
    const running = await move(await card(boardId, "running"), "doing");
    const finishedRun = await move(
      await card(boardId, "finished run"),
      "doing",
    );
    const canceled = await move(await card(boardId, "canceled"), "canceled");
    const before = await snapshot(boardId);

    const err = await withRuns(
      [
        { taskId: running.id, finished: false },
        { taskId: finishedRun.id, finished: true },
      ],
      (s) =>
        s
          .upgradeBoard({
            boardId,
            toVersion: 2,
            expectedVersion: 1,
            migrateCards: { todo: "todo", doing: "review" },
            actor: LUKAS,
          })
          .pipe(Effect.flip),
    );
    expect(err._tag).toBe("CardMigrationRefused");
    if (err._tag !== "CardMigrationRefused") throw new Error("unreachable");
    // The card whose run finished is not refused: only an unfinished run holds a card.
    expect(err.cards).toEqual([
      { taskId: running.id, column: "doing", reason: "unfinished_run" },
      { taskId: canceled.id, column: "canceled", reason: "unmapped_column" },
    ]);
    expect(err.message).toContain(
      `${running.id} (doing) has an unfinished run`,
    );
    expect(err.message).toContain(
      `${canceled.id} (canceled) is in a column the mapping does not name`,
    );
    expect(err.message).not.toContain(movable.id);
    expect(await snapshot(boardId)).toEqual(before);
  });

  /** Mutation: drop the kind check — a working card lands in `done` without crossing its exit. */
  it("refuses a mapping that changes a card's column kind, and one onto a column the version lacks", async () => {
    const { boardId } = await twoVersions();
    const working = await move(await card(boardId), "doing");
    const before = await snapshot(boardId);
    const kind = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 1,
        migrateCards: { doing: "done" },
        actor: LUKAS,
      }),
    );
    expect(kind).toMatchObject({
      _tag: "CardMigrationRefused",
      cards: [{ taskId: working.id, column: "doing", reason: "kind_changed" }],
    });
    const undeclared = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 1,
        migrateCards: { doing: "doing" },
        actor: LUKAS,
      }),
    );
    expect(undeclared).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "migrateCards.doing",
    });
    expect(await snapshot(boardId)).toEqual(before);
  });

  /** Mutation: migrate only cards on the pin before the upgrade — the straggler is never re-pinned. */
  it("re-pins the cards an earlier upgrade left behind, at the pin, and only those", async () => {
    const { boardId } = await twoVersions();
    const behind = await card(boardId, "behind");
    await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 1,
        actor: LUKAS,
      }),
    );
    const current = await card(boardId, "current");
    const migrated = await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 2,
        expectedVersion: 2,
        migrateCards: { todo: "todo" },
        actor: LUKAS,
      }),
    );
    expect(migrated.repinned.map((repin) => repin.taskId)).toEqual([behind.id]);
    expect(migrated.unmigrated).toBe(0);
    expect((await withService((s) => s.get(current.id))).revision).toBe(1);
  });

  /**
   * The acceptance's own case, over the seeded default pipeline: a board on v2 upgraded to v3 gives
   * a new card v3's `verified` gate on review's exit, while a card made before it is held by v2's
   * review, which has none — until it is migrated too.
   */
  it("gives a new card v3's verified gate after a v2 board is upgraded, and a migrated card too", async () => {
    const boardId = await defaultBoard(2);
    const seat = (taskId: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          // Setup, not the subject: building's exit needs a run with a diff and a PR, which
          // TaskService.test.ts proves; this case is about which review the card meets.
          yield* sql`
            UPDATE tasks SET "column" = 'review', revision = revision + 1 WHERE id = ${taskId}
          `;
          const service = yield* TaskService;
          return yield* service.get(taskId);
        }),
      );
    const exitTo = (task: Task) =>
      refusal((s) =>
        s.move({
          taskId: task.id,
          expectedRevision: task.revision,
          to: "done",
          actor: LUKAS,
        }),
      );
    const old = await seat((await card(boardId, "old")).id);
    await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 3,
        expectedVersion: 2,
        actor: LUKAS,
      }),
    );
    const fresh = await seat((await card(boardId, "new")).id);
    expect(fresh.definitionVersion).toBe(3);

    expect(await exitTo(fresh)).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: VERIFIED_REQUIREMENT,
    });
    expect(await exitTo(old)).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: REVIEW_VERDICT_REQUIREMENT,
    });
    const exit = await withService((s) => s.exit(old.id));
    expect(exit.requirements.map((r) => r.key)).not.toContain(
      VERIFIED_REQUIREMENT,
    );

    const columns = [
      "intake",
      "specifying",
      "planning",
      "building",
      "review",
      "done",
      "canceled",
    ];
    const migrated = await withService((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 3,
        expectedVersion: 3,
        migrateCards: Object.fromEntries(columns.map((c) => [c, c])),
        actor: LUKAS,
      }),
    );
    expect(migrated.repinned).toEqual([
      {
        taskId: old.id,
        fromVersion: 2,
        from: "review",
        to: "review",
        revision: old.revision + 1,
      },
    ]);
    const repinned = await withService((s) => s.get(old.id));
    expect(await exitTo(repinned)).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: VERIFIED_REQUIREMENT,
    });
  });

  /**
   * Cards made while a migrating upgrade runs: each either committed before the upgrade read the
   * board's cards, and is re-pinned, or waited on the board and started at the new pin. None is left
   * on v1.
   */
  it("leaves no card on the old version when cards are made during a migration", async () => {
    const { boardId } = await twoVersions();
    await card(boardId, "seed");
    const [, ...made] = await Promise.all([
      withService((s) =>
        s.upgradeBoard({
          boardId,
          toVersion: 2,
          expectedVersion: 1,
          migrateCards: { todo: "todo" },
          actor: LUKAS,
        }),
      ),
      ...Array.from({ length: 6 }, (_, i) => card(boardId, `during ${i}`)),
    ]);
    expect(made).toHaveLength(6);
    const after = await snapshot(boardId);
    expect(after.pin).toBe(2);
    expect(after.cards).toHaveLength(7);
    expect(after.cards.every((c) => c.version === 2)).toBe(true);
  });
});
