/**
 * The review trigger (LOB-36): a `pull_request` event on a PR the factory opened from a card starts
 * one read-only reviewer run on that card, at the PR's head, which reviews and posts one comment.
 *
 * Two halves. The pure cases pin what a reviewable event *is* and what its delivery id and branch come
 * to. The end-to-end cases sign a `pull_request` payload the way GitHub does and hand it to the same
 * handler `POST /webhooks/github` runs, over the real seam, the real `SessionService` and Postgres,
 * in a real git checkout whose head commit carries a seeded bug — so "the reviewer's comment names
 * the file and the mechanism", "it runs on the reviewer role's model in a read-only stage", "a
 * redelivery reviews nothing twice" and "a push is reviewed again" are facts about the system. The
 * forge is a recording fake of the post (`reviewPoster`); its HTTP half is `GitHubReview.test.ts`'s.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row this file writes carries a per-run
 * repo slug, so it is safe against a database other suites use.
 */
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  BranchName,
  RepoSlug as RepoSlugSchema,
  type SessionId,
} from "@repo/domain/Session";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId as DefinitionIdSchema,
} from "@repo/domain/Task";
import {
  createFauxModelAccess,
  readOfferedTools,
  readRecordedReview,
  resolveRoleModels,
  type ReviewPosted,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import type { ReviewPostRequest } from "./GitHubReview";
import {
  handlePullRequestReviewWebhook,
  pullRequestUpdate,
  reviewBranch,
  type ReviewFetch,
  reviewToken,
} from "./ReviewTrigger";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const runId = randomBytes(6).toString("hex");
const repo = RepoSlugSchema.make(`acme/review-${runId}`);
const SECRET = "review-webhook-secret";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
    .toString()
    .trim();

/**
 * The repository the PR is in: `main`, then a `feature` head whose commit seeds a bug in
 * `src/sum.ts` — and a second commit on it, the push a `synchronize` reports.
 */
const checkout = mkdtempSync(join(tmpdir(), "review-trigger-repo-"));
git(checkout, "init", "-q", "-b", "main");
mkdirSync(join(checkout, "src"));
writeFileSync(
  join(checkout, "src/sum.ts"),
  "export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n",
);
git(checkout, "add", ".");
git(checkout, "commit", "-q", "-m", "base");
git(checkout, "checkout", "-q", "-b", "feature");
writeFileSync(
  join(checkout, "src/sum.ts"),
  "export const sum = (xs: number[]) => xs.slice(1).reduce((a, b) => a + b, 0);\n",
);
git(checkout, "commit", "-q", "-am", "skip the first element");
const HEAD = git(checkout, "rev-parse", "HEAD");
writeFileSync(join(checkout, "src/sum.test.ts"), "// a test, later\n");
git(checkout, "add", ".");
git(checkout, "commit", "-q", "-m", "add a test file");
const PUSHED = git(checkout, "rev-parse", "HEAD");
git(checkout, "checkout", "-q", "main");

const MECHANISM =
  "`xs.slice(1)` drops the first element before summing, so sum([5]) is 0";
const passing = { verdict: "pass", findings: [] };
const BUG = {
  summary: "Changes how sum folds its input.",
  dimensions: {
    correctness: {
      verdict: "fail",
      findings: [
        { severity: "P0", file: "src/sum.ts", line: 1, mechanism: MECHANISM },
      ],
    },
    security: passing,
    tests: passing,
    performance: passing,
  },
};

/** The forge's view of the PR: which head it is at, and every post it was handed. */
const forge = { head: HEAD, posts: [] as ReviewPostRequest[] };

const faux = createFauxModelAccess({
  fauxModels: ["faux-1", "faux-review"],
  fauxCommand: "git diff --stat main...HEAD",
  fauxReview: [BUG],
});
const sessionRoot = mkdtempSync(join(tmpdir(), "review-trigger-"));
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    SessionServiceLive({
      model: faux.access,
      // The reviewer role runs its own (cheaper) model; every other role the deployment's.
      roleModels: Effect.runSync(
        resolveRoleModels(
          faux.access,
          new Map([["reviewer", "faux/faux-review"]]),
        ),
      ),
      sessionRoot,
      reviewPoster: (request) =>
        Effect.sync((): ReviewPosted => {
          forge.posts.push(request);
          return request.target.head === forge.head
            ? {
                _tag: "posted",
                url: `${request.target.url}#review-${forge.posts.length}`,
              }
            : { _tag: "stale", head: forge.head };
        }),
    }),
    TaskServiceLive,
  ).pipe(
    Layer.provideMerge(DatabaseLive),
    Layer.provideMerge(BunServices.layer),
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionService | TaskService | SqlClient>,
) => runtime.runPromise(effect);

