/**
 * A review or a check of the card's PR reaches the card (C21): a review that requests changes lands
 * on the card's thread once and blocks it `changes_requested`, which the attention view lists; a
 * failing check is a note on the thread; and the next run on the card is told the review in its
 * prompt, its start lifting the block.
 *
 * Real Postgres, a real session service over a git fixture (the card's runs have worktrees), the
 * real task service, and the faux model for the run that is told the review. GitHub is the
 * deliveries alone, per docs/testing-third-parties.md's GitHub row: payloads shaped from GitHub's
 * webhook docs, signed with this file's own secret. Nothing leaves the process.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  MAX_COMMENT_CHARS,
} from "@repo/domain/Task";
import {
  createFauxModelAccess,
  readPromptSections,
  THREAD_SECTION_KEY,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  githubPullRequestFeedback,
  handlePullRequestFeedbackWebhook,
} from "./pullRequestFeedback";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const run = randomBytes(4).toString("hex");
const SECRET = "c21-webhook-secret";
const PERSON = "person:lukas";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-c21-"));
const checkout = mkdtempSync(join(tmpdir(), "factory-c21-repo-"));
execSync(
  "git init -q -b main && git -c user.email=t@t.com -c user.name=t commit -q --allow-empty -m base",
  { cwd: checkout, stdio: "ignore" },
);

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess().access,
        sessionRoot,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);

afterAll(() => runtime.dispose());

let counter = 0;

/**
 * A card in `building` on a board over a fresh repository whose checkout is the fixture, with one run
 * per PR in `prs` (oldest first), each recorded as having opened that PR (`sessions.pr_url`, which
 * the PR step writes).
 */
const cardWithPrs = (prs: ReadonlyArray<string>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const sessions = yield* SessionService;
      const sql = yield* SqlClient;
      counter += 1;
      const repo = RepoSlug.make(`factory-test/c21-${run}-${counter}`);
      yield* sessions.registerRepo({ repo, localPath: checkout });
      const board = yield* tasks.createBoard({
        repo,
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        definitionVersion: 1,
      });
      const card = yield* tasks.create({
        boardId: board.id,
        title: "c21",
        actor: PERSON,
      });
      // Seated in building by the row, as C20's cases seat theirs in review: the walk is not what
      // these cases are about.
      yield* sql`
        UPDATE tasks SET "column" = 'building', revision = 2 WHERE id = ${card.id}
      `;
      const runs: Array<SessionId> = [];
      for (const url of prs) {
        const created = yield* sessions.create({
          repo,
          baseRef: "main",
          taskId: card.id,
          taskColumn: "building",
        });
        yield* sql`UPDATE sessions SET pr_url = ${url} WHERE id = ${created.id}`;
        runs.push(created.id);
      }
      return { taskId: card.id, boardId: board.id, repo, runs };
    }),
  );

const repoPage = `https://github.com/factory-test/c21-${run}`;
const prPage = (number: number) => `${repoPage}/pull/${number}`;
const prApi = (number: number) =>
  `https://api.github.com/repos/factory-test/c21-${run}/pulls/${number}`;

const sign = (raw: string) =>
  `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** One delivery of `event`, signed unless `signature` says otherwise. */
const deliver = (
  event: string,
  payload: unknown,
  options: {
    readonly signature?: (raw: string) => string;
    readonly secret?: string | undefined;
  } = {},
) => {
  const raw = JSON.stringify(payload);
  return runtime.runPromise(
    handlePullRequestFeedbackWebhook({
      secret: "secret" in options ? options.secret : SECRET,
      raw,
      signature: (options.signature ?? sign)(raw),
      event,
    }),
  );
};

const REVIEW_BODY =
  "Please split the migration out.\n  The index must be built CONCURRENTLY — it is a hot table.  ";

/** GitHub's `pull_request_review` submitted body, shaped from its webhook docs. */
const review = (
  number: number,
  state: string,
  body: string | null,
  id = 9000 + number,
) => ({
  action: "submitted",
  review: {
    id,
    user: { login: "alice" },
    body,
    state,
    html_url: `${prPage(number)}#pullrequestreview-${id}`,
    commit_id: "0123456789abcdef0123456789abcdef01234567",
  },
  pull_request: {
    number,
    html_url: prPage(number),
    url: prApi(number),
  },
  repository: { full_name: `factory-test/c21-${run}`, html_url: repoPage },
  sender: { login: "alice" },
});

