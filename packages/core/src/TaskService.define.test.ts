/**
 * `TaskService.defineBoard` against the real `board_definitions` table (D4): a new version is a new
 * row and no row that exists is touched (B2), identical content writes nothing, a dry run writes
 * nothing, every refusal writes nothing, and the version written is one `listDefinitions` lists and
 * `createBoard` pins.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Every case defines an id of its
 * own, never `default` — which every other suite's boards pin by default — and the rows go when the
 * file is done.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import { RepoSlug } from "@repo/domain/Session";
import {
  type BoardColumn,
  type DefineBoardInput,
  DefinitionId,
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
          { name: "todo", kind: "terminal", skills: [], requires: [] },
        ],
      },
      "columns[3].name",
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