const NUMBER = 7;
/** The PR's page: one PR per case, so each case's heads are its own deliveries. */
const pageOf = (number: number) => `https://github.com/${repo}/pull/${number}`;
const URL = pageOf(NUMBER);

const payload = (
  over: {
    readonly action?: string;
    readonly head?: string;
    readonly headRef?: string;
    readonly baseSha?: string;
    readonly number?: number;
    readonly draft?: boolean;
  } = {},
) => ({
  action: over.action ?? "opened",
  number: over.number ?? NUMBER,
  pull_request: {
    number: over.number ?? NUMBER,
    html_url: pageOf(over.number ?? NUMBER),
    url: `https://api.github.com/repos/${repo}/pulls/${over.number ?? NUMBER}`,
    title: "Skip the first element",
    draft: over.draft ?? false,
    base: {
      ref: "main",
      ...(over.baseSha === undefined ? {} : { sha: over.baseSha }),
    },
    head: {
      ref: over.headRef ?? "feature",
      sha: over.head ?? HEAD,
      repo: { full_name: repo },
    },
  },
  repository: { full_name: repo },
});

const sign = (raw: string) =>
  `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** POST one `pull_request` delivery to the review handler, signed as GitHub signs it. */
const deliver = (body: unknown, signature?: string, fetch?: ReviewFetch) => {
  const raw = JSON.stringify(body);
  return run(
    handlePullRequestReviewWebhook({
      secret: SECRET,
      raw,
      signature: signature ?? sign(raw),
      ...(fetch === undefined ? {} : { fetch }),
    }),
  );
};

/**
 * Where the PR's branch lives when someone other than the factory pushed it: a clone of the checkout
 * whose `pushed-elsewhere` branch has commits the registered checkout has never seen, as a person's
 * push to the PR branch would.
 */
const elsewhere = mkdtempSync(join(tmpdir(), "review-trigger-remote-"));
git(elsewhere, "clone", "-q", checkout, ".");
git(elsewhere, "checkout", "-q", "-b", "pushed-elsewhere", "origin/feature");
writeFileSync(join(elsewhere, "src/sum.ts"), "export const sum = () => 0;\n");
git(elsewhere, "commit", "-q", "-am", "a person's push");
const REMOTE_ONLY = git(elsewhere, "rev-parse", "HEAD");
writeFileSync(join(elsewhere, "src/sum.ts"), "export const sum = () => 1;\n");
git(elsewhere, "commit", "-q", "-am", "another push");
const REMOTE_ONLY_TOO = git(elsewhere, "rev-parse", "HEAD");

/** The fetch a deployment does with `fetchBranch`, here from the clone over a path (no credential). */
const fetchFromElsewhere =
  (fetched: string[]): ReviewFetch =>
  (input) =>
    Effect.try({
      try: () => {
        fetched.push(input.branch);
        git(
          input.localPath,
          "fetch",
          "-q",
          elsewhere,
          `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
        );
      },
      catch: (cause) => ({ message: String(cause) }),
    });

/** Wait until `sessionId` has settled with a recorded verdict, then read what its log holds. */
const settled = (sessionId: SessionId) =>
  run(
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const sql = yield* SqlClient;
      const read = Effect.acquireUseRelease(
        Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
        (storage) =>
          Effect.all({
            review: readRecordedReview(storage),
            offered: readOfferedTools(storage),
          }),
        (storage) => Effect.promise(() => storage.dispose()),
      );
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const snapshot = yield* sessions.get(sessionId);
        const log = yield* read;
        if (!snapshot.live.busy && log.review?.outcome !== undefined)
          return { snapshot, ...log };
        yield* Effect.sleep(50);
      }
      return yield* Effect.die(
        new Error(`${sessionId} never settled a review`),
      );
    }),
  );

