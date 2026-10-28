/**
 * The task service against the real `tasks` / `task_events` tables (docs/board.md B3–B5, B7, B9).
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Each case makes its own board
 * instance over the seeded `default` definition, so cases never share a card.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import { BranchName, RepoSlug } from "@repo/domain/Session";
import {
  declaredTransitions,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  humanGate,
  LIST_BOARDS_LIMIT,
  NON_EMPTY_DIFF_REQUIREMENT,
  PR_LINK_REQUIREMENT,
  type AttentionItem,
  VERIFIED_REQUIREMENT,
} from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { noCheckoutWarning } from "./workspace";
import { SessionService, SessionServiceLive } from "./SessionService";
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

/** A fresh repository slug, so no two boards a case makes share one by accident. */
const newRepo = () => RepoSlug.make(`factory-test/${hex(6)}`);

/**
 * A board instance bound to a fresh repository, over the seeded default definition — made by the
 * service's own `createBoard` (LOB-208), so every case below reads a board the way a real one is made.
 */
const newBoard = (version = 1): Promise<string> =>
  withService((s) =>
    s.createBoard({
      repo: newRepo(),
      definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
      definitionVersion: version,
    }),
  ).then((board) => board.id);

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

/**
 * The card placed in `review` from `building` by a direct row write, at the next revision — setup
 * for a case about what happens *after* building's exit. Since LOB-240 that exit needs the latest
 * run's branch to carry a change and its log to record a PR, which such a case is not about; the
 * exit itself is proven, through the service, by the building cases below. No `moved` event is
 * appended, so a case counting events counts the service's own writes only.
 */
