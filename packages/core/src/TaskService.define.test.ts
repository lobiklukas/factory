/**
 * `TaskService.defineBoard` against the real `board_definitions` table (D4): a new version is a new
 * row and no row that exists is touched (B2), identical content writes nothing, a dry run writes
 * nothing, every refusal writes nothing, and the version written is one `listDefinitions` lists and
 * `createBoard` pins.
 *
 * `TaskService.upgradeBoard` (D5) is here too, below: the pin moves at the version the caller
 * expected, a card made before it keeps its version and its moves while a card made after it gets the
 * new ones, and `migrateCards` re-pins every card with a `repinned` event — or, when one cannot move,
 * none, and the pin stays where it was. In this file rather than one of its own because its cases
 * define versions too, and a file running beside this one would put rows in `board_definitions`
 * while the cases above prove that a define adds exactly one; a file's cases run one at a time.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Every case defines an id of its
 * own, never `default` — which every other suite's boards pin by default — and the rows go when the
 * file is done. The upgrade cases about `verified` bind fresh boards over the seeded `default` v2.
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
  type DefineBoardInput,
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

/** Every id this file defined, and every board it made, removed when it is done. */
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

/** A fresh definition id, recorded for cleanup. */
const newId = () => {
  const id = `def${hex(4)}`;
  madeIds.push(id);
  return DefinitionId.make(id);
};

const LIBRARY: DefinitionLibrary = {
  skills: new Set(["implement"]),
  roles: new Set(["builder"]),
};

const COLUMNS: ReadonlyArray<BoardColumn> = [
  {
    name: "todo",
    kind: "resting",
    skills: [],
    requires: [],
    transitions: [{ to: "doing" }],
  },
  {
    name: "doing",
    kind: "working",
    role: "builder",
    skills: ["implement"],
    requires: [{ key: "non_empty_diff", description: "a change" }],
    transitions: [{ to: "done", gate: "sign-off" }],
    wipLimit: 3,
  },
  { name: "done", kind: "terminal", skills: [], requires: [], transitions: [] },
];

/** A change's `initialColumn` that means "none": `input` drops the field rather than set it. */
const NO_INITIAL_COLUMN = "\u0000none";

const input = (
  id: DefinitionId,
  change: Partial<DefineBoardInput> = {},
): DefineBoardInput => {
  const { initialColumn, ...rest } = {
    id,
    name: "Authored",
    columns: COLUMNS,
    initialColumn: "todo",
    caps: { board: 4 },
    ...change,
  };
  return initialColumn === NO_INITIAL_COLUMN
    ? rest
    : { ...rest, initialColumn };
};

type Row = {
  id: string;
  version: number;
  name: string;
  columns: string;
  initialColumn: string | null;
  caps: string | null;
  createdAt: string;
};

/** Every `board_definitions` row, as text: the oracle that nothing but one insert happened. */
const allRows = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<Row>`
        SELECT id, version, name, columns::text AS columns, initial_column,
               caps::text AS caps, created_at::text AS created_at
        FROM board_definitions
        ORDER BY id COLLATE "C", version
      `;
    }),
  );

/** The versions one id holds, oldest first. */
const versionsOf = (id: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ version: number }>`
        SELECT version FROM board_definitions WHERE id = ${id} ORDER BY version
      `;
      return rows.map((row) => row.version);
    }),
  );

const key = (row: Row) => `${row.id}@${row.version}`;