/** The card the PR came from: a building run on it whose session recorded the PR's page. */
const cardWithPr = (url: string) =>
  run(
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const sessions = yield* SessionService;
      const sql = yield* SqlClient;
      yield* sessions.registerRepo({ repo, localPath: checkout });
      const board = yield* tasks.createBoard({
        repo: RepoSlugSchema.make(
          `factory-test/review-${randomBytes(3).toString("hex")}`,
        ),
        definitionId: DefinitionIdSchema.make(DEFAULT_DEFINITION_ID),
      });
      const card = yield* tasks.create({
        boardId: board.id,
        title: "skip the first element",
        actor: "person:lukas",
      });
      const builder = yield* sessions.create({
        title: "build it",
        taskId: card.id,
        taskColumn: "building",
      });
      yield* sql`UPDATE sessions SET pr_url = ${url} WHERE id = ${builder.id}`;
      return { card, builder };
    }),
  );

/** The task_runs row of a session: which card, which column. */
const runRow = (sessionId: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ taskId: string; column: string }>`
        SELECT task_id, "column" FROM task_runs WHERE session_id = ${sessionId}
      `;
      return rows[0];
    }),
  );

describe("a reviewable pull_request event", () => {
  it("reads the PR, its base and its head, and names the run after the head", () => {
    const update = pullRequestUpdate(payload());
    expect(update).toEqual({
      action: "opened",
      repo,
      number: NUMBER,
      url: URL,
      apiUrl: `https://api.github.com/repos/${repo}/pulls/${NUMBER}`,
      title: "Skip the first element",
      base: "main",
      head: HEAD,
      headRef: "feature",
      headInRepo: true,
      draft: false,
    });
    if (update === undefined) return;
    expect(reviewToken(update)).toBe(
      `review-acme-review-${runId}-${NUMBER}-${HEAD}`,
    );
    expect(reviewBranch(update)).toBe(
      `factory/review-${NUMBER}-${HEAD.slice(0, 12)}`,
    );
  });

  it("is not a payload that names no head commit, no base, or no repository", () => {
    const body = payload();
    for (const broken of [
      { ...body, pull_request: { ...body.pull_request, head: { sha: "abc" } } },
      { ...body, pull_request: { ...body.pull_request, base: {} } },
      { ...body, repository: {} },
      { action: "opened" },
    ]) {
      expect(pullRequestUpdate(broken)).toBeUndefined();
    }
  });
});