const seatInReview = (taskId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        UPDATE tasks SET "column" = 'review', revision = revision + 1, updated_at = now()
        WHERE id = ${taskId} AND "column" = 'building'
        RETURNING id
      `;
      if (rows.length !== 1)
        return yield* Effect.die(
          new Error(`task ${taskId} is not in building`),
        );
      const service = yield* TaskService;
      return yield* service.get(taskId);
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
    // No gate stands on building → review, so a run's move there is judged on the column's
    // requirements, not refused as a gate (the gate is checked first): with no run on the card,
    // `non_empty_diff` is the one it names.
    const ungated = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: building.revision,
        to: "review",
        actor: RUN,
      }),
    );
    expect(ungated).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: "non_empty_diff",
    });
    const review = await seatInReview(task.id);
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
    // created + 4 accepted moves (the seat into review writes none); every refusal added nothing.
    expect(await eventCount(task.id)).toBe(5);
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

describe("TaskService — creating a board (LOB-208)", () => {
  /**
   * A definition of the case's own, with `versions` rows carrying the default pipeline's version-1
   * columns. "The newest version" is only a claim about the code when the case controls which
   * versions exist: the seeded `default` grows a version whenever a migration adds one.
   */
  const newDefinition = (versions: ReadonlyArray<number>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = `def${hex(4)}`;
        for (const version of versions) {
          yield* sql`
            INSERT INTO board_definitions (id, version, name, columns)
            SELECT ${id}, ${version}, ${`Pipeline v${version}`}, columns
            FROM board_definitions WHERE id = 'default' AND version = 1
          `;
        }
        return DefinitionId.make(id);
      }),
    );

  /** How many boards bind `repo`: a refused creation must leave this at zero. */
  const boardsOver = (repo: string): Promise<number> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ n: number }>`
          SELECT count(*)::int AS n FROM board_instances WHERE repo = ${repo}
        `;
        return rows[0]?.n ?? -1;
      }),
    );

  /**
   * Mutation: order the versions ascending, or drop the `ORDER BY` — the first board pins version 1.
   * Mutation: read the newest once and cache it — the board made after version 3 lands pins 2.
   */
  it("pins the definition's newest version by default, and a later version only reaches the next board", async () => {
    const definitionId = await newDefinition([1, 2]);
    const repo = newRepo();
    const first = await withService((s) =>
      s.createBoard({ repo, definitionId }),
    );
    expect(first.definitionId).toBe(definitionId);
    expect(first.definitionVersion).toBe(2);
    expect(first.repo).toBe(repo);
    expect(first.id).toMatch(/^brd_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);

    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          INSERT INTO board_definitions (id, version, name, columns)
          SELECT ${definitionId}, 3, 'Pipeline v3', columns
          FROM board_definitions WHERE id = ${definitionId} AND version = 2
        `;
      }),
    );
    const second = await withService((s) =>
      s.createBoard({ repo: newRepo(), definitionId }),
    );
    // Each board stays on the version it was made under (B2).
    expect(second.id).not.toBe(first.id);
    expect(second.definitionVersion).toBe(3);
    const reread = await withService((s) => s.getBoard(first.id));
    expect(reread.instance.definitionVersion).toBe(2);
    expect(reread.definition.name).toBe("Pipeline v2");
  });

  /**
   * The acceptance case: a board no SQL wrote is the one `create`, `getBoard` and `listBoards` read.
   * Mutation: insert the instance with the definition's oldest version instead of the one named —
   * the card pins 1, not 2.
   */
  it("makes a board that getBoard, listBoards and create read back, over the version named", async () => {
    const board = await withService((s) =>
      s.createBoard({
        repo: newRepo(),
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        definitionVersion: 2,
      }),
    );
    const view = await withService((s) => s.getBoard(board.id));
    // The instance is the board's own columns; `warning` (LOB-263) is the repository's, so it is
    // answered beside the instance, not inside it, and a fresh repo with no checkout has one.
    const { warning: _warning, ...instance } = board;
    expect(view.instance).toEqual(instance);
    expect(view.definition.version).toBe(2);
    expect(view.definition.columns.map((column) => column.name)).toContain(
      "specifying",
    );

    const listed = await withService((s) => s.listBoards);
    expect(listed.find((row) => row.id === board.id)).toEqual(instance);

    const card = await withService((s) =>
      s.create({ boardId: board.id, title: "on a made board", actor: LUKAS }),
    );
    expect(card.boardId).toBe(board.id);
    expect(card.definitionVersion).toBe(2);
    expect(card.column).toBe("intake");
  });

  /**
   * LOB-263, the rule pinned for boards: a board over a repository with no `local_path` is still
   * made — a repository is registered on first use, so refusing would fail every board for a slug
   * nobody registered yet — but the answer carries a `warning` naming the repo and the command that
   * fixes it, and `getBoard` carries it until the repo has a path.
   * Mutation: drop the warning from `createBoard`, or from `getBoard` — the matching expectation fails.
   * Mutation: warn only for a slug with no `repos` row — the row with a NULL path below has none.
   * Mutation: warn whatever the path says — the checked-out repo below has one.
   */
  it("makes a board over a repo with no local checkout and says so, until the repo has a path", async () => {
    const definitionId = DefinitionId.make(DEFAULT_DEFINITION_ID);
    const setRepo = (slug: string, localPath: string | null) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO repos (slug, url, default_base_ref, local_path)
            VALUES (${slug}, '', 'main', ${localPath})
            ON CONFLICT (slug) DO UPDATE SET local_path = EXCLUDED.local_path
          `;
        }),
      );

    // Never registered: no row at all.
    const unregistered = newRepo();
    const bare = await withService((s) =>
      s.createBoard({ repo: unregistered, definitionId }),
    );
    expect(bare.warning).toBe(noCheckoutWarning(unregistered));
    expect(bare.warning).toContain(
      `factory repo add ${unregistered} --path <dir>`,
    );
    expect(await boardsOver(unregistered)).toBe(1);

    // Auto-registered by a session that named it: a row whose path is NULL.
    const pathless = newRepo();
    await setRepo(pathless, null);
    const made = await withService((s) =>
      s.createBoard({ repo: pathless, definitionId }),
    );
    expect(made.warning).toBe(noCheckoutWarning(pathless));
    expect((await withService((s) => s.getBoard(made.id))).warning).toBe(
      noCheckoutWarning(pathless),
    );

    // The fix clears it: the next read of the same board says nothing.
    await setRepo(pathless, "/srv/checkouts/pathless");
    expect(
      (await withService((s) => s.getBoard(made.id))).warning,
    ).toBeUndefined();

    // A repo registered with a path makes its board with no warning at all.
    const ready = newRepo();
    await setRepo(ready, "/srv/checkouts/ready");
    const clean = await withService((s) =>
      s.createBoard({ repo: ready, definitionId }),
    );
    expect(clean.warning).toBeUndefined();
    expect("warning" in clean).toBe(false);
  });

  /**
   * One board per repository (docs/board.md, deferred item 8): a repeated `factory board create` or a
   * retried RPC call is refused, naming the board the repository already has, and adds no row.
   * Mutation: drop the existence check — the second call makes a second board and resolves.
   */
  it("refuses a second board over a repository, naming the one it has, and makes no other", async () => {
    const repo = newRepo();
    const definitionId = DefinitionId.make(DEFAULT_DEFINITION_ID);
    const first = await withService((s) =>
      s.createBoard({ repo, definitionId }),
    );
    const err = await refusal((s) =>
      s.createBoard({ repo, definitionId, definitionVersion: 1 }),
    );
    expect(err._tag).toBe("BoardExists");
    if (err._tag !== "BoardExists") throw new Error("unreachable");
    expect(err.repo).toBe(repo);
    expect(err.boardId).toBe(first.id);
    expect(err.message).toBe(
      `repository ${repo} already has board ${first.id}`,
    );
    expect(await boardsOver(repo)).toBe(1);
  });

  /**
   * Creates racing for one repository: exactly one board lands and every other is `BoardExists`.
   * Eight, not two, so the race is wide enough to show. Mutation: drop the advisory lock — several
   * transactions see no board under READ COMMITTED and insert, so the repository ends with more.
   */
  it("lets exactly one of several concurrent creates for a repository through", async () => {
    const repo = newRepo();
    const definitionId = DefinitionId.make(DEFAULT_DEFINITION_ID);
    const outcomes = await withService((s) =>
      Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.result(s.createBoard({ repo, definitionId })),
        ),
        { concurrency: "unbounded" },
      ),
    );
    const made = outcomes.filter((outcome) => outcome._tag === "Success");
    const refused = outcomes.filter(
      (outcome) =>
        outcome._tag === "Failure" && outcome.failure._tag === "BoardExists",
    );
    expect(made).toHaveLength(1);
    expect(refused).toHaveLength(7);
    expect(await boardsOver(repo)).toBe(1);
  });

  it("refuses a definition the factory does not hold, naming it, and makes no board", async () => {
    const repo = newRepo();
    const definitionId = DefinitionId.make(`missing${hex(4)}`);
    const err = await refusal((s) => s.createBoard({ repo, definitionId }));
    expect(err._tag).toBe("DefinitionNotFound");
    if (err._tag !== "DefinitionNotFound") throw new Error("unreachable");
    expect(err.definitionId).toBe(definitionId);
    expect(err.version).toBeUndefined();
    expect(err.message).toBe(`no board definition ${definitionId}`);
    expect(await boardsOver(repo)).toBe(0);
  });

  /** Mutation: fall back to the newest when the named version is missing — this case gets a board. */
  it("refuses a version the definition does not have, naming both, and makes no board", async () => {
    const definitionId = await newDefinition([1]);
    const repo = newRepo();
    const err = await refusal((s) =>
      s.createBoard({ repo, definitionId, definitionVersion: 2 }),
    );
    expect(err._tag).toBe("DefinitionNotFound");
    if (err._tag !== "DefinitionNotFound") throw new Error("unreachable");
    expect(err.definitionId).toBe(definitionId);
    expect(err.version).toBe(2);
    expect(err.message).toBe(
      `board definition ${definitionId} has no version 2`,
    );
    expect(await boardsOver(repo)).toBe(0);
  });
});

/**
 * Reading definitions (LOB-270): which exist, and one version's columns. The database is shared with
 * every other case (and every other run), so the cases make a definition of their own wherever "every
 * version" or "the newest" has to be a claim the case controls, and read `default` against the rows
 * themselves.
 */
describe("TaskService — reading definitions (LOB-270)", () => {
  /**
   * Every id this run made. The database outlives the run and `factory board definitions` lists
   * every row it holds, so the rows go when the cases are done (no board pins them).
   */
  const madeIds: Array<string> = [];
  afterAll(() =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        if (madeIds.length === 0) return;
        yield* sql`DELETE FROM board_definitions WHERE id IN ${sql.in(madeIds)}`;
      }),
    ),
  );

  /** A definition of the case's own, one row per version, each with the default v1 columns. */
  const newDefinition = (versions: ReadonlyArray<number>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = `lst${hex(4)}`;
        madeIds.push(id);
        for (const version of versions) {
          yield* sql`
            INSERT INTO board_definitions (id, version, name, columns)
            SELECT ${id}, ${version}, ${`Listed v${version}`}, columns
            FROM board_definitions WHERE id = 'default' AND version = 1
          `;
        }
        return DefinitionId.make(id);
      }),
    );

  /** The default definition's versions straight from the rows: the oracle the list is read against. */
  const defaultVersions = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ version: number }>`
          SELECT version FROM board_definitions WHERE id = 'default' ORDER BY version
        `;
        return rows.map((row) => row.version);
      }),
    );

  /**
   * Mutation: group by name instead of id, or keep only each id's first row — the definition made
   * here does not list `[1, 2, 3]`. Mutation: order by version descending — its versions read newest
   * first.
   */
  it("lists every definition once, ordered by id, with each version oldest first", async () => {
    const made = await newDefinition([2, 1, 3]);
    const listed = await withService((s) => s.listDefinitions);

    const ids = listed.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());

    const mine = listed.find((definition) => definition.id === made);
    expect(mine?.versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(mine?.versions.map((version) => version.name)).toEqual([
      "Listed v1",
      "Listed v2",
      "Listed v3",
    ]);

    // The seeded pipeline: v1–v3 at least, and every version a later migration adds.
    const seeded = listed.find(
      (definition) => definition.id === DEFAULT_DEFINITION_ID,
    );
    const versions = seeded?.versions.map((version) => version.version);
    expect(versions?.slice(0, 3)).toEqual([1, 2, 3]);
    expect(versions).toEqual(await defaultVersions());
  });

  /** Mutation: drop the `ORDER BY version DESC` — the definition made with [1, 3, 2] answers 1. */
  it("reads the version named, and the newest when none is", async () => {
    const made = await newDefinition([1, 3, 2]);
    const newest = await withService((s) => s.getDefinition(made));
    expect(newest.id).toBe(made);
    expect(newest.version).toBe(3);
    expect(newest.name).toBe("Listed v3");
    expect(newest.columns.map((column) => column.name)).toEqual([
      "intake",
      "specifying",
      "planning",
      "building",
      "review",
      "done",
      "canceled",
    ]);

    const named = await withService((s) => s.getDefinition(made, 2));
    expect(named.version).toBe(2);
    expect(named.name).toBe("Listed v2");

    const v3 = await withService((s) =>
      s.getDefinition(DEFAULT_DEFINITION_ID, 3),
    );
    expect(
      v3.columns
        .find((column) => column.name === "review")
        ?.requires.map((requirement) => requirement.key),
    ).toContain(VERIFIED_REQUIREMENT);
  });

  /**
   * A row whose id is outside `DefinitionId` (the table does not check it) is a storage fault that
   * names the row. Written and read inside one rolled-back transaction, so no other case or suite
   * sharing the database ever lists it. Mutation: decode the list as one array — the message no
   * longer names the id.
   */
  it("fails the list as a storage fault naming a row whose id does not decode", async () => {
    const bad = `Bad Id ${hex(4)}`;
    const failure = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const service = yield* TaskService;
        const rollback = new Error("rollback");
        let seen: TaskError | undefined;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO board_definitions (id, version, name, columns)
                SELECT ${bad}, 1, 'Bad', columns
                FROM board_definitions WHERE id = 'default' AND version = 1
              `;
              seen = yield* service.listDefinitions.pipe(
                Effect.match({
                  onFailure: (error): TaskError | undefined => error,
                  onSuccess: () => undefined,
                }),
              );
              return yield* Effect.die(rollback);
            }),
          )
          .pipe(
            Effect.catchDefect((defect) =>
              defect === rollback ? Effect.void : Effect.die(defect),
            ),
          );
        return seen;
      }),
    );
    expect(failure?._tag).toBe("TaskStorageError");
    expect(failure?.message).toContain(
      `board definition ${JSON.stringify(bad)} does not decode`,
    );
    // Rolled back: the row is not there for anyone else.
    const listed = await withService((s) => s.listDefinitions);
    expect(listed.map((definition) => definition.id)).not.toContain(bad);
  });

  /** The refusal is `createBoard`'s, in the same words. */
  it("refuses an unknown id, and a version the definition lacks, as DefinitionNotFound", async () => {
    const missing = `missing${hex(4)}`;
    const unknown = await refusal((s) => s.getDefinition(missing));
    expect(unknown._tag).toBe("DefinitionNotFound");
    if (unknown._tag !== "DefinitionNotFound") throw new Error("unreachable");
    expect(unknown.definitionId).toBe(missing);
    expect(unknown.version).toBeUndefined();
    expect(unknown.message).toBe(`no board definition ${missing}`);

    const made = await newDefinition([1]);
    const noVersion = await refusal((s) => s.getDefinition(made, 2));
    expect(noVersion._tag).toBe("DefinitionNotFound");
    if (noVersion._tag !== "DefinitionNotFound") throw new Error("unreachable");
    expect(noVersion.version).toBe(2);
    expect(noVersion.message).toBe(`board definition ${made} has no version 2`);
  });
});

