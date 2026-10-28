/**
 * A handed-off card's first run starts on the handed-off diff (S-local-agent-handoff-mcp,
 * `./handoff`): `createTask` keeps the patch on the card, `getTaskHandoff` reads it back, the cap
 * refuses an oversized one, and a run cut on a fresh branch has the patch committed on
 * `factory/<session-id>` before its agent's first turn — which the faux agent's one command proves by
 * reading the handed-off file. A patch that does not apply refuses the run and leaves its worktree at
 * the base, and so are a later run that continues its branch and a message to it; a later run that
 * continues the card's branch (C19) does not apply it twice, and one whose branch lacks it applies it.
 *
 * Real Postgres, real git worktrees, the real session and task services; the model is faux.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  MAX_HANDOFF_PATCH_BYTES,
} from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { HANDOFF_TRAILER } from "./handoff";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const runId = randomBytes(4).toString("hex");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "handoff",
      GIT_AUTHOR_EMAIL: "handoff@localhost",
      GIT_COMMITTER_NAME: "handoff",
      GIT_COMMITTER_EMAIL: "handoff@localhost",
    },
  }).trim();

/** The registered checkout the runs are cut from: `main` holds a README and a source file. */
const checkout = mkdtempSync(join(tmpdir(), "factory-handoff-repo-"));
git(checkout, "init", "-q", "-b", "main");
writeFileSync(join(checkout, "README.md"), "handoff\n");
writeFileSync(join(checkout, "src.txt"), "one\ntwo\nthree\n");
git(checkout, "add", "-A");
git(checkout, "commit", "-q", "-m", "init");
const baseCommit = git(checkout, "rev-parse", "HEAD");

/**
 * A local agent's work in progress, as `factory handoff` takes it: a clone of the checkout with one
 * file edited and one new untracked file, diffed from the commit it started at to its working tree.
 */
const local = mkdtempSync(join(tmpdir(), "factory-handoff-local-"));
git(local, "clone", "-q", checkout, ".");
writeFileSync(join(local, "src.txt"), "one\ntwo, edited locally\nthree\n");
writeFileSync(join(local, "notes.md"), "work in progress\n");
git(local, "add", "-A");
const patch = `${git(local, "diff", "--cached", "--binary", "--full-index", baseCommit)}\n`;

/** A patch against a file the base does not have: it can never apply. */
const strayPatch = [
  "diff --git a/missing.txt b/missing.txt",
  "index 0000000000000000000000000000000000000001..0000000000000000000000000000000000000002 100644",
  "--- a/missing.txt",
  "+++ b/missing.txt",
  "@@ -1 +1 @@",
  "-was here",
  "+is here",
  "",
].join("\n");

/** A patch's size as a request carries it: its JSON string's UTF-8 bytes, quotes aside. */
const wireBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).length - 2;

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-handoff-sessions-"));

/** The agent's first turn reads the handed-off file: its output is the proof the turn saw it. */
const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess({
          fauxCommand: "cat notes.md; git log -1 --format=%s",
        }).access,
        sessionRoot,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);

afterAll(async () => {
  await runtime.dispose();
});

const repo = RepoSlug.make(`handoff-${runId}/card`);
const worktreeOf = (sessionId: string) =>
  join(sessionRoot, ...repo.split("/"), sessionId);

/** The board every card here is on, made once. */
let boardId: BoardInstanceId | undefined;
const board = Effect.gen(function* () {
  if (boardId !== undefined) return boardId;
  const service = yield* SessionService;
  const tasks = yield* TaskService;
  yield* service.registerRepo({ repo, localPath: checkout });
  const created = yield* tasks.createBoard({
    repo,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  boardId = BoardInstanceId.make(created.id);
  return boardId;
});

/** A card in `building`, carrying `handoff` when given. */
const card = (handoff?: { readonly patch: string }) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const sql = yield* SqlClient;
    const made = yield* tasks.create({
      boardId: yield* board,
      title: "finish the local work",
      baseRef: "main",
      actor: "person:handoff",
      ...(handoff === undefined
        ? {}
        : {
            handoff: {
              ...handoff,
              branch: "feature/local",
              baseCommit,
            },
          }),
    });
    // Straight into `building`: the moves that get a card there are the board's own suite's.
    yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${made.id}`;
    return made;
  });

const waitUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/**
 * Finish a card, so its runs hold no slot of the board's run cap (B9): every test here starts runs
 * on one board, and a run that never took a turn would otherwise stay in flight for the next test.
 */
const finish = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE tasks SET "column" = 'canceled' WHERE id = ${taskId}`;
  });

