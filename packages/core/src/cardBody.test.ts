/**
 * A card's body, base ref and external ref (LOB-260; docs/board.md B1, B3): stored on the card and
 * in its `created` event, derivable from `task_events` alone, quoted into every run's prompt as the
 * `task_body` section, and the ref a run on the card cuts its worktree from.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Each case makes its own board
 * over a fresh repository, so cases never share a card. The harness half — the section's exact text,
 * and no section for an empty body — is `packages/harness/src/body.test.ts`.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  type TaskEvent,
} from "@repo/domain/Task";
import {
  BODY_SECTION_KEY,
  createFauxModelAccess,
  readPromptSections,
  renderBody,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { SessionService, SessionServiceLive } from "./SessionService";
import { projectTask } from "./taskProjection";
import { TaskService, TaskServiceLive } from "./TaskService";

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive)),
);

afterAll(() => runtime.dispose());

const LUKAS = "person:lukas";
const RUN = "ses_0123456789abcdefghjkmnpqrs";

/** A body a person could have typed: markdown, a list, an em dash, and edges a trim would lose. */
const BODY =
  "  ## Goal\n\nShip the release notes — **verbatim**.\n\n- keep port 5442\n- no new env vars\n\n";
const EXTERNAL = "https://linear.app/lobiklukas/issue/LOB-42";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const run = <A, E>(effect: Effect.Effect<A, E, TaskService | SqlClient>) =>
  runtime.runPromise(effect);

/**
 * A board over a fresh repository, made the way a real one is (LOB-208): the newest version, or the
 * one named.
 */
const newBoard = (definitionVersion?: number) =>
  run(
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      return yield* tasks.createBoard({
        repo: RepoSlug.make(`factory-test/${hex(6)}`),
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        ...(definitionVersion === undefined ? {} : { definitionVersion }),
      });
    }),
  );

/** The card's `created` event payload, as the row stores it: the JSON, not a decode of it. */
const createdPayload = (taskId: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ payload: string }>`
        SELECT payload::text AS payload FROM task_events
        WHERE task_id = ${taskId} AND kind = 'created'
      `;
      return rows.map(
        (row) => JSON.parse(row.payload) as Record<string, unknown>,
      );
    }),
  );

/** The card's three columns as the row holds them. */
const rowOf = (taskId: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        body: string;
        baseRef: string | null;
        externalRef: string | null;
      }>`SELECT body, base_ref, external_ref FROM tasks WHERE id = ${taskId}`;
      return rows[0];
    }),
  );