/**
 * A card's repository is its board's (B2, LOB-255): the default when `create` names none, the only
 * one it may name, and the one every run on the card is bound to — so a card made the way a trigger
 * or a person makes one gets runs with a branch, rather than scratch runs that can never leave
 * building.
 */
describe("TaskService — a card's repository (LOB-255)", () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), "factory-task-repo-"));

  /** A board over a fresh repository. */
  const boardOver = () =>
    withService((s) =>
      s.createBoard({
        repo: newRepo(),
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
      }),
    );

  /**
   * How many cards the board holds, and how many events they have: a refused create must leave both
   * at zero (an event row needs its card, so a stray event would show as a stray card too).
   */
  const writtenOn = (boardId: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ cards: number; events: number }>`
          SELECT
            (SELECT count(*)::int FROM tasks WHERE board_id = ${boardId}) AS cards,
            (SELECT count(*)::int FROM task_events e JOIN tasks t ON t.id = e.task_id
             WHERE t.board_id = ${boardId}) AS events
        `;
        return rows[0];
      }),
    );

  /** Mutation: store `input.repo ?? null` again — the card has no repo, here and read back. */
  it("gives a card created with no repo its board's repository, and reads it back", async () => {
    const board = await boardOver();
    const task = await withService((s) =>
      s.create({ boardId: board.id, title: "no repo named", actor: LUKAS }),
    );
    expect(task.repo).toBe(board.repo);
    expect((await withService((s) => s.get(task.id))).repo).toBe(board.repo);
    const listed = await withService((s) => s.list({ boardId: board.id }));
    expect(listed.map((card) => card.repo)).toEqual([board.repo]);

    // Naming the board's own repository makes the same card.
    const named = await withService((s) =>
      s.create({
        boardId: board.id,
        title: "the board's repo named",
        repo: board.repo,
        actor: LUKAS,
      }),
    );
    expect(named.repo).toBe(board.repo);
  });

  /** Mutation: drop the comparison — the card is written over the other repository and resolves. */
  it("refuses a card naming another repository, naming both, and writes nothing", async () => {
    const board = await boardOver();
    const other = newRepo();
    const err = await refusal((s) =>
      s.create({
        boardId: board.id,
        title: "elsewhere",
        repo: other,
        actor: LUKAS,
      }),
    );
    expect(err._tag).toBe("BoardRepoMismatch");
    if (err._tag !== "BoardRepoMismatch") throw new Error("unreachable");
    expect(err.boardId).toBe(board.id);
    expect(err.boardRepo).toBe(board.repo);
    expect(err.repo).toBe(other);
    expect(err.message).toBe(
      `board ${board.id} is over ${board.repo}, so a card on it cannot name ${other}`,
    );
    expect(await writtenOn(board.id)).toEqual({ cards: 0, events: 0 });
  });

  /**
   * A run started from the card the way both run starters start one — `factory board start` and the
   * card pane pass the card's repo — one started by a client that names none, and one for a card
   * made before cards carried a repo: each is bound to the board's repository, on `factory/<id>`, in
   * a worktree linked into the repository's registered checkout.
   *
   * Mutation: drop `cardRepoFor` — the run with no repo named is a scratch session with no branch.
   * Mutation: read `t.repo` alone — the legacy card's run is a scratch session.
   */
  it("binds every run on the card to the board's repository, in a factory/<session-id> worktree", async () => {
    const board = await boardOver();
    const checkout = mkdtempSync(join(tmpdir(), "factory-task-repo-checkout-"));
    const git = (command: string, cwd = checkout) =>
      execSync(command, { cwd, encoding: "utf8" }).trim();
    git("git init -q -b main");
    git("git config user.email repo@localhost");
    git("git config user.name repo");
    writeFileSync(join(checkout, "README.md"), "# fixture\n");
    git("git add -A");
    git("git commit -q -m base");

    const card = await withService((s) =>
      s.create({ boardId: board.id, title: "runs", actor: LUKAS }),
    );
    const legacy = await withService((s) =>
      s.create({ boardId: board.id, title: "legacy", actor: LUKAS }),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`UPDATE tasks SET repo = NULL WHERE id = ${legacy.id}`;
      }),
    );
    // The card reads back with its board's repository, the one its runs are bound to below.
    expect((await withService((s) => s.get(legacy.id))).repo).toBe(board.repo);
    expect(
      (await withService((s) => s.list({ boardId: board.id }))).find(
        (task) => task.id === legacy.id,
      )?.repo,
    ).toBe(board.repo);

    const sessions = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({}).access,
        sessionRoot,
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    const runs = await sessions
      .runPromise(
        Effect.gen(function* () {
          const service = yield* SessionService;
          yield* service.registerRepo({
            repo: board.repo,
            url: "https://example.invalid/repo.git",
            localPath: checkout,
          });
          const started = [
            // What `factory board start --task` and the card pane send: the card's own repo.
            yield* service.create({
              title: card.title,
              taskId: card.id,
              taskColumn: card.column,
              ...(card.repo === undefined ? {} : { repo: card.repo }),
            }),
            // A client that names no repo for the card's run.
            yield* service.create({ taskId: card.id, taskColumn: "building" }),
            // A card from before LOB-255, whose row has no repo.
            yield* service.create({
              taskId: legacy.id,
              taskColumn: "building",
            }),
          ];
          return yield* Effect.forEach(started, (summary) =>
            service.get(summary.id),
          );
        }),
      )
      .finally(() => sessions.dispose());

    expect(card.repo).toBe(board.repo);
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      const id = run.session.id;
      expect(run.session.repo).toBe(board.repo);
      expect(run.workspace.repo).toBe(board.repo);
      expect(run.workspace.branch).toBe(`factory/${id}`);
      expect(run.workspace.path).toBe(
        join(sessionRoot, ...board.repo.split("/"), id),
      );
      // The worktree is real: git in it answers the run's own branch, linked into the checkout.
      expect(git("git rev-parse --abbrev-ref HEAD", run.workspace.path)).toBe(
        `factory/${id}`,
      );
      expect(git("git worktree list --porcelain")).toContain(
        `branch refs/heads/factory/${id}`,
      );
    }
  }, 60_000);
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