const HEAD = "fedcba9876543210fedcba9876543210fedcba98";

/** GitHub's `check_run` completed body, on PR `number` at `head`. */
const checkRun = (
  number: number,
  conclusion: string,
  options: { readonly id?: number; readonly prHead?: string } = {},
) => ({
  action: "completed",
  check_run: {
    id: options.id ?? 7000 + number,
    name: "gate",
    head_sha: HEAD,
    status: "completed",
    conclusion,
    html_url: `${repoPage}/runs/${options.id ?? 7000 + number}`,
    output: {
      title: "2 tests failed",
      summary: "card.test.ts: expected 3, got 4",
    },
    check_suite: { id: 5000 + number },
    pull_requests: [
      {
        url: prApi(number),
        number,
        head: { sha: options.prHead ?? HEAD },
      },
    ],
  },
  repository: { full_name: `factory-test/c21-${run}`, html_url: repoPage },
});

const checkSuite = (number: number, conclusion: string) => ({
  action: "completed",
  check_suite: {
    id: 5000 + number,
    head_sha: HEAD,
    conclusion,
    app: { name: "GitHub Actions" },
    pull_requests: [{ url: prApi(number), number, head: { sha: HEAD } }],
  },
  repository: { full_name: `factory-test/c21-${run}`, html_url: repoPage },
});

const card = (taskId: string) =>
  runtime.runPromise(Effect.flatMap(TaskService, (s) => s.get(taskId)));

const thread = (taskId: string) =>
  runtime.runPromise(Effect.flatMap(TaskService, (s) => s.comments(taskId)));

const attention = (boardId: string) =>
  runtime.runPromise(Effect.flatMap(TaskService, (s) => s.attention(boardId)));