describe("a card's body, base ref and external ref (LOB-260)", () => {
  /**
   * Mutation: drop `body` (or either ref) from the INSERT — the read-back lacks it.
   * Mutation: drop them from the `created` event — the payload lacks them.
   * Mutation: trim the body — the verbatim comparisons fail.
   */
  it("round-trips them through create, get and list, and writes them into the created event", async () => {
    const board = await newBoard();
    const created = await run(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({
          boardId: board.id,
          title: "release notes",
          body: BODY,
          baseRef: "release",
          externalRef: EXTERNAL,
          actor: LUKAS,
        }),
      ),
    );
    expect(created.body).toBe(BODY);
    expect(created.baseRef).toBe("release");
    expect(created.externalRef).toBe(EXTERNAL);

    const [read, listed] = await run(
      Effect.flatMap(TaskService, (tasks) =>
        Effect.all([tasks.get(created.id), tasks.list({ boardId: board.id })]),
      ),
    );
    expect(read).toEqual(created);
    expect(listed).toEqual([created]);
    expect(await rowOf(created.id)).toEqual({
      body: BODY,
      baseRef: "release",
      externalRef: EXTERNAL,
    });

    const events = await createdPayload(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      _tag: "created",
      taskId: created.id,
      boardId: board.id,
      title: "release notes",
      column: "intake",
      actor: LUKAS,
      revision: 1,
      priority: "normal",
      body: BODY,
      baseRef: "release",
      externalRef: EXTERNAL,
    });
  });

  /** Mutation: store a blank body as given — the card reads back with `body: "  \n"`. */
  it("stores a blank body and blank refs as none, in the row and in the event", async () => {
    const board = await newBoard();
    const created = await run(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({
          boardId: board.id,
          title: "nothing to say",
          body: "  \n\t ",
          baseRef: " ",
          externalRef: "",
          actor: LUKAS,
        }),
      ),
    );
    expect(created.body).toBeUndefined();
    expect(created.baseRef).toBeUndefined();
    expect(created.externalRef).toBeUndefined();
    expect(await rowOf(created.id)).toEqual({
      body: "",
      baseRef: null,
      externalRef: null,
    });
    const [event] = await createdPayload(created.id);
    expect(event).not.toHaveProperty("body");
    expect(event).not.toHaveProperty("baseRef");
    expect(event).not.toHaveProperty("externalRef");
  });

  /**
   * Every run on the card hands its base ref to git (LOB-260), so a ref that is not a plain git ref
   * is refused once, at create, naming the field — and so is a body or ref over its cap, which the
   * RPC schema alone would leave an in-process caller (a trigger, a sync) free to store.
   *
   * Mutation: drop the `isSafeBranchName` check — `$(touch …)` and `-x` are stored.
   * Mutation: drop the length checks — the oversize body is stored.
   */
  it("refuses a base ref that is not a plain git ref, and a body or ref over its cap, writing nothing", async () => {
    const board = await newBoard();
    const marker = join(mkdtempSync(join(tmpdir(), "card-ref-")), "touched");
    const attempts = [
      { field: "baseRef", input: { baseRef: `$(touch ${marker})` } },
      { field: "baseRef", input: { baseRef: "`touch x`" } },
      { field: "baseRef", input: { baseRef: "-x" } },
      { field: "baseRef", input: { baseRef: "a..b" } },
      { field: "baseRef", input: { baseRef: "main@{1}" } },
      { field: "baseRef", input: { baseRef: "has space" } },
      { field: "baseRef", input: { baseRef: "a".repeat(1025) } },
      { field: "externalRef", input: { externalRef: "x".repeat(1025) } },
      { field: "body", input: { body: "b".repeat(32_001) } },
    ] as const;
    for (const { field, input } of attempts) {
      const refused = await run(
        Effect.flip(
          Effect.flatMap(TaskService, (tasks) =>
            tasks.create({
              boardId: board.id,
              title: `refused ${field}`,
              ...input,
              actor: LUKAS,
            }),
          ),
        ),
      );
      expect(refused._tag, JSON.stringify(input).slice(0, 40)).toBe(
        "InvalidTaskInput",
      );
      expect(refused).toMatchObject({ field });
    }
    const cards = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.list({ boardId: board.id })),
    );
    expect(cards).toEqual([]);
  });

  /** Mutation: store the refs as given — the card reads back with their whitespace. */
  it("trims a base ref and an external ref, and takes a tag, a remote branch or a sha", async () => {
    const board = await newBoard();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const made = await run(
      Effect.flatMap(TaskService, (tasks) =>
        Effect.forEach([" release ", "v1.2.3", "origin/main", sha], (baseRef) =>
          tasks.create({
            boardId: board.id,
            title: `ref ${baseRef}`,
            baseRef,
            externalRef: " LOB-42\n",
            actor: LUKAS,
          }),
        ),
      ),
    );
    expect(made.map((card) => card.baseRef)).toEqual([
      "release",
      "v1.2.3",
      "origin/main",
      sha,
    ]);
    expect(made.every((card) => card.externalRef === "LOB-42")).toBe(true);
  });

  /**
   * The card's row is derivable from its history: after a move, an ask, its answer, a block and an
   * unblock, the projection folded from `task_events` is the card `get` reads — and it still is once
   * the row's body, base ref and external ref are wiped, because it never reads the row.
   *
   * Mutation: drop the three fields from the `created` event — the projection has no body.
   * Mutation: read the row in `replay` — the wiped columns come back empty.
   * Mutation: forget the revision step in the fold — the revisions disagree.
   */
  it("rebuilds the card from task_events, restoring body, base ref and external ref", async () => {
    const board = await newBoard();
    const card = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const made = yield* tasks.create({
          boardId: board.id,
          title: "rebuild me",
          body: BODY,
          baseRef: "release",
          externalRef: EXTERNAL,
          priority: "urgent",
          actor: LUKAS,
        });
        const moved = yield* tasks.move({
          taskId: made.id,
          expectedRevision: made.revision,
          to: "specifying",
          actor: LUKAS,
        });
        yield* tasks.ask({
          taskId: moved.id,
          question: "Which release?",
          actor: RUN,
        });
        const asked = yield* tasks.get(moved.id);
        const answered = yield* tasks.comment({
          taskId: asked.id,
          expectedRevision: asked.revision,
          body: "The next one.",
          actor: LUKAS,
        });
        const blocked = yield* tasks.block({
          taskId: answered.id,
          expectedRevision: answered.revision,
          reason: "dependency",
          actor: LUKAS,
        });
        return yield* tasks.unblock({
          taskId: blocked.id,
          expectedRevision: blocked.revision,
          actor: LUKAS,
        });
      }),
    );
    // created 1, moved → 2, question → 3, blocked → 4, answer → 5, unblocked → 6, blocked → 7,
    // unblocked → 8: every write is one revision and one event.
    expect(card.revision).toBe(8);

    const before = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.replay(card.id)),
    );
    expect(before).toEqual({
      taskId: card.id,
      boardId: board.id,
      title: "rebuild me",
      column: "specifying",
      revision: card.revision,
      priority: "urgent",
      body: BODY,
      baseRef: "release",
      externalRef: EXTERNAL,
    });

    // The row loses what the card says; the history does not.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          UPDATE tasks SET body = '', base_ref = NULL, external_ref = NULL WHERE id = ${card.id}
        `;
      }),
    );
    const wiped = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.get(card.id)),
    );
    expect(wiped.body).toBeUndefined();
    const after = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.replay(card.id)),
    );
    expect(after).toEqual(before);
    expect(after.body).toBe(card.body);
    expect(after.baseRef).toBe(card.baseRef);
    expect(after.externalRef).toBe(card.externalRef);
  });

  /** Mutation: let `replay` answer an empty projection — an unknown card would not be refused. */
  it("refuses to replay a card that does not exist", async () => {
    const missing = `tsk_${"0".repeat(26)}`;
    const error = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.replay(missing)).pipe(
        Effect.flip,
      ),
    );
    expect(error._tag).toBe("TaskNotFound");
  });
});

describe("projectTask (LOB-260)", () => {
  const TASK = `tsk_${"1".repeat(26)}` as TaskEvent["taskId"];
  const BOARD = `brd_${"1".repeat(26)}` as Extract<
    TaskEvent,
    { _tag: "created" }
  >["boardId"];
  const created: TaskEvent = {
    _tag: "created",
    taskId: TASK,
    boardId: BOARD,
    title: "t",
    column: "intake",
    actor: LUKAS,
    revision: 1,
  };

  /** Mutation: default a missing `created.body` to `""` — a card from before has a body of nothing. */
  it("reads a created event from before cards carried a body as a card with none", () => {
    expect(projectTask([created])).toEqual({
      taskId: TASK,
      boardId: BOARD,
      title: "t",
      column: "intake",
      revision: 1,
      priority: "normal",
    });
  });

  /** Mutation: ignore `priorityChanged` or `retitled` — the fold keeps the create's priority or title. */
  it("folds a priority change, and refuses a history that does not start with created", () => {
    expect(
      projectTask([
        created,
        {
          _tag: "priorityChanged",
          taskId: TASK,
          from: "normal",
          to: "urgent",
          actor: LUKAS,
          revision: 1,
        },
      ])?.priority,
    ).toBe("urgent");
    expect(
      projectTask([
        created,
        {
          _tag: "retitled",
          taskId: TASK,
          from: "t",
          to: "renamed",
          actor: LUKAS,
          revision: 1,
        },
      ]),
    ).toMatchObject({ title: "renamed", revision: 2 });
    expect(projectTask([])).toBeUndefined();
    expect(
      projectTask([
        { _tag: "unblocked", taskId: TASK, actor: LUKAS, revision: 1 },
      ]),
    ).toBeUndefined();
    expect(projectTask([created, created])).toBeUndefined();
  });

  /** Mutation: ignore `repinned` — the fold leaves the card in the column the mapping renamed. */
  it("folds a repin (D5): the mapped column, the block's column mapped with it, the next revision", () => {
    expect(
      projectTask([
        created,
        {
          _tag: "blocked",
          taskId: TASK,
          reason: "dependency",
          column: "intake",
          actor: LUKAS,
          revision: 1,
        },
        {
          _tag: "repinned",
          taskId: TASK,
          actor: LUKAS,
          revision: 2,
          fromVersion: 1,
          toVersion: 2,
          from: "intake",
          to: "inbox",
          mapping: { intake: "inbox" },
        },
      ]),
    ).toMatchObject({
      column: "inbox",
      revision: 3,
      blocked: { reason: "dependency", column: "inbox" },
    });
  });
});

/**
 * A run on the card (LOB-260): its worktree is cut from the card's base ref, and its prompt carries
 * the card's body as the `task_body` section — through the real `SessionService`, a real git
 * checkout and a real log, with only the model scripted.
 */
describe("a run on a card with a body and a base ref (LOB-260)", () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), "factory-card-body-"));

  /** A checkout with `main` and a `release` branch one commit ahead of it, and both shas. */
  const fixture = () => {
    const checkout = mkdtempSync(join(tmpdir(), "factory-card-body-repo-"));
    const git = (command: string, cwd = checkout) =>
      execSync(command, { cwd, encoding: "utf8" }).trim();
    git("git init -q -b main");
    git("git config user.email repo@localhost");
    git("git config user.name repo");
    writeFileSync(join(checkout, "README.md"), "# fixture\n");
    git("git add -A");
    git("git commit -q -m base");
    const main = git("git rev-parse main");
    git("git checkout -q -b release");
    writeFileSync(join(checkout, "RELEASE.md"), "release only\n");
    git("git add -A");
    git("git commit -q -m release");
    const release = git("git rev-parse release");
    git("git checkout -q main");
    return { checkout, git, main, release };
  };

  const promptOf = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* Effect.acquireUseRelease(
        Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
        (storage) => readPromptSections(storage),
        (storage) => Effect.promise(() => storage.dispose()),
      );
    });

  /**
   * Mutation: drop `cardBase` from `resolveBinding` — the run is cut from `main`.
   * Mutation: drop `body` from the owner's `open` — the prompt has no `task_body`.
   * Mutation: read `""` as a body in `cardBodyFor` and drop `renderBody`'s blank check — the bare
   * card's run gets a section with nothing in it.
   */
  it("cuts the run's worktree from the card's base ref and tells the run the card's body", async () => {
    const repo = fixture();
    // Three runs open on one card at once, which default version 5's task cap of 1 refuses (LOB-71):
    // version 4 is the newest that caps nothing, and this case is about the binding, not the caps.
    const board = await newBoard(4);
    const [card, bare] = await run(
      Effect.flatMap(TaskService, (tasks) =>
        Effect.all([
          tasks.create({
            boardId: board.id,
            title: "on release",
            body: BODY,
            baseRef: "release",
            actor: LUKAS,
          }),
          tasks.create({ boardId: board.id, title: "bare", actor: LUKAS }),
        ]),
      ),
    );

    const sessions = ManagedRuntime.make(
      Layer.mergeAll(
        SessionServiceLive({
          model: createFauxModelAccess({}).access,
          sessionRoot,
        }),
        TaskServiceLive,
      ).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    const outcome = await sessions
      .runPromise(
        Effect.gen(function* () {
          const service = yield* SessionService;
          yield* service.registerRepo({
            repo: board.repo,
            url: "https://example.invalid/repo.git",
            localPath: repo.checkout,
          });
          // The card pane's start (the card's repo named) and a client's that names nothing.
          const onCard = yield* service.create({
            title: card.title,
            taskId: card.id,
            taskColumn: card.column,
            ...(card.repo === undefined ? {} : { repo: card.repo }),
          });
          const unnamed = yield* service.create({
            taskId: card.id,
            taskColumn: "building",
          });
          // A run that names its own base keeps it: the card's is a default, not an override.
          const ownBase = yield* service.create({
            taskId: card.id,
            taskColumn: "building",
            baseRef: "main",
          });
          const onBare = yield* service.create({
            taskId: bare.id,
            taskColumn: bare.column,
          });
          for (const id of [onCard.id, onBare.id]) {
            yield* service.send({ sessionId: id, content: "work on it" });
          }
          for (const id of [onCard.id, onBare.id]) {
            for (let attempt = 0; ; attempt += 1) {
              const snapshot = yield* service.get(id);
              const replied =
                !snapshot.live.busy &&
                snapshot.entries.some((entry) => entry.kind === "assistant");
              if (replied) break;
              if (attempt >= 400) {
                return yield* Effect.die(new Error(`run ${id} never replied`));
              }
              yield* Effect.sleep(50);
            }
          }
          return {
            runs: yield* Effect.forEach(
              [onCard.id, unnamed.id, ownBase.id, onBare.id],
              (id) => service.get(id),
            ),
            prompt: yield* promptOf(onCard.id),
            barePrompt: yield* promptOf(onBare.id),
          };
        }),
      )
      .finally(() => sessions.dispose());

    const [onCard, unnamed, ownBase, onBare] = outcome.runs;
    for (const snapshot of [onCard, unnamed]) {
      expect(snapshot?.session.baseRef).toBe("release");
      expect(snapshot?.workspace.baseRef).toBe("release");
      // The worktree is real and stands on `release`'s commit, not `main`'s.
      const path = snapshot?.workspace.path ?? "";
      expect(repo.git("git rev-parse HEAD", path)).toBe(repo.release);
      expect(repo.git("git rev-parse --abbrev-ref HEAD", path)).toBe(
        `factory/${snapshot?.session.id}`,
      );
    }
    expect(ownBase?.session.baseRef).toBe("main");
    expect(repo.git("git rev-parse HEAD", ownBase?.workspace.path ?? "")).toBe(
      repo.main,
    );
    // A card with no base ref starts from the repository's default.
    expect(onBare?.session.baseRef).toBe("main");
    expect(repo.git("git rev-parse HEAD", onBare?.workspace.path ?? "")).toBe(
      repo.main,
    );

    // The run was told the card's body, verbatim, as its own section.
    expect(outcome.prompt[BODY_SECTION_KEY]).toBe(
      `<${BODY_SECTION_KEY}>\n${renderBody(BODY) ?? ""}\n</${BODY_SECTION_KEY}>`,
    );
    expect(outcome.prompt[BODY_SECTION_KEY]).toContain(BODY);
    // And a card with no body gets no section at all.
    expect(outcome.barePrompt[BODY_SECTION_KEY]).toBeUndefined();
  }, 120_000);
});

describe("a card's external link, and filing a card for an outside item (LOB-254)", () => {
  const LINK = "https://linear.app/acme/issue/ENG-7/make-it-stop";

  /**
   * Mutation: drop `external_url` from the INSERT or the read — the read-back lacks it.
   * Mutation: drop it from the `created` event — the projection lacks it.
   */
  it("round-trips the link through create, the row, the created event and the projection", async () => {
    const board = await newBoard();
    const created = await run(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({
          boardId: board.id,
          title: "linked",
          externalRef: "linear:iss-7",
          externalUrl: ` ${LINK} `,
          actor: LUKAS,
        }),
      ),
    );
    expect(created.externalUrl).toBe(LINK);
    const read = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.get(created.id)),
    );
    expect(read.externalUrl).toBe(LINK);
    const [event] = await createdPayload(created.id);
    expect(event).toMatchObject({ externalUrl: LINK });
    const projected = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.replay(created.id)),
    );
    expect(projected.externalUrl).toBe(LINK);
  });

  /** Mutation: drop the `isWebLink` check — a `javascript:` link is stored and rendered. */
  it("refuses a link that is not an absolute http(s) URL, writing nothing", async () => {
    const board = await newBoard();
    for (const externalUrl of [
      "javascript:alert(1)",
      "/issue/ENG-7",
      "ENG-7",
      "ftp://linear.app/x",
    ]) {
      const refused = await run(
        Effect.flip(
          Effect.flatMap(TaskService, (tasks) =>
            tasks.create({
              boardId: board.id,
              title: "refused link",
              externalUrl,
              actor: LUKAS,
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({
        _tag: "InvalidTaskInput",
        field: "externalUrl",
      });
    }
    const cards = await run(
      Effect.flatMap(TaskService, (tasks) => tasks.list({ boardId: board.id })),
    );
    expect(cards).toEqual([]);
  });

  /**
   * Mutation: drop the existing-card read from `file` — the second filing makes a second card.
   * Mutation: key the read on the untrimmed ref — `" linear:iss-8 "` makes a second card.
   */
  it("files one card per item and board: the second filing answers the first card, and another board gets its own", async () => {
    const [board, other] = [await newBoard(), await newBoard()];
    const file = (boardId: typeof board.id, externalRef: string) =>
      run(
        Effect.flatMap(TaskService, (tasks) =>
          tasks.file({
            boardId,
            title: "filed",
            externalRef,
            actor: "trigger:linear",
          }),
        ),
      );
    const first = await file(board.id, "linear:iss-8");
    const second = await file(board.id, " linear:iss-8 ");
    const elsewhere = await file(other.id, "linear:iss-8");
    expect(first.created).toBe(true);
    expect(second).toEqual({ task: first.task, created: false });
    expect(elsewhere.created).toBe(true);
    expect(elsewhere.task.id).not.toBe(first.task.id);

    const blank = await run(
      Effect.flip(
        Effect.flatMap(TaskService, (tasks) =>
          tasks.file({
            boardId: board.id,
            title: "no item",
            externalRef: "  ",
            actor: "trigger:linear",
          }),
        ),
      ),
    );
    expect(blank).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "externalRef",
    });
  });
});