describe("TaskService.defineBoard (D4)", () => {
  /**
   * Mutation: `UPDATE` the newest row, or insert at the newest version with `ON CONFLICT DO UPDATE`
   * — a row that existed changes. Mutation: insert at `max` rather than `max + 1` — the insert meets
   * the primary key.
   */
  it("inserts version newest + 1 and changes no row that existed", async () => {
    const id = newId();
    const first = await withService((s) => s.defineBoard(input(id), LIBRARY));
    expect(first.outcome).toBe("created");
    expect(first.definition.version).toBe(1);

    const before = await allRows();
    const second = await withService((s) =>
      s.defineBoard(input(id, { name: "Authored, renamed" }), LIBRARY),
    );
    expect(second.outcome).toBe("created");
    expect(second.definition.version).toBe(2);
    const after = await allRows();

    // Every row that existed is still there, byte for byte; exactly one row is new, and it is v2.
    const afterByKey = new Map(after.map((row) => [key(row), row]));
    for (const row of before) expect(afterByKey.get(key(row))).toEqual(row);
    const beforeKeys = new Set(before.map(key));
    const added = after.filter((row) => !beforeKeys.has(key(row)));
    expect(added.map(key)).toEqual([`${id}@2`]);
    expect(added[0]?.name).toBe("Authored, renamed");
    expect(added[0]?.initialColumn).toBe("todo");
    expect(JSON.parse(added[0]?.caps ?? "null")).toEqual({ board: 4 });

    // The answer is the row read back, not the input echoed.
    expect(second.definition).toEqual({
      id,
      version: 2,
      name: "Authored, renamed",
      columns: COLUMNS,
      initialColumn: "todo",
      caps: { board: 4 },
    });
    expect(await withService((s) => s.getDefinition(id, 1))).toMatchObject({
      name: "Authored",
    });
  });

  /**
   * Mutation: compare by reference or by raw JSON text — the identical define, sent with its keys in
   * another order, writes a v2. Mutation: compare against the oldest version — a revert to v1's content
   * after a v2 is answered as v1 rather than written as v3.
   */
  it("writes nothing for content the newest version already holds, and answers that version", async () => {
    const id = newId();
    await withService((s) => s.defineBoard(input(id), LIBRARY));
    const reordered: DefineBoardInput = {
      caps: { board: 4 },
      initialColumn: "todo",
      columns: [
        {
          transitions: [{ to: "doing" }],
          requires: [],
          skills: [],
          kind: "resting",
          name: "todo",
        },
        {
          wipLimit: 3,
          transitions: [{ gate: "sign-off", to: "done" }],
          requires: [{ description: "a change", key: "non_empty_diff" }],
          skills: ["implement"],
          role: "builder",
          kind: "working",
          name: "doing",
        },
        {
          transitions: [],
          requires: [],
          skills: [],
          kind: "terminal",
          name: "done",
        },
      ],
      name: "Authored",
      id,
    };
    const again = await withService((s) => s.defineBoard(reordered, LIBRARY));
    expect(again.outcome).toBe("unchanged");
    expect(again.definition.version).toBe(1);
    expect(await versionsOf(id)).toEqual([1]);

    // Any change at all is a new version: caps removed, then the original content again.
    const { caps: _caps, ...uncapped } = input(id);
    const v2 = await withService((s) => s.defineBoard(uncapped, LIBRARY));
    expect([v2.outcome, v2.definition.version]).toEqual(["created", 2]);
    const v3 = await withService((s) => s.defineBoard(input(id), LIBRARY));
    expect([v3.outcome, v3.definition.version]).toEqual(["created", 3]);
    expect(await versionsOf(id)).toEqual([1, 2, 3]);
  });

  /** Mutation: ignore `dryRun` — the dry run writes v1. */
  it("validates a dry run and writes nothing, answering the version it would write", async () => {
    const id = newId();
    const before = await allRows();
    const dry = await withService((s) =>
      s.defineBoard(input(id, { dryRun: true }), LIBRARY),
    );
    expect(dry.outcome).toBe("validated");
    expect(dry.definition.version).toBe(1);
    expect(await allRows()).toEqual(before);

    await withService((s) => s.defineBoard(input(id), LIBRARY));
    const next = await withService((s) =>
      s.defineBoard(input(id, { name: "next", dryRun: true }), LIBRARY),
    );
    expect([next.outcome, next.definition.version]).toEqual(["validated", 2]);
    const same = await withService((s) =>
      s.defineBoard(input(id, { dryRun: true }), LIBRARY),
    );
    expect([same.outcome, same.definition.version]).toEqual(["unchanged", 1]);
    expect(await versionsOf(id)).toEqual([1]);

    // A dry run is held to every rule a write is.
    const err = await refusal((s) =>
      s.defineBoard(
        input(id, { initialColumn: "nowhere", dryRun: true }),
        LIBRARY,
      ),
    );
    expect(err._tag).toBe("InvalidDefinition");
  });

  /**
   * One case per refusal of the spec: each is `InvalidDefinition` naming the field, and no row is
   * written — neither for a new id nor as a next version of one that exists. Mutation: run the rules
   * after the insert, or not at all — the id holds a row.
   */
  const REFUSED: ReadonlyArray<
    readonly [string, Partial<DefineBoardInput>, string]
  > = [
    [
      "a duplicate column name",
      {
        columns: [
          ...COLUMNS,
          { name: "done", kind: "terminal", skills: [], requires: [] },
        ],
      },
      "columns[3].name",
    ],
    [
      "a terminal column not named done or canceled",
      {
        columns: COLUMNS.map((column) =>
          column.name === "done"
            ? { ...column, name: "shipped" }
            : column.name === "doing"
              ? { ...column, transitions: [{ to: "shipped" }] }
              : column,
        ),
      },
      "columns[2].name",
    ],
    [
      "no initial column",
      { initialColumn: NO_INITIAL_COLUMN },
      "initialColumn",
    ],
    [
      "a transition to an undeclared column",
      {
        columns: COLUMNS.map((column) =>
          column.name === "todo"
            ? { ...column, transitions: [{ to: "shipped" }] }
            : column,
        ),
      },
      "columns[0].transitions[0].to",
    ],
    [
      "a terminal column with exits",
      {
        columns: COLUMNS.map((column) =>
          column.name === "done"
            ? { ...column, transitions: [{ to: "todo" }] }
            : column,
        ),
      },
      "columns[2].transitions",
    ],
    [
      "no terminal column",
      {
        initialColumn: "todo",
        columns: [
          {
            name: "todo",
            kind: "resting",
            skills: [],
            requires: [],
            transitions: [{ to: "doing" }],
          },
          {
            name: "doing",
            kind: "working",
            skills: [],
            requires: [],
            transitions: [{ to: "todo" }],
          },
        ],
      },
      "columns",
    ],
    [
      "an unknown requires key",
      {
        columns: COLUMNS.map((column) =>
          column.name === "doing"
            ? {
                ...column,
                requires: [{ key: "signed_off", description: "?" }],
              }
            : column,
        ),
      },
      "columns[1].requires[0].key",
    ],
    [
      "an unknown skill",
      {
        columns: COLUMNS.map((column) =>
          column.name === "doing" ? { ...column, skills: ["deploy"] } : column,
        ),
      },
      "columns[1].skills[0]",
    ],
    [
      "a role not in the role table",
      {
        columns: COLUMNS.map((column) =>
          column.name === "doing" ? { ...column, role: "deployer" } : column,
        ),
      },
      "columns[1].role",
    ],
  ];

  for (const [what, change, field] of REFUSED) {
    it(`refuses ${what}, naming ${field}, and writes nothing`, async () => {
      const fresh = newId();
      const err = await refusal((s) =>
        s.defineBoard(input(fresh, change), LIBRARY),
      );
      expect(err._tag).toBe("InvalidDefinition");
      if (err._tag !== "InvalidDefinition") return;
      expect(err.definitionId).toBe(fresh);
      expect(err.field).toBe(field);
      expect(err.problems.map((fault) => fault.field)).toEqual([field]);
      expect(err.message).toContain(field);
      expect(await versionsOf(fresh)).toEqual([]);

      const existing = newId();
      await withService((s) => s.defineBoard(input(existing), LIBRARY));
      const again = await refusal((s) =>
        s.defineBoard(input(existing, change), LIBRARY),
      );
      expect(again._tag).toBe("InvalidDefinition");
      expect(await versionsOf(existing)).toEqual([1]);
    });
  }

  /**
   * `ROLE_MODELS` is a partial override table: the roles the definitions the factory holds declare —
   * the seeded default pipeline's `specifier` and `planner` — are accepted under a table that names
   * only `builder`, so the default pipeline can be re-authored on such a deployment. Mutation: hand
   * the rules the role table alone — `planner` is refused.
   */
  it("accepts a role a held definition declares under a partial role table, and still refuses a typo", async () => {
    const staged = (role: string) => ({
      columns: COLUMNS.map((column) =>
        column.name === "doing" ? { ...column, role } : column,
      ),
    });
    const id = newId();
    const planner = await withService((s) =>
      s.defineBoard(input(id, staged("planner")), LIBRARY),
    );
    expect([planner.outcome, planner.definition.version]).toEqual([
      "created",
      1,
    ]);
    const specifier = await withService((s) =>
      s.defineBoard(input(id, staged("specifier")), LIBRARY),
    );
    expect(specifier.definition.version).toBe(2);
    const typo = await refusal((s) =>
      s.defineBoard(input(id, staged("plannr")), LIBRARY),
    );
    expect(typo).toMatchObject({
      _tag: "InvalidDefinition",
      field: "columns[1].role",
    });
    expect(await versionsOf(id)).toEqual([1, 2]);
  });

  /**
   * The version is one the rest of the board reads: `listDefinitions` lists it, `createBoard` pins it
   * as the newest, and a card on that board starts in its initial column. Mutation: insert without
   * `initial_column` — the card starts in the first column, `todo`, not the declared `doing`.
   */
  it("is listed by listDefinitions and pinned by createBoard, and a card starts in its initial column", async () => {
    const id = newId();
    await withService((s) => s.defineBoard(input(id), LIBRARY));
    const v2 = await withService((s) =>
      s.defineBoard(input(id, { initialColumn: "doing" }), LIBRARY),
    );
    const listed = await withService((s) => s.listDefinitions);
    expect(
      listed
        .find((definition) => definition.id === id)
        ?.versions.map((version) => [version.version, version.name]),
    ).toEqual([
      [1, "Authored"],
      [2, "Authored"],
    ]);

    const board = await withService((s) =>
      s.createBoard({
        repo: RepoSlug.make(`factory-test/${hex(6)}`),
        definitionId: id,
      }),
    );
    expect(board.definitionVersion).toBe(v2.definition.version);
    const view = await withService((s) => s.getBoard(board.id));
    expect(view.definition.initialColumn).toBe("doing");
    expect(view.definition.caps).toEqual({ board: 4 });
    const card = await withService((s) =>
      s.create({ boardId: board.id, title: "authored", actor: "person:lukas" }),
    );
    expect(card.column).toBe("doing");

    // An older version stays pinnable by name.
    const older = await withService((s) =>
      s.createBoard({
        repo: RepoSlug.make(`factory-test/${hex(6)}`),
        definitionId: id,
        definitionVersion: 1,
      }),
    );
    expect(older.definitionVersion).toBe(1);
  });

  /**
   * Mutation: drop the advisory lock — two defines read the same newest version, and one meets the
   * primary key as a storage error.
   */
  it("serialises concurrent defines of one id into consecutive versions", async () => {
    const id = newId();
    const results = await withService((s) =>
      Effect.all(
        Array.from({ length: 4 }, (_, n) =>
          s.defineBoard(input(id, { name: `concurrent ${n}` }), LIBRARY),
        ),
        { concurrency: "unbounded" },
      ),
    );
    expect(results.map((result) => result.outcome)).toEqual([
      "created",
      "created",
      "created",
      "created",
    ]);
    expect(
      results.map((result) => result.definition.version).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4]);
    expect(await versionsOf(id)).toEqual([1, 2, 3, 4]);
  });
});