describe("reading a review or a check delivery (C21)", () => {
  /** Mutation: block on every review state — an approval would park the card. */
  it("reads a changes_requested review as a note and a block, and an approval or a comment as a note alone", () => {
    const requested = githubPullRequestFeedback(
      "pull_request_review",
      review(1, "changes_requested", REVIEW_BODY),
    );
    expect(requested).toMatchObject({
      _tag: "feedback",
      event: "changes_requested",
      prs: [{ url: prPage(1), apiUrl: prApi(1), number: 1 }],
      note: {
        sourceId: "github:review:9001",
        actor: "github:alice",
        block: { reason: "changes_requested" },
      },
    });
    if (requested?._tag !== "feedback") throw new Error("not feedback");
    // The body verbatim, under a line naming the reviewer, the PR and the commit.
    expect(requested.note.body).toContain(`\n${REVIEW_BODY}`);
    expect(requested.note.body).toContain(
      "Changes requested on pull request #1 by @alice at 0123456789ab",
    );
    expect(requested.note.block?.note).toContain(
      "@alice requested changes on pull request #1",
    );

    const commented = githubPullRequestFeedback(
      "pull_request_review",
      review(1, "commented", "Looks fine apart from the naming."),
    );
    expect(commented).toMatchObject({
      _tag: "feedback",
      event: "review_commented",
    });
    if (commented?._tag !== "feedback") throw new Error("not feedback");
    expect(commented.note.block).toBeUndefined();
    // GitHub sends the state upper-case on some payloads; it is read either way.
    expect(
      githubPullRequestFeedback(
        "pull_request_review",
        review(1, "CHANGES_REQUESTED", "x"),
      ),
    ).toMatchObject({ event: "changes_requested" });
  });

  /** Mutation: drop the marker check — the factory's own reviewer would be echoed onto the card. */
  it("ignores what says nothing the card acts on, and the factory reviewer's own comment", () => {
    expect(
      githubPullRequestFeedback(
        "pull_request_review",
        review(1, "approved", null),
      ),
    ).toMatchObject({ _tag: "ignored" });
    expect(
      githubPullRequestFeedback("pull_request_review", {
        ...review(1, "changes_requested", "x"),
        action: "dismissed",
      }),
    ).toMatchObject({ _tag: "ignored" });
    expect(
      githubPullRequestFeedback(
        "pull_request_review",
        review(
          1,
          "commented",
          "Review of head.\n<!-- factory-review o/r#1 0123456789ab -->",
        ),
      ),
    ).toMatchObject({ _tag: "ignored" });
    expect(
      githubPullRequestFeedback("check_run", checkRun(1, "success")),
    ).toMatchObject({ _tag: "ignored" });
    expect(
      githubPullRequestFeedback("check_run", checkRun(1, "cancelled")),
    ).toMatchObject({ _tag: "ignored" });
    // A failure of a commit the PR has moved past says nothing about the PR as it is.
    expect(
      githubPullRequestFeedback(
        "check_run",
        checkRun(1, "failure", { prHead: "1".repeat(40) }),
      ),
    ).toMatchObject({ _tag: "ignored" });
    // Not the event it says it is: no PR on a review, no id on a check.
    expect(
      githubPullRequestFeedback("pull_request_review", { action: "submitted" }),
    ).toBeUndefined();
    expect(
      githubPullRequestFeedback("check_run", { action: "completed" }),
    ).toBeUndefined();
  });

  it("reads a line comment, a failing check run, its suite and its workflow run", () => {
    const comment = githubPullRequestFeedback("pull_request_review_comment", {
      action: "created",
      comment: {
        id: 31,
        body: "This loop is quadratic.",
        path: "src/card.ts",
        line: 12,
        html_url: `${prPage(1)}#discussion_r31`,
        user: { login: "bob" },
      },
      pull_request: { number: 1, html_url: prPage(1), url: prApi(1) },
    });
    expect(comment).toMatchObject({
      _tag: "feedback",
      event: "review_comment",
      note: { sourceId: "github:review_comment:31", actor: "github:bob" },
    });
    if (comment?._tag !== "feedback") throw new Error("not feedback");
    expect(comment.note.body).toContain("by @bob on src/card.ts:12");
    expect(comment.note.body).toContain("\nThis loop is quadratic.");

    const failed = githubPullRequestFeedback(
      "check_run",
      checkRun(1, "failure"),
    );
    expect(failed).toMatchObject({
      _tag: "feedback",
      event: "check_failed",
      // The page is the repository's own page for the PR, which `sessions.pr_url` records.
      prs: [{ url: prPage(1), apiUrl: prApi(1), number: 1 }],
      note: { sourceId: "github:check_run:5001:7001" },
    });
    if (failed?._tag !== "feedback") throw new Error("not feedback");
    expect(failed.note.block).toBeUndefined();
    expect(failed.note.body).toBe(
      `Check "gate" failed (failure) on fedcba987654 of pull request #1: ${repoPage}/runs/7001\n\n2 tests failed\ncard.test.ts: expected 3, got 4`,
    );

    expect(
      githubPullRequestFeedback("check_suite", checkSuite(1, "failure")),
    ).toMatchObject({
      note: {
        sourceId: "github:check_suite:5001",
        coveredBy: "github:check_run:5001:",
      },
    });
    expect(
      githubPullRequestFeedback("workflow_run", {
        action: "completed",
        workflow_run: {
          id: 44,
          name: "CI",
          head_sha: HEAD,
          conclusion: "timed_out",
          check_suite_id: 5001,
          html_url: `${repoPage}/actions/runs/44`,
          pull_requests: [{ url: prApi(1), number: 1, head: { sha: HEAD } }],
        },
        repository: { html_url: repoPage },
      }),
    ).toMatchObject({
      note: {
        sourceId: "github:check_suite:5001",
        coveredBy: "github:check_run:5001:",
      },
    });
  });
});