describe("the review a pull_request event starts", () => {
  it("runs a read-only reviewer on the card, on the reviewer's model, which posts one comment naming the file and the mechanism", async () => {
    const { card } = await cardWithPr(URL);
    const answer = await deliver(payload());
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true,
      status: "processed",
      replayed: false,
      head: HEAD,
    });
    const sessionId = answer.body["sessionId"] as SessionId;

    // The reviewer is a run of the PR's card, in its reviewer column.
    expect(await runRow(sessionId)).toEqual({
      taskId: card.id,
      column: "review",
    });
    const reviewed = await settled(sessionId);
    // Its worktree is the PR's head, on a branch of its own.
    expect(reviewed.snapshot.workspace.branch).toBe(
      `factory/review-${NUMBER}-${HEAD.slice(0, 12)}`,
    );
    expect(git(reviewed.snapshot.workspace.path, "rev-parse", "HEAD")).toBe(
      HEAD,
    );
    // Read-only plus comment: it is offered no write, edit or verify, and it is offered the review.
    expect(reviewed.offered).toContain("review");
    for (const tool of ["write", "edit", "verify"]) {
      expect(reviewed.offered).not.toContain(tool);
    }
    // The cheaper model: the reviewer role's, not the deployment's.
    expect(reviewed.snapshot.usage.models.map((entry) => entry.key)).toEqual([
      "faux/faux-review",
    ]);
    expect(reviewed.review).toEqual({
      target: { repo, number: NUMBER, url: URL, base: "main", head: HEAD },
      verdict: "fail",
      outcome: "posted",
      outcomeDetail: `${URL}#review-1`,
    });
    const mine = forge.posts.filter((post) => post.target.url === URL);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.body).toContain("`src/sum.ts:1`");
    expect(mine[0]?.body).toContain(MECHANISM);

    // GitHub redelivers the same event: the head already has its run, so nothing is reviewed twice.
    const again = await deliver(payload());
    expect(again.body).toMatchObject({ status: "processed", replayed: true });
    const reopened = await deliver(payload({ action: "reopened" }));
    expect(reopened.body).toMatchObject({ replayed: true });
    expect(forge.posts.filter((post) => post.target.url === URL)).toHaveLength(
      1,
    );
  }, 120_000);

  it("reviews the new head after a push, and the old run's verdict names the head it saw", async () => {
    const number = 8;
    const url = pageOf(number);
    await cardWithPr(url);
    const first = await deliver(payload({ number }));
    const firstId = first.body["sessionId"] as SessionId;
    await settled(firstId);

    forge.head = PUSHED;
    const pushed = await deliver(
      payload({ number, action: "synchronize", head: PUSHED }),
    );
    expect(pushed.body).toMatchObject({
      status: "processed",
      replayed: false,
      head: PUSHED,
    });
    const secondId = pushed.body["sessionId"] as SessionId;
    expect(secondId).not.toBe(firstId);
    const second = await settled(secondId);
    expect(second.review?.target.head).toBe(PUSHED);
    expect(git(second.snapshot.workspace.path, "rev-parse", "HEAD")).toBe(
      PUSHED,
    );
    const posts = forge.posts.filter((post) => post.target.url === url);
    expect(posts.map((post) => post.target.head)).toEqual([HEAD, PUSHED]);
    // One marker per head: the second comment is not the first one again.
    expect(posts[0]?.marker).not.toBe(posts[1]?.marker);
    forge.head = HEAD;
  }, 120_000);

  it("posts nothing for a head the PR has already left", async () => {
    const number = 9;
    const url = pageOf(number);
    await cardWithPr(url);
    // The forge is already at the pushed head when the review of the old one posts.
    forge.head = PUSHED;
    const answer = await deliver(payload({ number }));
    const reviewed = await settled(answer.body["sessionId"] as SessionId);
    expect(reviewed.review).toMatchObject({
      outcome: "stale",
      outcomeDetail: PUSHED,
    });
    forge.head = HEAD;
  }, 120_000);

  it("is still a review when another process reopens it: the stage comes back from the log", async () => {
    const number = 13;
    await cardWithPr(pageOf(number));
    const answer = await deliver(payload({ number }));
    const sessionId = answer.body["sessionId"] as SessionId;
    await settled(sessionId);
    // This process lets go of every log it owns, as a shutdown does, so another can own it.
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );

    // A second process — a restart — whose faux model tries to write in the reviewer's worktree.
    // It serves the model the run was pinned to (B6: a faux run needs its id published).
    const writer = createFauxModelAccess({
      fauxModels: ["faux-1", "faux-review"],
      fauxCommand: "touch pwned.ts",
      fauxEveryTurn: true,
    });
    const restarted = ManagedRuntime.make(
      SessionServiceLive({
        model: writer.access,
        roleModels: Effect.runSync(
          resolveRoleModels(
            writer.access,
            new Map([["reviewer", "faux/faux-review"]]),
          ),
        ),
        sessionRoot,
      }).pipe(
        Layer.provideMerge(DatabaseLive),
        Layer.provideMerge(BunServices.layer),
      ),
    );
    try {
      const refused = await restarted.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          yield* sessions.send({ sessionId, content: "now fix it yourself" });
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const snapshot = yield* sessions.get(sessionId);
            const results = snapshot.entries.filter(
              (entry) =>
                entry.kind === "toolResult" && entry.toolName === "bash",
            );
            if (!snapshot.live.busy && results.length >= 2)
              return results.at(-1)?.text ?? "";
            yield* Effect.sleep(50);
          }
          return "never answered";
        }),
      );
      expect(refused).toContain("read-only reviewing stage");
    } finally {
      await restarted.dispose();
    }
  }, 120_000);

  it("fetches a head nobody committed here, then reviews it; with no way to fetch it, skips naming the commit", async () => {
    const number = 14;
    await cardWithPr(pageOf(number));
    // No fetch: the head is not in the checkout, so nothing is started and the answer says why.
    const unfetched = await deliver(
      payload({
        number,
        action: "synchronize",
        head: REMOTE_ONLY,
        headRef: "pushed-elsewhere",
      }),
    );
    expect(unfetched.status).toBe(200);
    expect(unfetched.body).toMatchObject({ status: "skipped" });
    expect(String(unfetched.body["reason"])).toContain(
      `head ${REMOTE_ONLY.slice(0, 12)} is not in the registered checkout`,
    );

    // With the fetch a deployment has, the head's branch is brought here and the run is cut at it.
    const fetched: string[] = [];
    const answer = await deliver(
      payload({
        number,
        action: "synchronize",
        head: REMOTE_ONLY_TOO,
        headRef: "pushed-elsewhere",
      }),
      undefined,
      fetchFromElsewhere(fetched),
    );
    expect(answer.body).toMatchObject({
      status: "processed",
      head: REMOTE_ONLY_TOO,
    });
    expect(fetched).toEqual(["pushed-elsewhere"]);
    const reviewed = await settled(answer.body["sessionId"] as SessionId);
    expect(git(reviewed.snapshot.workspace.path, "rev-parse", "HEAD")).toBe(
      REMOTE_ONLY_TOO,
    );
  }, 120_000);

  it("measures the change against the base commit the event names, not the local base branch", async () => {
    const number = 15;
    await cardWithPr(pageOf(number));
    const baseSha = git(checkout, "rev-parse", "main");
    const answer = await deliver(payload({ number, baseSha }));
    const reviewed = await settled(answer.body["sessionId"] as SessionId);
    expect(reviewed.review?.target.base).toBe(baseSha);
    const posted = forge.posts.find(
      (post) => post.target.url === pageOf(number),
    );
    expect(posted?.body).toContain(`against \`${baseSha.slice(0, 12)}\``);
  }, 120_000);

  it("a retried create repairs a review session whose first attempt died before its target was written", async () => {
    const number = 16;
    const { card } = await cardWithPr(pageOf(number));
    const update = pullRequestUpdate(payload({ number }));
    if (update === undefined) throw new Error("the payload does not read");
    const requestId = `trigger:${reviewToken(update)}`;
    const target = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        // The first attempt: its row, its run and its owner, and no review target in its log.
        const first = yield* sessions.create({
          requestId,
          repo,
          baseRef: HEAD,
          branch: BranchName.make(reviewBranch(update)),
          taskId: card.id,
          taskColumn: "review",
        });
        // The process dies here; another takes the retry.
        yield* sessions.close;
        const retried = yield* sessions.create({
          requestId,
          repo,
          baseRef: HEAD,
          branch: BranchName.make(reviewBranch(update)),
          taskId: card.id,
          taskColumn: "review",
          review: { number, url: pageOf(number), base: "main", head: HEAD },
        });
        expect(retried.id).toBe(first.id);
        return yield* Effect.acquireUseRelease(
          Effect.promise(() => PostgresStorage.reader(sql, first.id)),
          (storage) => readRecordedReview(storage),
          (storage) => Effect.promise(() => storage.dispose()),
        );
      }),
    );
    expect(target?.target).toEqual({
      repo,
      number,
      url: pageOf(number),
      base: "main",
      head: HEAD,
    });
  }, 120_000);

  it("starts nothing for a PR the factory did not open, a draft, or an action that is not a review's", async () => {
    const notOurs = await deliver(payload({ number: 10 }));
    expect(notOurs.body).toMatchObject({ status: "skipped" });
    expect(String(notOurs.body["reason"])).toContain(
      "is not a pull request the factory opened",
    );

    const number = 11;
    const url = pageOf(number);
    await cardWithPr(url);
    const draft = await deliver(payload({ number, draft: true }));
    expect(draft.body).toMatchObject({ status: "skipped" });
    expect(String(draft.body["reason"])).toContain("is a draft");
    const closed = await deliver(payload({ number, action: "closed" }));
    expect(closed.body).toMatchObject({ status: "ignored" });
    expect(forge.posts.some((post) => post.target.url === url)).toBe(false);
  });

  it("starts nothing for a PR whose session is a run of no card", async () => {
    const number = 12;
    const url = pageOf(number);
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const scratch = yield* sessions.create({ title: "no card" });
        yield* sql`UPDATE sessions SET pr_url = ${url} WHERE id = ${scratch.id}`;
      }),
    );
    const answer = await deliver(payload({ number }));
    expect(answer.body).toMatchObject({ status: "skipped" });
    expect(String(answer.body["reason"])).toContain(
      "which is a run of no card",
    );
  });

  it("refuses an unsigned delivery and one it cannot read, starting nothing", async () => {
    expect((await deliver(payload(), "sha256=00")).status).toBe(401);
    const raw = JSON.stringify({ action: "opened" });
    const unreadable = await run(
      handlePullRequestReviewWebhook({
        secret: SECRET,
        raw,
        signature: sign(raw),
      }),
    );
    expect(unreadable.status).toBe(400);
    const unconfigured = await run(
      handlePullRequestReviewWebhook({
        secret: undefined,
        raw,
        signature: sign(raw),
      }),
    );
    expect(unconfigured.status).toBe(503);
  });
});