/** The commits on the worktree's branch since `main` that carry the handoff trailer. */
const handoffCommits = (worktree: string) =>
  git(worktree, "log", "--format=%B%x00", "main..HEAD")
    .split("\0")
    .filter((message) => message.includes(`${HANDOFF_TRAILER}: `));

describe("a handed-off card (S-local-agent-handoff-mcp)", () => {
  /**
   * Mutations this catches: drop the handoff from the `created` event — `getTaskHandoff` answers
   * `undefined`; skip `applyCardHandoff` — the worktree's diff from `main` is empty and the agent's
   * `cat notes.md` fails; apply without committing — `main..HEAD` holds no commit and the diff is
   * the working tree's only; apply after the first turn — the turn's output has no `work in progress`.
   */
  it("keeps the patch on the card, and its first run starts with the same diff committed on factory/<id>", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const made = yield* card({ patch });
        const stored = yield* tasks.handoff(made.id);
        const run = yield* service.create({
          taskId: made.id,
          taskColumn: "building",
        });
        const worktree = worktreeOf(run.id);
        const cut = {
          branch: git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
          diff: `${git(worktree, "diff", "--binary", "--full-index", "main", "HEAD")}\n`,
          status: git(worktree, "status", "--porcelain"),
          commits: handoffCommits(worktree),
          author: git(worktree, "log", "-1", "--format=%an <%ae>"),
          notes: readFileSync(join(worktree, "notes.md"), "utf8"),
        };
        yield* service.send({ sessionId: run.id, content: "carry on" });
        const settled = yield* waitUntil(
          service.get(run.id),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the run to settle",
        );
        yield* finish(made.id);
        return { made, stored, run, cut, settled };
      }),
    );
    expect(outcome.stored).toMatchObject({
      taskId: outcome.made.id,
      patch,
      branch: "feature/local",
      baseCommit,
      baseRef: "main",
      files: ["notes.md", "src.txt"],
      actor: "person:handoff",
    });
    expect(outcome.stored?.bytes).toBe(new TextEncoder().encode(patch).length);
    expect(outcome.cut.branch).toBe(`factory/${outcome.run.id}`);
    // The same diff: what the local agent had, now the branch's change against its base.
    expect(outcome.cut.diff).toBe(patch);
    expect(outcome.cut.status).toBe("");
    expect(outcome.cut.commits).toHaveLength(1);
    expect(outcome.cut.commits[0]).toContain(
      `${HANDOFF_TRAILER}: ${outcome.made.id}`,
    );
    expect(outcome.cut.author).toBe(
      "factory handoff <handoff@factory.invalid>",
    );
    expect(outcome.cut.notes).toBe("work in progress\n");
    const toolOutput = outcome.settled.entries
      .filter((entry) => entry.kind === "toolResult")
      .map((entry) => entry.text)
      .join("\n");
    expect(toolOutput).toContain("work in progress");
    expect(toolOutput).toContain("Hand off 2 files from local feature/local");
  }, 120_000);

  /**
   * Mutations this catches: re-apply on a run that continues the card's branch — a second trailer
   * commit, or a refusal because the patch is already there; key the guard on the column rather than
   * on the branch — the continuing run is in `building` too.
   */
  it("a later run that continues the card's branch does not apply it again", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const made = yield* card({ patch });
        const first = yield* service.create({
          taskId: made.id,
          taskColumn: "building",
        });
        // Its turn ends before the next run starts: the card's run cap (B9) holds a run in flight
        // until its session first goes idle, which `task_runs.finished_at` records.
        yield* service.send({ sessionId: first.id, content: "carry on" });
        const sql = yield* SqlClient;
        yield* waitUntil(
          sql<{ finished: boolean }>`
            SELECT finished_at IS NOT NULL AS finished FROM task_runs
            WHERE session_id = ${first.id}
          `,
          (rows) => rows[0]?.finished === true,
          "the first run to finish its turn",
        );
        const second = yield* service.create({
          taskId: made.id,
          taskColumn: "building",
        });
        const worktree = worktreeOf(second.id);
        yield* finish(made.id);
        return {
          first,
          branch: git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
          commits: handoffCommits(worktree),
        };
      }),
    );
    expect(outcome.branch).toBe(`factory/${outcome.first.id}`);
    expect(outcome.commits).toHaveLength(1);
  }, 120_000);

  /**
   * Mutations this catches: apply a card's patch whatever the card holds — a card with none gets a
   * commit, or the apply of an empty patch fails the create.
   */
  it("a card with no handoff starts its run at the base", async () => {
    const head = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const made = yield* card();
        const stored = yield* tasks.handoff(made.id);
        expect(stored).toBeUndefined();
        const run = yield* service.create({
          taskId: made.id,
          taskColumn: "building",
        });
        yield* finish(made.id);
        return git(worktreeOf(run.id), "rev-parse", "HEAD");
      }),
    );
    expect(head).toBe(baseCommit);
  }, 60_000);

  /**
   * Mutations this catches: swallow a failed apply — the run opens on the base without the work it
   * was handed; leave a half-applied worktree — the status is not clean.
   */
  it("a patch that does not apply refuses the run and leaves its worktree at the base", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const sql = yield* SqlClient;
        const made = yield* card({ patch: strayPatch });
        const refused = yield* service
          .create({ taskId: made.id, taskColumn: "building" })
          .pipe(Effect.flip);
        const runs = yield* sql<{ sessionId: string }>`
          SELECT session_id FROM task_runs WHERE task_id = ${made.id}
        `;
        const sessionId = runs[0]?.sessionId ?? "";
        yield* finish(made.id);
        return {
          refused,
          head: git(worktreeOf(sessionId), "rev-parse", "HEAD"),
          status: git(worktreeOf(sessionId), "status", "--porcelain"),
        };
      }),
    );
    expect(outcome.refused.code).toBe("invalid_input");
    expect(outcome.refused.message).toContain(
      "the card's handoff patch does not apply on this run's base",
    );
    expect(outcome.refused.message).toContain("missing.txt");
    expect(outcome.head).toBe(baseCommit);
    expect(outcome.status).toBe("");
  }, 60_000);

  /**
   * Mutations this catches: key "the branch has it" on the run's binding rather than on the branch —
   * the second run continues the refused run's `factory/<id>` (C19) and opens on the base with no
   * handoff commit; apply only at create — the message to the refused run starts a turn without it.
   */
  it("a run after a refused apply, and a message to the refused run, are refused too", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const sql = yield* SqlClient;
        const made = yield* card({ patch: strayPatch });
        const first = yield* service
          .create({ taskId: made.id, taskColumn: "building" })
          .pipe(Effect.flip);
        const runs = yield* sql<{ sessionId: string }>`
          SELECT session_id FROM task_runs WHERE task_id = ${made.id}
        `;
        const refusedId = runs[0]?.sessionId ?? "";
        const sent = yield* service
          .send({ sessionId: SessionId.make(refusedId), content: "carry on" })
          .pipe(Effect.flip);
        const second = yield* service
          .create({ taskId: made.id, taskColumn: "building" })
          .pipe(Effect.flip);
        const after = yield* sql<{ sessionId: string }>`
          SELECT session_id FROM task_runs WHERE task_id = ${made.id}
          ORDER BY started_at, id
        `;
        const secondId = after[1]?.sessionId ?? "";
        const snapshot = yield* service.get(SessionId.make(refusedId));
        yield* finish(made.id);
        return {
          first,
          sent,
          second,
          secondBranch: git(
            worktreeOf(secondId),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ),
          secondHead: git(worktreeOf(secondId), "rev-parse", "HEAD"),
          refusedId,
          turns: snapshot.entries.filter((entry) => entry.kind === "assistant")
            .length,
        };
      }),
    );
    for (const refusal of [outcome.first, outcome.sent, outcome.second]) {
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.message).toContain(
        "the card's handoff patch does not apply on this run's base",
      );
    }
    // The second run continued the refused run's branch, and that branch still holds no handoff.
    expect(outcome.secondBranch).toBe(`factory/${outcome.refusedId}`);
    expect(outcome.secondHead).toBe(baseCommit);
    expect(outcome.turns).toBe(0);
  }, 60_000);

  /**
   * Mutations this catches: trust the binding over the branch — a run that continues a branch whose
   * create died between cutting the worktree and committing opens with no handoff commit.
   */
  it("a run that continues a branch with no handoff commit applies it there", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const sql = yield* SqlClient;
        const made = yield* card({ patch });
        const first = yield* service.create({
          taskId: made.id,
          taskColumn: "building",
        });
        // As if the create had died before its commit: the branch back at the base, and the run
        // ended without a turn.
        git(worktreeOf(first.id), "reset", "-q", "--hard", "main");
        yield* sql`UPDATE task_runs SET finished_at = now() WHERE session_id = ${first.id}`;
        const second = yield* service.create({
          taskId: made.id,
          taskColumn: "building",
        });
        const worktree = worktreeOf(second.id);
        yield* finish(made.id);
        return {
          first,
          branch: git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
          commits: handoffCommits(worktree),
          diff: `${git(worktree, "diff", "--binary", "--full-index", "main", "HEAD")}\n`,
        };
      }),
    );
    expect(outcome.branch).toBe(`factory/${outcome.first.id}`);
    expect(outcome.commits).toHaveLength(1);
    expect(outcome.diff).toBe(patch);
  }, 120_000);

  /**
   * Mutations this catches: drop the server's cap — the card is made; measure characters rather
   * than bytes — a multibyte patch one byte over slips through; measure raw bytes rather than the
   * escaped ones — the ESC-heavy patch slips through and would overrun the API's request limit;
   * refuse at the cap itself — a patch exactly at it is refused.
   */
  it("refuses a patch over the cap, naming its size and the cap, and makes no card", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        const header = "diff --git a/big.txt b/big.txt\n";
        // One byte over, in two-byte characters: under the cap counted in characters.
        const over = `${header}${"é".repeat(
          Math.ceil((MAX_HANDOFF_PATCH_BYTES - wireBytes(header) + 1) / 2),
        )}`;
        const atCap = `${header}${"x".repeat(MAX_HANDOFF_PATCH_BYTES - wireBytes(header))}`;
        // Under the cap in raw bytes, over it once JSON-escaped: ESC is six bytes in a request.
        const escapes = `${header}${"\u001b".repeat(MAX_HANDOFF_PATCH_BYTES / 4)}`;
        const before = yield* sql<{ n: number }>`
          SELECT count(*)::int AS n FROM tasks WHERE board_id = ${yield* board}
        `;
        const refused = yield* tasks
          .create({
            boardId: yield* board,
            title: "too big",
            actor: "person:handoff",
            handoff: { patch: over },
          })
          .pipe(Effect.flip);
        const escaped = yield* tasks
          .create({
            boardId: yield* board,
            title: "escape-heavy",
            actor: "person:handoff",
            handoff: { patch: escapes },
          })
          .pipe(Effect.flip);
        const after = yield* sql<{ n: number }>`
          SELECT count(*)::int AS n FROM tasks WHERE board_id = ${yield* board}
        `;
        const fits = yield* tasks.create({
          boardId: yield* board,
          title: "just fits",
          actor: "person:handoff",
          handoff: { patch: atCap },
        });
        const notADiff = yield* tasks
          .create({
            boardId: yield* board,
            title: "not a diff",
            actor: "person:handoff",
            handoff: { patch: "hello\n" },
          })
          .pipe(Effect.flip);
        return {
          refused,
          overBytes: wireBytes(over),
          escaped,
          escapesBytes: wireBytes(escapes),
          made: after[0]!.n - before[0]!.n,
          fits: wireBytes((yield* tasks.handoff(fits.id))?.patch ?? ""),
          notADiff,
        };
      }),
    );
    expect(outcome.refused).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "handoff.patch",
    });
    expect(outcome.refused.message).toBe(
      `the handoff patch is ${outcome.overBytes} bytes as a card carries it, over the ${MAX_HANDOFF_PATCH_BYTES}-byte cap: commit and push the work to a branch and hand off from it (--base), or hand off a smaller change`,
    );
    expect(outcome.escaped.message).toContain(
      `the handoff patch is ${outcome.escapesBytes} bytes as a card carries it`,
    );
    expect(outcome.made).toBe(0);
    expect(outcome.fits).toBe(MAX_HANDOFF_PATCH_BYTES);
    expect(outcome.notADiff).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "handoff.patch",
    });
  }, 60_000);
});