describe("a signed review or check delivery reaches the card (C21)", () => {
  /**
   * Mutation: drop the `sourceId` lookup under the lock — the redelivery lands a second comment.
   * Mutation: drop the block — the card never shows in the attention view.
   */
  it("lands a changes_requested review on the card's thread once, blocks it, and lists it in Needs a person", async () => {
    const url = prPage(11);
    const { taskId, boardId } = await cardWithPrs([url]);
    const payload = review(11, "changes_requested", REVIEW_BODY);
    expect(await deliver("pull_request_review", payload)).toEqual({
      status: 200,
      body: {
        ok: true,
        event: "changes_requested",
        feedback: { recorded: 1, blocked: 1 },
      },
    });
    const blocked = await card(taskId);
    expect(blocked).toMatchObject({
      column: "building",
      revision: 4,
      blocked: { reason: "changes_requested", column: "building" },
    });
    expect(blocked.blocked?.note).toContain(
      `@alice requested changes on pull request #11 (${url}#pullrequestreview-9011): Please split the migration out.`,
    );
    const comments = await thread(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "note", actor: "github:alice" });
    expect(comments[0]?.body).toContain(`\n${REVIEW_BODY}`);

    const listed = await attention(boardId);
    expect(listed).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: taskId }),
        reason: {
          _tag: "review",
          review: blocked.blocked?.note,
          since: blocked.blocked?.since,
        },
      }),
    ]);

    // GitHub's redelivery, and a second at once: nothing more lands.
    const again = await Promise.all([
      deliver("pull_request_review", payload),
      deliver("pull_request_review", payload),
    ]);
    for (const answer of again)
      expect(answer.body).toMatchObject({
        feedback: { recorded: 0, blocked: 0 },
      });
    expect(await thread(taskId)).toHaveLength(1);
    expect((await card(taskId)).revision).toBe(4);
  }, 60_000);

  /** Mutation: drop the signature check — an unsigned caller could block any card. */
  it("refuses an unsigned or unconfigured delivery, and a body that is not the event, writing nothing", async () => {
    const url = prPage(12);
    const { taskId } = await cardWithPrs([url]);
    const payload = review(12, "changes_requested", "no");
    expect(
      (
        await deliver("pull_request_review", payload, {
          signature: () => "sha256=00",
        })
      ).status,
    ).toBe(401);
    expect(
      (await deliver("pull_request_review", payload, { secret: undefined }))
        .status,
    ).toBe(503);
    expect(
      (await deliver("pull_request_review", { action: "submitted" })).status,
    ).toBe(400);
    expect(
      (await deliver("pull_request_review", review(12, "approved", null)))
        .status,
    ).toBe(202);
    expect(await thread(taskId)).toEqual([]);
    expect(await card(taskId)).toMatchObject({ revision: 2 });
    expect((await card(taskId)).blocked).toBeUndefined();
  }, 60_000);

  /**
   * Mutation: block on a failing check — the card would be parked for a CI run its own run fixes.
   * Mutation: drop `coveredBy` — the suite's delivery adds a second note for the same failure.
   */
  it("puts a failing check on the card's thread, once across the run, its suite and a redelivery, without blocking it", async () => {
    const url = prPage(13);
    const { taskId } = await cardWithPrs([url]);
    expect(await deliver("check_run", checkRun(13, "failure"))).toMatchObject({
      status: 200,
      body: { event: "check_failed", feedback: { recorded: 1, blocked: 0 } },
    });
    expect(
      (await deliver("check_run", checkRun(13, "failure"))).body,
    ).toMatchObject({ feedback: { recorded: 0 } });
    expect(
      (await deliver("check_suite", checkSuite(13, "failure"))).body,
    ).toMatchObject({ feedback: { recorded: 0 } });
    expect((await deliver("check_run", checkRun(13, "success"))).status).toBe(
      202,
    );
    const comments = await thread(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "note", actor: "github:checks" });
    expect(comments[0]?.body).toContain(
      `Check "gate" failed (failure) on fedcba987654 of pull request #13`,
    );
    const after = await card(taskId);
    expect(after.blocked).toBeUndefined();
    expect(after.revision).toBe(3);

    // A suite whose check runs were never delivered is its own note.
    const lone = prPage(14);
    const other = await cardWithPrs([lone]);
    expect(
      (await deliver("check_suite", checkSuite(14, "failure"))).body,
    ).toMatchObject({ feedback: { recorded: 1, blocked: 0 } });
    expect((await thread(other.taskId))[0]?.body).toBe(
      "The checks of GitHub Actions failed (failure) on fedcba987654 of pull request #14",
    );
  }, 60_000);

  /**
   * Mutation: match every card any of whose runs recorded the PR — a replaced PR's review would land
   * on a card that has moved on to another PR.
   */
  it("leaves a card whose newest PR is another, a finished card, and a card blocked for another reason's block", async () => {
    const { taskId } = await cardWithPrs([prPage(15), prPage(16)]);
    expect(
      (
        await deliver(
          "pull_request_review",
          review(15, "changes_requested", "old"),
        )
      ).body,
    ).toMatchObject({ feedback: { recorded: 0, blocked: 0 } });
    expect(await thread(taskId)).toEqual([]);

    const finished = await cardWithPrs([prPage(17)]);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`UPDATE tasks SET "column" = 'done' WHERE id = ${finished.taskId}`;
      }),
    );
    expect(
      (
        await deliver(
          "pull_request_review",
          review(17, "changes_requested", "late"),
        )
      ).body,
    ).toMatchObject({ feedback: { recorded: 0, blocked: 0 } });

    // A card already waiting on something keeps that block; the review joins its thread.
    const parked = await cardWithPrs([prPage(18)]);
    const before = await card(parked.taskId);
    await runtime.runPromise(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.block({
          taskId: parked.taskId,
          expectedRevision: before.revision,
          reason: "dependency",
          actor: PERSON,
        }),
      ),
    );
    expect(
      (
        await deliver(
          "pull_request_review",
          review(18, "changes_requested", "fix it"),
        )
      ).body,
    ).toMatchObject({ feedback: { recorded: 1, blocked: 0 } });
    expect((await card(parked.taskId)).blocked?.reason).toBe("dependency");
    expect(await thread(parked.taskId)).toHaveLength(1);
  }, 60_000);

  it("clips a review longer than a comment may be, so the thread's budget holds", async () => {
    const { taskId } = await cardWithPrs([prPage(19)]);
    await deliver(
      "pull_request_review",
      review(19, "changes_requested", "x".repeat(MAX_COMMENT_CHARS + 500)),
    );
    const [only] = await thread(taskId);
    expect(only?.body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(only?.body).toContain("[… clipped to the thread's limit]");
  }, 60_000);
});