const LUKAS = "person:lukas";
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
 * Who wrote a version (F7): `defineBoard` records the actor it is given on the row it inserts, and
 * only there — an `unchanged` answer and a dry run write no row and so no author.
 */
describe("TaskService.defineBoard author (F7)", () => {
  const authorColumn = (id: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return (yield* sql<{ version: number; author: string | null }>`
          SELECT version, author FROM board_definitions WHERE id = ${id} ORDER BY version
        `).map((row) => [row.version, row.author] as const);
      }),
    );

  /**
   * Mutation: drop `author` from the INSERT — the column stays NULL. Mutation: read the author from
   * the newest version rather than the one asked for — v1 answers v2's author. Mutation: write `''`
   * for an unattributed version — it would read as an author with no name.
   */
  it("records the actor on the version it writes, reads it back, and lists it", async () => {
    const id = newId();
    const v1 = await withService((s) =>
      s.defineBoard({ ...input(id), actor: "alice" }, LIBRARY),
    );
    expect(v1.definition.author).toBe("alice");
    const v2 = await withService((s) =>
      s.defineBoard({ ...input(id, { name: "two" }), actor: "bob" }, LIBRARY),
    );
    expect(v2.definition.author).toBe("bob");
    const v3 = await withService((s) =>
      s.defineBoard(input(id, { name: "three" }), LIBRARY),
    );
    expect(v3.definition.author).toBeUndefined();
    expect(await authorColumn(id)).toEqual([
      [1, "alice"],
      [2, "bob"],
      [3, null],
    ]);
    expect((await withService((s) => s.getDefinition(id, 1))).author).toBe(
      "alice",
    );
    expect("author" in (await withService((s) => s.getDefinition(id)))).toBe(
      false,
    );
    const listed = await withService((s) => s.listDefinitions);
    expect(
      listed.find((entry) => entry.id === id)?.versions.map((v) => v.author),
    ).toEqual(["alice", "bob", undefined]);
  });

  /**
   * Mutation: attribute an `unchanged` answer by updating the newest row's author — the second
   * caller would take the first's version. Mutation: insert on a dry run.
   */
  it("writes no author for an unchanged answer or a dry run", async () => {
    const id = newId();
    await withService((s) =>
      s.defineBoard({ ...input(id), actor: "alice" }, LIBRARY),
    );
    const before = await allRows();
    const same = await withService((s) =>
      s.defineBoard({ ...input(id), actor: "bob" }, LIBRARY),
    );
    expect([same.outcome, same.definition.author]).toEqual([
      "unchanged",
      "alice",
    ]);
    const dry = await withService((s) =>
      s.defineBoard(
        { ...input(id, { name: "dry" }), actor: "bob", dryRun: true },
        LIBRARY,
      ),
    );
    expect(dry.outcome).toBe("validated");
    expect(dry.definition.author).toBeUndefined();
    expect(await allRows()).toEqual(before);
    expect(await authorColumn(id)).toEqual([[1, "alice"]]);
  });

  it("leaves a seeded version without an author", async () => {
    const seeded = await withService((s) =>
      s.getDefinition(DEFAULT_DEFINITION_ID, 1),
    );
    expect(seeded.author).toBeUndefined();
  });

  /** A refused version writes no row, so there is no author to name for it. */
  it("writes nothing for a refused version", async () => {
    const id = newId();
    await refusal((s) =>
      s.defineBoard(
        { ...input(id, { initialColumn: "nowhere" }), actor: "alice" },
        LIBRARY,
      ),
    );
    expect(await authorColumn(id)).toEqual([]);
  });
});

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

  /**
   * Mutation: drop the still-declared check — a v2 card in `building` with no run, diff or PR is
   * re-pinned into v3's `review`, past `run_completed`, `non_empty_diff` and `pr_link`, though both
   * columns are `working` and the kind check passes it.
   * Mutation: drop the run-actor check — a run upgrades its own card's board.
   */
  it("refuses a mapping that sends a column the target still declares to another, and a run's actor", async () => {
    const boardId = await defaultBoard(2);
    const building = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const service = yield* TaskService;
        const made = yield* service.create({
          boardId,
          title: "building",
          actor: LUKAS,
        });
        // Setup: building's entry needs nothing this case is about.
        yield* sql`
          UPDATE tasks SET "column" = 'building', revision = revision + 1 WHERE id = ${made.id}
        `;
        return yield* service.get(made.id);
      }),
    );
    const before = await snapshot(boardId);
    const same = [
      "intake",
      "specifying",
      "planning",
      "building",
      "review",
      "done",
      "canceled",
    ];
    const identity = Object.fromEntries(same.map((c) => [c, c]));
    const skipped = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 3,
        expectedVersion: 2,
        migrateCards: { ...identity, building: "review" },
        actor: LUKAS,
      }),
    );
    expect(skipped).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "migrateCards.building",
    });
    const gated = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 3,
        expectedVersion: 2,
        migrateCards: { ...identity, planning: "building" },
        actor: LUKAS,
      }),
    );
    expect(gated).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "migrateCards.planning",
    });
    const run = await refusal((s) =>
      s.upgradeBoard({
        boardId,
        toVersion: 3,
        expectedVersion: 2,
        actor: `ses_${"0".repeat(10)}${hex(8)}`,
      }),
    );
    expect(run).toMatchObject({ _tag: "InvalidTaskInput", field: "actor" });
    expect(await snapshot(boardId)).toEqual(before);
    expect((await withService((s) => s.get(building.id))).column).toBe(
      "building",
    );
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
