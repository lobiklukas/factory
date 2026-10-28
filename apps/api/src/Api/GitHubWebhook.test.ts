/* oxlint-disable effecttsgo/process-env */
/**
 * `POST /webhooks/github`'s merge teardown, served in-process (LOB-268).
 *
 * The merge of a PR the factory opened is a terminal event: its sessions' worktrees and branches,
 * and its reviewer runs', are torn down. The teardown is the route's to wire, so these cases POST a
 * signed delivery to the app's own `GitHubWebhookLive` through `HttpRouter.toWebHandler` and read
 * the result off the checkout, rather than calling `releaseMergedPullRequest` as the core suite
 * does.
 *
 * - **A failed Linear mirror does not keep the workspaces.** The mirror answers `500` when its
 *   write-back fails, and GitHub does not redeliver a failed delivery by itself, so a teardown that
 *   waited for a `200` would leave the worktree and branch behind for good. The sync here fails every
 *   merge it is asked to mirror.
 * - **An unsigned merge tears nothing down**, because the signature is what the release is gated on.
 *
 * `issues` and `issue_comment` (LOB-259) are the same route's second job: a signed `factory` label
 * or `@factory` mention reaches the real trigger seam on this database and opens one session, and the
 * issue gets one comment from the real `GitHubWriteBack` — posted to a loopback GitHub this file
 * serves, because the write-back is wired in the route's own layer and must be proven wired.
 *
 * The session service is the real one on Postgres, in a database this file creates on the server
 * `DATABASE_URL` names and drops in `afterAll`, as `../Rpc/Session.test.ts` does.
 */
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialProvider,
  LinearIssueSync,
  LinearSyncError,
  PlanFreshnessPasses,
  PlanFreshnessPassesLive,
  SessionService,
  SessionServiceLive,
} from "@repo/core";
import { BranchName, RepoSlug, type SessionId } from "@repo/domain/Session";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive, PostgresLive } from "@repo/storage-postgres";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GitHubWebhookLive } from "./GitHubWebhook";

/**
 * The mapping the route reads once, when `./Webhook` loads, so it is set before the imports run: the
 * `factory` label maps to this file's own repo, which the cases register.
 */
const { run } = await vi.hoisted(async () => {
  const { randomBytes } = await import("node:crypto");
  const run = randomBytes(4).toString("hex");
  process.env["TRIGGER_RULES"] = JSON.stringify([
    {
      label: "factory",
      repo: `acme/gh-merge-${run}`,
      baseRef: "main",
      prompt: "Work on {{title}}: {{body}}",
    },
  ]);
  return { run };
});

const SECRET = "lob-268-webhook-secret";
const saved = process.env["GITHUB_WEBHOOK_SECRET"];

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-gh-"));
const checkout = mkdtempSync(join(tmpdir(), "factory-api-gh-repo-"));
const repo = RepoSlug.make(`acme/gh-merge-${run}`);

const git = (cwd: string, command: string) =>
  execSync(command, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
git(checkout, "git init -b main");
git(
  checkout,
  "git -c user.email=t@t.com -c user.name=t commit -q --allow-empty -m base",
);

/** The sha a branch names in the checkout, or `undefined` once it is gone. */
const branchSha = (branch: string): string | undefined => {
  try {
    return git(checkout, `git rev-parse --verify --quiet ${branch}`);
  } catch {
    return undefined;
  }
};

/**
 * A loopback GitHub that answers the two calls `GitHubWriteBack` makes — the issue's comments, and
 * a new one — and keeps what was posted. It is up, and `GITHUB_API_URL` points at it, before the
 * route's layer is built: `toWebHandler` builds it when it is called, and the write-back reads the
 * variable then. Nothing in this file may reach the real GitHub.
 */
const posted: Array<{ readonly path: string; readonly body: string }> = [];
const savedApiUrl = process.env["GITHUB_API_URL"];
const loopback: Server = createServer((request, response) => {
  const chunks: Array<Buffer> = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly body: string;
      };
      posted.push({ path, body: body.body });
      response.statusCode = 201;
      response.end(JSON.stringify({ id: posted.length }));
      return;
    }
    response.end(
      JSON.stringify(
        posted
          .filter((comment) => comment.path === path)
          .map((comment) => ({ body: comment.body })),
      ),
    );
  });
});
// oxlint-disable-next-line effecttsgo/new-promise -- a node:http server's `listen` takes a callback.
await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
{
  const address = loopback.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
  process.env["GITHUB_API_URL"] = `http://127.0.0.1:${port}`;
}