describe("the next run on the card is told the review (C21)", () => {
  const promptOf = (sessionId: SessionId) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* Effect.acquireUseRelease(
          Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
          (storage) => readPromptSections(storage),
          (storage) => Effect.promise(() => storage.dispose()),
        );
      }),
    );

  const waitUntil = <E, R>(
    check: Effect.Effect<boolean, E, R>,
    label: string,
  ): Effect.Effect<void, E, R> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (yield* check) return;
        yield* Effect.sleep(50);
      }
      return yield* Effect.die(new Error(`timed out waiting for ${label}`));
    });

  /**
   * Mutation: leave `resumeAfterReview` out of `create` — the card stays blocked, and the run's
   * settle would hold its PR push. Mutation: record the review somewhere the thread is not — the
   * run's `task_thread` section would not quote it.
   */
  it("quotes the review verbatim into the next run's prompt, and its start lifts the block", async () => {
    const { taskId, repo } = await cardWithPrs([prPage(21)]);
    await deliver(
      "pull_request_review",
      review(21, "changes_requested", REVIEW_BODY),
    );
    await deliver("check_run", checkRun(21, "failure"));
    expect((await card(taskId)).blocked?.reason).toBe("changes_requested");

    const next = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({
          repo,
          baseRef: "main",
          taskId,
          taskColumn: "building",
          actor: PERSON,
        });
        yield* sessions.send({
          sessionId: created.id,
          content: "address the review",
        });
        yield* waitUntil(
          Effect.map(
            sessions.get(created.id),
            (snapshot) =>
              !snapshot.live.busy &&
              snapshot.entries.some(
                (entry) => entry.kind === "assistant" && entry.text !== "",
              ),
          ),
          "the next run to answer",
        );
        return created.id;
      }),
    );
    const lifted = await card(taskId);
    expect(lifted.blocked).toBeUndefined();
    const unblocked = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ actor: string }>`
          SELECT actor FROM task_events WHERE task_id = ${taskId} AND kind = 'unblocked'
        `;
      }),
    );
    expect(unblocked).toEqual([{ actor: PERSON }]);

    const told = (await promptOf(next))[THREAD_SECTION_KEY] ?? "";
    expect(told).toContain(`\n${REVIEW_BODY}`);
    expect(told).toContain("Changes requested on pull request #21 by @alice");
    expect(told).toContain('Check "gate" failed (failure)');
  }, 120_000);

  /** Mutation: lift every block on a run's start — a dependency a person set would vanish. */
  it("leaves any other block as it is when a run starts", async () => {
    const { taskId, repo } = await cardWithPrs([prPage(22)]);
    const before = await card(taskId);
    await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sessions = yield* SessionService;
        yield* tasks.block({
          taskId,
          expectedRevision: before.revision,
          reason: "dependency",
          actor: PERSON,
        });
        yield* sessions.create({
          repo,
          baseRef: "main",
          taskId,
          taskColumn: "building",
          actor: PERSON,
        });
      }),
    );
    expect((await card(taskId)).blocked?.reason).toBe("dependency");
  }, 60_000);
});