describe("TaskService — the card's spec (LOB-238)", () => {
  const SPEC = {
    goal: "Pin the card's Postgres major",
    acceptance: ["the compose file names one major"],
    gaps: ["which major the card targets"],
    openQuestions: ["Which Postgres major?"],
  } as const;

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

  it("reads no spec for a card no run has specified, and refuses a card that does not exist", async () => {
    const task = await inSpecifying();
    expect(await withService((s) => s.spec(task.id))).toBeUndefined();
    const missing = await refusal((s) => s.spec(`tsk_${hex(13)}`));
    expect(missing._tag).toBe("TaskNotFound");
    const posted = await refusal((s) =>
      s.declareSpec({ taskId: `tsk_${hex(13)}`, actor: RUN, ...SPEC }),
    );
    expect(posted._tag).toBe("TaskNotFound");
  });

  it("records a run's spec as one specified event, a revision on, and reads it back", async () => {
    const task = await inSpecifying();
    const specified = await withService((s) =>
      s.declareSpec({ taskId: task.id, actor: RUN, ...SPEC }),
    );
    expect(specified.revision).toBe(task.revision + 1);
    expect(specified.blocked).toBeUndefined();
    expect(await eventCount(task.id)).toBe(3);
    const spec = await withService((s) => s.spec(task.id));
    expect(spec).toEqual({
      taskId: task.id,
      sessionId: RUN,
      column: "specifying",
      ...SPEC,
      revision: task.revision,
      createdAt: spec?.createdAt,
    });
    // A spec is the card's record, not a comment: the thread the next run is told stays as it was.
    expect(await withService((s) => s.comments(task.id))).toEqual([]);
  });

  it("answers the newest spec, keeps an empty list empty, and leaves a parked card parked", async () => {
    const task = await inSpecifying();
    await withService((s) =>
      s.declareSpec({ taskId: task.id, actor: RUN, ...SPEC }),
    );
    const asked = await withService((s) =>
      s.ask({ taskId: task.id, question: "Which major?", actor: RUN }),
    );
    const closed = await withService((s) =>
      s.declareSpec({
        taskId: task.id,
        actor: RUN,
        ...SPEC,
        gaps: [],
        openQuestions: [],
      }),
    );
    // A spec is not an answer: only a person's comment lifts the block.
    expect(closed.blocked?.reason).toBe("needs_input");
    expect(closed.revision).toBe(asked.revision + 1);
    const spec = await withService((s) => s.spec(task.id));
    expect(spec?.gaps).toEqual([]);
    expect(spec?.openQuestions).toEqual([]);
    expect(spec?.revision).toBe(asked.revision);
  });

  it("records the declaring run's column, not the column the card was moved on to", async () => {
    const task = await inSpecifying();
    const planned = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "planning",
        actor: LUKAS,
      }),
    );
    await withService((s) =>
      s.declareSpec({
        taskId: task.id,
        actor: RUN,
        column: "specifying",
        ...SPEC,
      }),
    );
    const spec = await withService((s) => s.spec(task.id));
    expect(spec?.column).toBe("specifying");
    expect(spec?.revision).toBe(planned.revision);
  });

  it("records a spec once per spec id, so a replayed tool call posts nothing twice", async () => {
    const task = await inSpecifying();
    const post = { taskId: task.id, actor: RUN, ...SPEC };
    const first = await withService((s) =>
      s.declareSpec({ ...post, specId: `${RUN}:call-1` }),
    );
    const replayed = await withService((s) =>
      s.declareSpec({ ...post, specId: `${RUN}:call-1` }),
    );
    expect(replayed.revision).toBe(first.revision);
    expect(await eventCount(task.id)).toBe(3);
    const second = await withService((s) =>
      s.declareSpec({ ...post, gaps: [], specId: `${RUN}:call-2` }),
    );
    expect(second.revision).toBe(first.revision + 1);
    expect((await withService((s) => s.spec(task.id)))?.gaps).toEqual([]);
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
      // `building`'s exit needs a branch and a PR (LOB-240), which these cases are not about.
      task =
        to === "review"
          ? await seatInReview(at.id)
          : await withService((s) =>
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
    /** Sessions no card owns (no `task_runs` row), each seeded with the approvals named above. */
    readonly scratch?: ReadonlyArray<{
      readonly sessionId: string;
      readonly title?: string;
      readonly repo?: string;
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
              for (const scratch of seed.scratch ?? []) {
                yield* sql`
                  INSERT INTO sessions (id, title, repo)
                  VALUES (${scratch.sessionId}, ${scratch.title ?? ""}, ${scratch.repo ?? null})
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
      readonly task?: { readonly title: string } | undefined;
      readonly reason: { readonly _tag: string };
    }>,
  ) => items.map((item) => [item.reason._tag, item.task?.title]);

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
    const listed = new Set((onBoard ?? []).map((item) => item.task?.id));
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
      (onBoard ?? []).filter((item) => item.task?.id === planAsks.id),
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
        (item) =>
          item.task?.boardId === boardId && (item.repo?.length ?? 0) > 0,
      ),
    ).toBe(true);

    // Every board: this board's rows are all there, in the same order.
    expect(
      rows((everywhere ?? []).filter((item) => item.task?.boardId === boardId)),
    ).toEqual(rows(onBoard ?? []));
    // A board where nothing needs a person answers an empty list, not an error.
    expect(clean).toEqual([]);
  });

  it("lists a pending approval of a session no card owns, on the every-board read only (LOB-271)", async () => {
    const boardId = await newBoard();
    const card = await cardIn(boardId, "card approval", ["specifying"]);
    const cardRun = newSession();
    const titled = newSession();
    const bare = newSession();
    const settled = newSession();
    const [onBoard, everywhere] = await attentionWith(
      {
        runs: [
          {
            taskId: card.id,
            column: "specifying",
            status: "idle",
            ago: 5,
            sessionId: cardRun,
          },
        ],
        scratch: [
          { sessionId: titled, title: "fix the flaky test", repo: "acme/api" },
          { sessionId: bare },
          { sessionId: settled, title: "already decided" },
        ],
        approvals: [
          {
            sessionId: titled,
            requestId: "push",
            action: "git push",
            ago: 100,
          },
          {
            sessionId: cardRun,
            requestId: "card-push",
            action: "git push origin card",
            ago: 70,
          },
          { sessionId: bare, requestId: "pr", action: "open a PR", ago: 40 },
          {
            sessionId: settled,
            requestId: "old",
            action: "git push -f",
            ago: 90,
            decided: true,
          },
        ],
      },
      [boardId, undefined],
    );

    // This database is shared with other suites, so read only the rows this case seeded.
    const mine = new Set([cardRun, titled, bare, settled]);
    const seeded = (everywhere ?? []).filter(
      (item) =>
        item.reason._tag === "approval" && mine.has(item.reason.sessionId),
    );
    // One list, oldest request first: the card-less sessions interleave with the card's approval,
    // and the session whose only request was decided is not there.
    expect(
      seeded.map((item) =>
        item.reason._tag === "approval" ? item.reason.sessionId : undefined,
      ),
    ).toEqual([titled, cardRun, bare]);
    expect(seeded.map((item) => item.task?.title)).toEqual([
      undefined,
      "card approval",
      undefined,
    ]);

    const [scratchTitled, cardBound, scratchBare] = seeded;
    expect(scratchTitled).toMatchObject({
      sessionTitle: "fix the flaky test",
      repo: "acme/api",
      reason: {
        _tag: "approval",
        sessionId: titled,
        requestId: "push",
        action: "git push",
      },
    });
    expect(scratchTitled).not.toHaveProperty("task");
    // No title and no repo: the row says so by omission, not with a made-up value.
    expect(scratchBare).toMatchObject({ sessionTitle: "" });
    expect(scratchBare).not.toHaveProperty("repo");
    // A card's approval is the row it always was: the card, its board's repo, and no session title.
    expect(cardBound?.task?.id).toBe(card.id);
    expect(cardBound?.repo?.length).toBeGreaterThan(0);
    expect(cardBound).not.toHaveProperty("sessionTitle");

    // A board's own view lists the board's cards only: the card's approval, nothing from scratch.
    expect(rows(onBoard ?? [])).toEqual([["approval", "card approval"]]);
  });

  it("orders approvals by the request time the database keeps, below the millisecond (LOB-271)", async () => {
    const boardId = await newBoard();
    const card = await cardIn(boardId, "micro order", ["specifying"]);
    const ids = [newSession(), newSession()].sort();
    const low = `${ids[0]}`;
    const high = `${ids[1]}`;
    const scratch = newSession();
    // The older request belongs to the session id that sorts last, 400 microseconds apart: a re-sort
    // on the millisecond `requestedAt` and the session id would put the other one first.
    const [everywhere] = await attentionWith(
      {
        runs: [low, high].map((sessionId) => ({
          taskId: card.id,
          column: "specifying" as const,
          status: "idle" as const,
          ago: 5,
          sessionId,
        })),
        scratch: [{ sessionId: scratch }],
        approvals: [
          { sessionId: high, requestId: "a", action: "one", ago: 10.0008 },
          { sessionId: low, requestId: "a", action: "two", ago: 10.0004 },
          { sessionId: scratch, requestId: "a", action: "three", ago: 10.0006 },
        ],
      },
      [undefined],
    );
    const mine = new Set([low, high, scratch]);
    expect(
      (everywhere ?? [])
        .filter(
          (item) =>
            item.reason._tag === "approval" && mine.has(item.reason.sessionId),
        )
        .map((item) =>
          item.reason._tag === "approval" ? item.reason.sessionId : undefined,
        ),
    ).toEqual([high, scratch, low]);
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
      (item) => item.task?.id === other.id,
    );
    expect(bare?.reason).toMatchObject({ _tag: "question" });
    expect(bare?.reason).not.toHaveProperty("question");

    const missing = await refusal((s) => s.attention(`brd_${hex(13)}`));
    expect(missing._tag).toBe("BoardNotFound");
  });
});

/**
 * A column's exit requirements against what the card's runs recorded (LOB-80; docs/board.md B5, B8).
 *
 * The evidence is real: each run is a session opened through `SessionService` with the card named —
 * the path `factory board start` takes, so its `task_runs` row and its log are production writes —
 * in a worktree of a fixture repo, and the faux model makes a change and calls the `verify` tool,
 * which runs the fixture's skill. What `TaskService.move` reads back is that log, in Postgres.
 */
describe("TaskService — exit requirements", () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), "factory-task-requires-"));

  /** A fixture checkout with `files` committed on `main`; a run's worktree is cut from it. */
  const fixtureRepo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "factory-task-requires-repo-"));
    const git = (command: string) =>
      execSync(command, { cwd: root, stdio: "ignore" });
    git("git init -q -b main");
    git("git config user.email requires@localhost");
    git("git config user.name requires");
    writeFileSync(join(root, "README.md"), "# fixture\n");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("git add -A");
    git("git commit -q -m base");
    return root;
  };

  /** The run's change: one new file, left in the worktree for `verify` to measure. */
  const change = (path: string) =>
    `mkdir -p ${dirname(path)} && echo 'export const changed = 1;' > ${path} && echo changed`;

  /** A change committed on the run's own branch: what `non_empty_diff` measures (LOB-240). */
  const commit = (path: string) =>
    `${change(path)} && git add -A && git commit -q -m change`;

  /**
   * GitHub's PR endpoint behind an `HttpClient.make` fake (docs/testing-third-parties.md, GitHub
   * row): every POST answers PR 7, so the PR step commits its `factory.pr` document with no network.
   */
  const githubFake = Layer.merge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                number: 7,
                url: "https://api.github.com/repos/factory-test/requires/pulls/7",
                html_url: "https://github.com/factory-test/requires/pull/7",
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    ),
    Layer.succeed(
      CredentialProvider,
      staticTokenProvider(Option.some(Redacted.make("tok"))),
    ),
  );

  /**
   * One run of `taskId`, started from `column` (`review` unless named): the faux model runs
   * `command` in the run's worktree, calls `verify`, and answers. With `openPr` the run's PR is then
   * opened through the PR step against the GitHub fake, which records it in the run's log. Resolves
   * once the answer (and the PR) is in, with the run's session id.
   */
  const recordRun = async (input: {
    readonly taskId: string;
    readonly repoRoot: string;
    readonly command: string;
    readonly column?: string;
    readonly openPr?: boolean;
    /** The repository's registered `local_path`, when it is not `repoRoot` itself. */
    readonly localPath?: string;
  }): Promise<string> => {
    const faux = createFauxModelAccess({
      fauxVerify: true,
      fauxCommand: input.command,
    });
    const sessions = ManagedRuntime.make(
      SessionServiceLive({ model: faux.access, sessionRoot }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    const repo = RepoSlug.make(`factory-test/requires-${hex(4)}`);
    try {
      return await sessions.runPromise(
        Effect.gen(function* () {
          const service = yield* SessionService;
          yield* service.registerRepo({
            repo,
            url: "https://example.invalid/requires.git",
            localPath: input.localPath ?? input.repoRoot,
          });
          const created = yield* service.create({
            repo,
            baseRef: "main",
            taskId: input.taskId,
            taskColumn: input.column ?? "review",
          });
          yield* service.send({
            sessionId: created.id,
            content: "make the change and verify it",
          });
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const snapshot = yield* service.get(created.id);
            if (
              snapshot.session.status === "idle" &&
              snapshot.entries.some(
                (entry) => entry.kind === "assistant" && entry.text !== "",
              )
            ) {
              if (input.openPr === true) {
                const answer = yield* service
                  .openPullRequest({
                    sessionId: created.id,
                    title: "factory: requires",
                  })
                  .pipe(Effect.provide(githubFake), Effect.orDie);
                if (answer.outcome !== "opened")
                  return yield* Effect.die(
                    new Error(
                      `run ${created.id} opened no PR: ${answer.outcome}`,
                    ),
                  );
              }
              return created.id;
            }
            yield* Effect.sleep(50);
          }
          return yield* Effect.die(
            new Error(`run ${created.id} did not verify and answer`),
          );
        }),
      );
    } finally {
      await sessions.dispose();
    }
  };

  /** A card on a board over `version`, walked by a person from intake into review. */
  const inReview = (version: number) =>
    newBoard(version)
      .then((boardId) =>
        withService((s) =>
          Effect.gen(function* () {
            let task = yield* s.create({
              boardId,
              title: "requires",
              actor: LUKAS,
            });
            for (const to of ["specifying", "planning", "building"]) {
              task = yield* s.move({
                taskId: task.id,
                expectedRevision: task.revision,
                to,
                actor: LUKAS,
              });
            }
            return task;
          }),
        ),
      )
      .then((task) => seatInReview(task.id));

  const PASSING = 'echo "fixture: all checks passed"\n';

  it("seeds version 3 of the default pipeline with verified first in review's requires", async () => {
    const boardId = await newBoard(3);
    const board = await withService((s) => s.getBoard(boardId));
    const review = board.definition.columns.find((c) => c.name === "review");
    expect(review?.requires.map((r) => r.key)).toEqual([
      VERIFIED_REQUIREMENT,
      "review_verdict",
      "human_merge",
    ]);
    // Every other column is version 2's, unchanged (0018 reads it back rather than copying it).
    const v2 = await withService((s) =>
      Effect.flatMap(
        Effect.promise(() => newBoard(2)),
        (id) => s.getBoard(id),
      ),
    );
    expect(
      board.definition.columns.map((c) =>
        c.name === "review" ? { ...c, requires: c.requires.slice(1) } : c,
      ),
    ).toEqual(v2.definition.columns);
  });

  it("refuses a review exit with no recorded evidence, naming the requirement, and writes nothing", async () => {
    const task = await inReview(3);
    const events = await eventCount(task.id);
    const err = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(err._tag).toBe("RequirementUnmet");
    expect(err).toMatchObject({
      taskId: task.id,
      column: "review",
      to: "done",
      requirement: VERIFIED_REQUIREMENT,
    });
    expect(err.message).toBe(
      'the move review → done needs "verified" (a passing verification of every surface the card\'s change touched), which is not met: the card has no runs, so nothing verified its change',
    );
    const after = await withService((s) => s.get(task.id));
    expect(after.column).toBe("review");
    expect(after.revision).toBe(task.revision);
    expect(await eventCount(task.id)).toBe(events);
    // Abandoning the card is never gated on evidence.
    const canceled = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "canceled",
        actor: LUKAS,
      }),
    );
    expect(canceled.column).toBe("canceled");
  });

  it("checks the human gate before the requirements: a run's review → done is HumanGateRequired", async () => {
    // The order is declared transition, then human gate, then requirements. Run on a version 3 card
    // with no evidence, the move fails both checks; the gate has to be the one it names.
    const task = await inReview(3);
    const err = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: RUN,
      }),
    );
    expect(err._tag).toBe("HumanGateRequired");
    // And the declared transition before both: review declares no move into intake.
    const undeclared = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "intake",
        actor: RUN,
      }),
    );
    expect(undeclared._tag).toBe("UndeclaredTransition");
  });

  it("judges the evidence only at the expected revision: a stale move is StaleRevision, not RequirementUnmet", async () => {
    // A move read at an old revision is refused as stale before any evidence is read, so a
    // judgement can only ever describe the card the transaction then locks at that revision.
    const task = await inReview(3);
    for (const expectedRevision of [task.revision - 1, task.revision + 1]) {
      const err = await refusal((s) =>
        s.move({ taskId: task.id, expectedRevision, to: "done", actor: LUKAS }),
      );
      expect(err).toMatchObject({
        _tag: "StaleRevision",
        expected: expectedRevision,
        actual: task.revision,
      });
    }
    // At the revision the card is at, the same move is judged, and refused on the requirement.
    const unmet = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(unmet._tag).toBe("RequirementUnmet");
  });

  it("lets the same exit through once a run of the card verified the surface it changed", async () => {
    const task = await inReview(3);
    const repoRoot = fixtureRepo({ ".pi/skills/verify-api/drive.sh": PASSING });
    const refused = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(refused._tag).toBe("RequirementUnmet");
    await recordRun({
      taskId: task.id,
      repoRoot,
      command: change("apps/api/src/feature.ts"),
    });
    const done = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(done.column).toBe("done");
    expect(done.revision).toBe(task.revision + 1);
  }, 120_000);

  it("is not satisfied by evidence from a different surface than the change touched", async () => {
    const task = await inReview(3);
    // The fixture can verify `web` and nothing else.
    const repoRoot = fixtureRepo({ ".pi/skills/verify-web/drive.sh": PASSING });
    const webRun = await recordRun({
      taskId: task.id,
      repoRoot,
      command: change("apps/web/src/page.ts"),
    });
    // The control: the same `web` run on a card of its own is evidence that meets the requirement,
    // so the refusal below is about the surface, not about the `web` verification failing.
    const control = await inReview(3);
    await recordRun({
      taskId: control.id,
      repoRoot,
      command: change("apps/web/src/page.ts"),
    });
    const controlDone = await withService((s) =>
      s.move({
        taskId: control.id,
        expectedRevision: control.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(controlDone.column).toBe("done");

    // The card's change then moves to `api`, which the fixture cannot verify.
    const apiRun = await recordRun({
      taskId: task.id,
      repoRoot,
      command: change("apps/api/src/feature.ts"),
    });
    const err = await refusal((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(err._tag).toBe("RequirementUnmet");
    expect(err).toMatchObject({ requirement: VERIFIED_REQUIREMENT });
    expect(err.message).toContain('needs "verified"');
    expect(err.message).toContain(
      `run ${apiRun}'s latest verify call over the change: api: no verification (`,
    );
    expect(err.message).not.toContain(webRun);
    const after = await withService((s) => s.get(task.id));
    expect(after.column).toBe("review");
  }, 180_000);

  it("keeps a card pinned to version 1 on the exit it started under", async () => {
    const task = await inReview(1);
    const done = await withService((s) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "done",
        actor: LUKAS,
      }),
    );
    expect(done.column).toBe("done");
  });

  /** A card on a board over `version`, walked by a person from intake into building. */
  const inBuilding = (version = 1) =>
    newBoard(version).then((boardId) =>
      withService((s) =>
        Effect.gen(function* () {
          let task = yield* s.create({
            boardId,
            title: "building",
            actor: LUKAS,
          });
          for (const to of ["specifying", "planning", "building"]) {
            task = yield* s.move({
              taskId: task.id,
              expectedRevision: task.revision,
              to,
              actor: LUKAS,
            });
          }
          return task;
        }),
      ),
    );

  /** The card's run moving it on, as a builder run does (no gate stands on building → review). */
  const toReview =
    (task: { readonly id: string; readonly revision: number }) =>
    (s: TaskServiceShape) =>
      s.move({
        taskId: task.id,
        expectedRevision: task.revision,
        to: "review",
        actor: RUN,
      });

  it("refuses building → review with no run, naming non_empty_diff first, and writes nothing", async () => {
    // Every version of the default pipeline declares building's requirements, so a card on any of
    // them is held: the definition did not change, the service started checking what it declares.
    for (const version of [1, 3]) {
      const task = await inBuilding(version);
      const events = await eventCount(task.id);
      const err = await refusal(toReview(task));
      expect(err).toMatchObject({
        _tag: "RequirementUnmet",
        taskId: task.id,
        column: "building",
        to: "review",
        requirement: NON_EMPTY_DIFF_REQUIREMENT,
      });
      expect(err.message).toBe(
        'the move building → review needs "non_empty_diff" (a non-empty diff), which is not met: the card has no runs, so no branch carries its change',
      );
      const after = await withService((s) => s.get(task.id));
      expect(after.column).toBe("building");
      expect(after.revision).toBe(task.revision);
      expect(await eventCount(task.id)).toBe(events);
      // Abandoning the card is never gated on evidence.
      const canceled = await withService((s) =>
        s.move({
          taskId: task.id,
          expectedRevision: task.revision,
          to: "canceled",
          actor: LUKAS,
        }),
      );
      expect(canceled.column).toBe("canceled");
    }
  });

  it("refuses building → review when the latest run's branch carries no committed change", async () => {
    const task = await inBuilding();
    const repoRoot = fixtureRepo({ ".pi/skills/verify-web/drive.sh": PASSING });
    // The change is left in the worktree, uncommitted: verify sees it, a PR would not carry it.
    const run = await recordRun({
      taskId: task.id,
      repoRoot,
      column: "building",
      command: change("apps/web/src/page.ts"),
    });
    const err = await refusal(toReview(task));
    expect(err).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: NON_EMPTY_DIFF_REQUIREMENT,
    });
    expect(err.message).toContain(
      `run ${run}'s branch factory/${run} changes no file against main (git diff --numstat main...factory/${run} is empty)`,
    );
  }, 120_000);

  it("refuses building → review when the run's repository has no checkout to measure its branch in", async () => {
    const task = await inBuilding();
    const sessions = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({}).access,
        sessionRoot,
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    const repo = RepoSlug.make(`factory-test/requires-${hex(4)}`);
    const run = await sessions
      .runPromise(
        Effect.gen(function* () {
          const service = yield* SessionService;
          yield* service.registerRepo({
            repo,
            url: "https://example.invalid/requires.git",
          });
          const created = yield* service.create({
            repo,
            baseRef: "main",
            taskId: task.id,
            taskColumn: "building",
          });
          return created.id;
        }),
      )
      .finally(() => sessions.dispose());
    const err = await refusal(toReview(task));
    expect(err).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: NON_EMPTY_DIFF_REQUIREMENT,
    });
    expect(err.message).toContain(
      `run ${run}'s branch could not be measured: repository ${repo} has no local checkout registered`,
    );
  }, 60_000);

  it("refuses building → review when the run's branch is gone from its checkout, naming the range it could not measure", async () => {
    const task = await inBuilding();
    const repoRoot = fixtureRepo({ ".pi/skills/verify-web/drive.sh": PASSING });
    const run = await recordRun({
      taskId: task.id,
      repoRoot,
      column: "building",
      command: commit("apps/web/src/page.ts"),
    });
    // The checkout no longer holds the run's branch (a re-registered checkout, a pruned ref): git
    // cannot resolve the range, which is not a measured empty diff and not a pass either.
    execSync(`git update-ref -d refs/heads/factory/${run}`, {
      cwd: repoRoot,
      stdio: "ignore",
    });
    const err = await refusal(toReview(task));
    expect(err).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: NON_EMPTY_DIFF_REQUIREMENT,
    });
    expect(err.message).toContain(
      `run ${run}'s branch could not be measured: the branch's diff could not be measured: git diff main...factory/${run} in ${repoRoot}`,
    );
  }, 120_000);

  it("refuses building → review when the card's run has no branch: no checkout, bound to no repository, or gone from the index", async () => {
    const task = await inBuilding();
    const sessions = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({}).access,
        sessionRoot,
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    const run = await sessions
      .runPromise(
        Effect.gen(function* () {
          const service = yield* SessionService;
          const created = yield* service.create({
            taskId: task.id,
            taskColumn: "building",
          });
          return created.id;
        }),
      )
      .finally(() => sessions.dispose());
    // The run names no repo, so it is bound to the card's (LOB-255) — a repository the create
    // registered with no checkout, so there is nothing to measure its branch in.
    const card = await withService((s) => s.get(task.id));
    const unchecked = await refusal(toReview(task));
    expect(unchecked).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: NON_EMPTY_DIFF_REQUIREMENT,
    });
    expect(unchecked.message).toContain(
      `run ${run}'s branch could not be measured: repository ${card.repo} has no local checkout registered, so no branch of it can be read`,
    );
    // A run bound to no repository can no longer be started for a card; one from before LOB-255 is
    // its index row with none.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`UPDATE sessions SET repo = NULL, base_ref = NULL WHERE id = ${run}`;
      }),
    );
    const unbound = await refusal(toReview(task));
    expect(unbound).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: NON_EMPTY_DIFF_REQUIREMENT,
    });
    expect(unbound.message).toContain(
      `run ${run}'s branch could not be measured: its session is bound to no repository, so it has no branch`,
    );
    // The index row goes (its log stays): the run still names the session, and nothing says where
    // its branch is.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`DELETE FROM sessions WHERE id = ${run}`;
      }),
    );
    const unindexed = await refusal(toReview(task));
    expect(unindexed).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: NON_EMPTY_DIFF_REQUIREMENT,
    });
    expect(unindexed.message).toContain(
      `run ${run}'s branch could not be measured: its session is not in the index`,
    );
  }, 60_000);

  it("measures the branch from a local_path inside the checkout, as the worktree was cut from it", async () => {
    const task = await inBuilding();
    const repoRoot = fixtureRepo({
      ".pi/skills/verify-web/drive.sh": PASSING,
      "packages/app/README.md": "# app\n",
    });
    const run = await recordRun({
      taskId: task.id,
      repoRoot,
      localPath: join(repoRoot, "packages", "app"),
      column: "building",
      command: commit("apps/web/src/page.ts"),
    });
    // The branch was found and measured non-empty, so the refusal is the next requirement's.
    const err = await refusal(toReview(task));
    expect(err).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: PR_LINK_REQUIREMENT,
    });
    expect(err.message).toContain(
      `the card's latest run ${run} recorded no PR`,
    );
  }, 120_000);

  it("passes non_empty_diff on a committed change, refuses on pr_link until the run's PR is recorded, then lets the move through", async () => {
    const task = await inBuilding();
    const repoRoot = fixtureRepo({ ".pi/skills/verify-web/drive.sh": PASSING });
    const run = await recordRun({
      taskId: task.id,
      repoRoot,
      column: "building",
      command: commit("apps/web/src/page.ts"),
    });
    const err = await refusal(toReview(task));
    // The branch's change is there, so the refusal names the next requirement: the PR.
    expect(err).toMatchObject({
      _tag: "RequirementUnmet",
      column: "building",
      to: "review",
      requirement: PR_LINK_REQUIREMENT,
    });
    expect(err.message).toBe(
      `the move building → review needs "pr_link" (a PR link), which is not met: the card's latest run ${run} recorded no PR (no factory.pr document in its log): open its PR (factory pr ${run}) before moving the card on`,
    );

    // The same run's PR, opened through the PR step, is the record the requirement reads.
    const withPr = await inBuilding();
    await recordRun({
      taskId: withPr.id,
      repoRoot,
      column: "building",
      command: commit("apps/web/src/other.ts"),
      openPr: true,
    });
    const review = await withService(toReview(withPr));
    expect(review.column).toBe("review");
    expect(review.revision).toBe(withPr.revision + 1);
  }, 180_000);

  it("lets building → review through after the PR's review run started on the card (LOB-36)", async () => {
    const task = await inBuilding();
    const repoRoot = fixtureRepo({ ".pi/skills/verify-web/drive.sh": PASSING });
    const builder = await recordRun({
      taskId: task.id,
      repoRoot,
      column: "building",
      command: commit("apps/web/src/reviewed.ts"),
      openPr: true,
    });
    // What the review trigger creates once the PR's `opened` lands, while the card is still in
    // building: a run of the reviewer column, cut at the head, on a branch with nothing of its own.
    const reviewer = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ repo: string; branch: string | null }>`
          SELECT repo, branch FROM sessions WHERE id = ${builder}
        `;
        const bound = rows[0];
        if (bound === undefined)
          return yield* Effect.die(new Error(`${builder} has no index row`));
        const head = execSync(
          `git rev-parse ${bound.branch ?? `factory/${builder}`}`,
          {
            cwd: repoRoot,
            encoding: "utf8",
          },
        ).trim();
        const sessions = ManagedRuntime.make(
          SessionServiceLive({
            model: createFauxModelAccess({}).access,
            sessionRoot,
          }).pipe(
            Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
          ),
        );
        return yield* Effect.promise(() =>
          sessions
            .runPromise(
              Effect.gen(function* () {
                const service = yield* SessionService;
                const created = yield* service.create({
                  repo: RepoSlug.make(bound.repo),
                  baseRef: head,
                  branch: BranchName.make(
                    `factory/review-7-${head.slice(0, 12)}`,
                  ),
                  taskId: task.id,
                  taskColumn: "review",
                  review: {
                    number: 7,
                    url: "https://github.com/factory-test/requires/pull/7",
                    base: "main",
                    head,
                  },
                });
                return created.id;
              }),
            )
            .finally(() => sessions.dispose()),
        );
      }),
    );
    expect(reviewer).not.toBe(builder);
    // The review run is the newest task_runs row, and it is not what building's exit reads.
    const review = await withService(toReview(task));
    expect(review.column).toBe("review");
  }, 180_000);

  it("reads the latest run only: an older run's PR does not carry a newer run's branch", async () => {
    const task = await inBuilding();
    const repoRoot = fixtureRepo({ ".pi/skills/verify-web/drive.sh": PASSING });
    const older = await recordRun({
      taskId: task.id,
      repoRoot,
      column: "building",
      command: commit("apps/web/src/page.ts"),
      openPr: true,
    });
    const latest = await recordRun({
      taskId: task.id,
      repoRoot,
      column: "building",
      command: commit("apps/web/src/next.ts"),
    });
    const err = await refusal(toReview(task));
    expect(err).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: PR_LINK_REQUIREMENT,
    });
    expect(err.message).toContain(
      `the card's latest run ${latest} recorded no PR`,
    );
    expect(err.message).not.toContain(older);
  }, 180_000);
});