/**
 * The run's own database, on the server `DATABASE_URL` names, and `DATABASE_URL` pointed at it.
 *
 * The order matters: in effect 4.0.0 the default `ConfigProvider` is a copy of `process.env` taken
 * at the first config read in the process (`packages/core/src/SessionService.test.ts` explains it),
 * so the variable is reassigned before anything resolves a config, and the maintenance client that
 * creates and drops the database reads the configured URL from a provider of its own, not from the
 * environment.
 */
const configuredUrl =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const scratchName = `factory_api_gh_${run}`;
{
  const scratch = new URL(configuredUrl);
  scratch.pathname = `/${scratchName}`;
  // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
  process.env["DATABASE_URL"] = scratch.toString();
}
const admin = ManagedRuntime.make(
  PostgresLive.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ DATABASE_URL: configuredUrl }),
      ),
    ),
  ),
);
await admin.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`CREATE DATABASE ${sql(scratchName)}`;
  }),
);

/** Every merge the mirror was asked to write; each one failed. */
const mirrored: Array<string> = [];

const failingSync = LinearIssueSync.of({
  started: () => Effect.void,
  pullRequestOpened: () => Effect.void,
  failed: () => Effect.void,
  // The webhook never creates issues (LOB-202's children are the session layer's).
  createChild: () => Effect.die("the webhook does not create issues"),
  blocks: () => Effect.die("the webhook does not relate issues"),
  // Nor reads or changes a plan (LOB-45's pass is off by default, and writes no tracker when on).
  children: () => Effect.die("the webhook does not read a plan"),
  rescope: () => Effect.die("the webhook does not re-scope issues"),
  close: () => Effect.die("the webhook does not close issues"),
  merged: (input) =>
    Effect.suspend(() => {
      mirrored.push(input.issueId);
      return Effect.fail(
        new LinearSyncError({
          issueId: input.issueId,
          operation: "merged",
          message: "linear is down",
          transient: true,
        }),
      );
    }),
});

const services = Layer.mergeAll(
  Layer.succeed(LinearIssueSync, failingSync),
  // The process's plan-freshness passes (LOB-45): the route hands each claimed pass to it.
  PlanFreshnessPassesLive,
  Layer.succeed(
    CredentialProvider,
    CredentialProvider.of({
      source: "static-token",
      tokenFor: () => Effect.succeed(Redacted.make("gh-test-token")),
    }),
  ),
).pipe(
  Layer.provideMerge(
    SessionServiceLive({
      model: createFauxModelAccess().access,
      sessionRoot,
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
);

// One session service for the cases and the route: the handler shares the runtime's memo map, so
// `services` is built once, and the owner a case opens is the one the route's release closes.
const runtime = ManagedRuntime.make(services);
const context = await runtime.runPromise(
  Effect.context<SessionService | SqlClient | PlanFreshnessPasses>(),
);
const { handler, dispose } = HttpRouter.toWebHandler(
  GitHubWebhookLive.pipe(Layer.provideMerge(services)),
  { disableLogger: true, memoMap: runtime.memoMap },
);

afterAll(async () => {
  await dispose();
  await runtime.dispose();
  // oxlint-disable-next-line effecttsgo/new-promise -- a node:http server's `close` takes a callback.
  await new Promise<void>((resolve) => loopback.close(() => resolve()));
  if (savedApiUrl === undefined) delete process.env["GITHUB_API_URL"];
  else process.env["GITHUB_API_URL"] = savedApiUrl;
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DROP DATABASE IF EXISTS ${sql(scratchName)} WITH (FORCE)`;
    }),
  );
  await admin.dispose();
  rmSync(sessionRoot, { recursive: true, force: true });
  rmSync(checkout, { recursive: true, force: true });
});

beforeEach(() => {
  process.env["GITHUB_WEBHOOK_SECRET"] = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env["GITHUB_WEBHOOK_SECRET"];
  else process.env["GITHUB_WEBHOOK_SECRET"] = saved;
});

const inService = <A, E>(
  effect: Effect.Effect<A, E, SessionService | SqlClient | PlanFreshnessPasses>,
) => Effect.runPromise(Effect.provideContext(effect, context));

/**
 * A session that opened PR `number`, delegated from a Linear issue (so the mirror writes to it),
 * and a reviewer run on that PR's head: both with a worktree and a branch in the checkout.
 */
const mergedPrSessions = (number: number) =>
  inService(
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const sql = yield* SqlClient;
      yield* sessions.registerRepo({ repo, localPath: checkout });
      const opener = yield* sessions.create({
        title: "the work",
        repo,
        baseRef: "main",
        requestId: `trigger:linear:LOB-${number}:mapped`,
      });
      const url = `https://github.com/${repo}/pull/${number}`;
      yield* sql`UPDATE sessions SET pr_url = ${url} WHERE id = ${opener.id}`;
      const reviewer = yield* sessions.create({
        title: "the review",
        repo,
        baseRef: "main",
        branch: BranchName.make(`factory/review-${number}-0123456789ab`),
      });
      const workspaceOf = (id: SessionId) =>
        Effect.map(sessions.get(id), (snapshot) => ({
          path: snapshot.workspace.path,
          branch: snapshot.workspace.branch ?? "",
        }));
      return {
        url,
        opener: yield* workspaceOf(opener.id),
        reviewer: yield* workspaceOf(reviewer.id),
      };
    }),
  );

const deliver = (
  body: unknown,
  sign: (raw: string) => string = (raw) =>
    `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
) => {
  const raw = JSON.stringify(body);
  return handler(
    new Request("http://factory.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    }),
  );
};

const merge = (number: number, url: string) => ({
  action: "closed",
  pull_request: { number, html_url: url, merged: true },
});

describe("POST /webhooks/github tears a merged PR's workspaces down (LOB-268)", () => {
  it("releases the PR's session and its reviewer run even when the Linear mirror fails", async () => {
    const work = await mergedPrSessions(41);
    expect(branchSha(work.opener.branch)).toBeDefined();
    expect(branchSha(work.reviewer.branch)).toBeDefined();

    const response = await deliver(merge(41, work.url));

    // The mirror's failure is still the answer, so GitHub's delivery log shows it.
    expect(response.status).toBe(500);
    expect(mirrored).toContain("LOB-41");
    // And the merge still tore down both workspaces.
    for (const workspace of [work.opener, work.reviewer]) {
      expect(existsSync(workspace.path)).toBe(false);
      expect(branchSha(workspace.branch)).toBeUndefined();
    }
  }, 120_000);

  it("tears nothing down for a merge whose signature is wrong", async () => {
    const work = await mergedPrSessions(42);

    const response = await deliver(merge(42, work.url), () => "sha256=00");

    expect(response.status).toBe(401);
    for (const workspace of [work.opener, work.reviewer]) {
      expect(existsSync(workspace.path)).toBe(true);
      expect(branchSha(workspace.branch)).toBeDefined();
    }
  }, 120_000);
});

describe("POST /webhooks/github reads the plan again after a merge (LOB-45)", () => {
  const savedCadence = process.env["PLAN_FRESHNESS"];
  afterEach(() => {
    if (savedCadence === undefined) delete process.env["PLAN_FRESHNESS"];
    else process.env["PLAN_FRESHNESS"] = savedCadence;
  });

  it("runs no pass and says nothing of one when the cadence is unset or does not read", async () => {
    for (const [number, cadence] of [
      [44, undefined],
      [45, "always"],
    ] as const) {
      if (cadence === undefined) delete process.env["PLAN_FRESHNESS"];
      else process.env["PLAN_FRESHNESS"] = cadence;
      const work = await mergedPrSessions(number);
      const response = await deliver(merge(number, work.url));
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("planFreshness");
      const claims = await inService(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql`
            SELECT request_id FROM webhook_deliveries
            WHERE request_id LIKE ${`plan-freshness:%:${work.url}`}
          `;
        }),
      );
      expect(claims).toEqual([]);
    }
  }, 120_000);

  it("claims a pass per spec of record with PLAN_FRESHNESS=merged, answers before it runs, and the pass runs on", async () => {
    process.env["PLAN_FRESHNESS"] = "merged";
    const work = await mergedPrSessions(46);
    const response = await deliver(merge(46, work.url));
    const body = (await response.json()) as Record<string, unknown>;
    // The answer does not wait on the pass: it was claimed and handed to the process's passes.
    expect(body["planFreshness"]).toMatchObject({
      status: "merged",
      passes: [{ outcome: "accepted" }],
    });
    // The pass runs to its outcome past the answer: the opener holds no spec, so it is refused
    // before any call, and the refusal is the claim's recorded outcome.
    const claims = await inService(
      Effect.gen(function* () {
        yield* (yield* PlanFreshnessPasses).idle;
        const sql = yield* SqlClient;
        return yield* sql<{
          readonly status: string;
          readonly skipReason: string | null;
        }>`
          SELECT status, skip_reason FROM webhook_deliveries
          WHERE request_id LIKE ${`plan-freshness:%:${work.url}`}
        `;
      }),
    );
    expect(claims).toMatchObject([{ status: "skipped" }]);
    expect(claims[0]?.skipReason).toContain("no spec");
    // A redelivery of the merge claims nothing.
    const again = await deliver(merge(46, work.url));
    expect(
      ((await again.json()) as Record<string, unknown>)["planFreshness"],
    ).toMatchObject({ passes: [{ outcome: "replayed" }] });
  }, 120_000);
});

const deliverEvent = (
  event: "issues" | "issue_comment",
  body: unknown,
  secret: string = SECRET,
) => {
  const raw = JSON.stringify(body);
  return handler(
    new Request("http://factory.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      body: raw,
    }),
  );
};

const labeledIssue = (number: number, labels = ["factory"]) => ({
  action: "opened",
  issue: {
    number,
    title: "The widget wobbles",
    body: "It wobbles when it spins.",
    labels: labels.map((name) => ({ name })),
  },
  repository: { full_name: repo },
});

const mentioned = (number: number) => ({
  action: "created",
  issue: { number, title: "The widget wobbles", body: "", labels: [] },
  comment: {
    body: "@factory take this",
    user: { login: "alice", type: "User" },
    author_association: "MEMBER",
  },
  sender: { login: "alice", type: "User" },
  repository: { full_name: repo },
});

describe("POST /webhooks/github opens a session from an issue (LOB-259)", () => {
  it("is 503 for an issue event when no secret is set, before anything is read or written", async () => {
    delete process.env["GITHUB_WEBHOOK_SECRET"];
    // Signed with the empty key, which is what an unset secret degrades to.
    const response = await deliverEvent("issues", labeledIssue(70), "");
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).toContain(
      "GITHUB_WEBHOOK_SECRET",
    );
    expect(posted).toEqual([]);
  });

  it("is 401 for an issue event with a wrong signature, and opens nothing", async () => {
    const response = await deliverEvent("issues", labeledIssue(71), "another");
    expect(response.status).toBe(401);
    expect(posted).toEqual([]);
  });

  it("opens one session for a factory label and comments its link once, however often it is delivered", async () => {
    await inService(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({ repo, localPath: checkout });
      }),
    );
    const first = await deliverEvent("issues", labeledIssue(72));
    const firstBody = (await first.json()) as {
      status: string;
      replayed: boolean;
      sessionId: string;
    };
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ status: "processed", replayed: false });
    expect(firstBody.sessionId).toBeDefined();

    // GitHub's own twin of the opened delivery, a redelivery, and a mention on the same issue.
    const twin = await deliverEvent("issues", {
      ...labeledIssue(72),
      action: "labeled",
    });
    const redelivered = await deliverEvent("issues", labeledIssue(72));
    const asked = await deliverEvent("issue_comment", mentioned(72));
    for (const response of [twin, redelivered, asked]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ replayed: true });
    }

    const comments = posted.filter((comment) =>
      comment.path.endsWith("/issues/72/comments"),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.path).toBe(`/repos/${repo}/issues/72/comments`);
    expect(comments[0]?.body).toContain(firstBody.sessionId);
    const count = await inService(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM sessions
          WHERE repo = ${repo} AND request_id = ${`trigger:github:${repo}#72:mapped`}
        `;
      }),
    );
    expect(count[0]?.count).toBe(1);
  }, 120_000);

  it("opens a session for an @factory mention on an issue with no label", async () => {
    const response = await deliverEvent("issue_comment", mentioned(73));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "processed",
      replayed: false,
    });
    expect(
      posted.filter((comment) => comment.path.endsWith("/issues/73/comments")),
    ).toHaveLength(1);
  }, 120_000);

  it("records an unmapped label as skipped, opens no session and comments nothing", async () => {
    const before = posted.length;
    const response = await deliverEvent("issues", labeledIssue(74, ["bug"]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "skipped",
      reason: "no rule matches labels [bug]",
    });
    expect(posted).toHaveLength(before);
  });

  it("answers an issue edit with 202 and starts nothing", async () => {
    const before = posted.length;
    const response = await deliverEvent("issues", {
      ...labeledIssue(75),
      action: "edited",
    });
    expect(response.status).toBe(202);
    expect(posted).toHaveLength(before);
  });
});
