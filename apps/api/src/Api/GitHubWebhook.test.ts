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
 * The session service is the real one on Postgres, in a database this file creates on the server
 * `DATABASE_URL` names and drops in `afterAll`, as `../Rpc/Session.test.ts` does.
 */
import { createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialProvider,
  LinearIssueSync,
  LinearSyncError,
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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubWebhookLive } from "./GitHubWebhook";

const SECRET = "lob-268-webhook-secret";
const saved = process.env["GITHUB_WEBHOOK_SECRET"];

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-gh-"));
const checkout = mkdtempSync(join(tmpdir(), "factory-api-gh-repo-"));
const run = randomBytes(4).toString("hex");
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
  Effect.context<SessionService | SqlClient>(),
);
const { handler, dispose } = HttpRouter.toWebHandler(
  GitHubWebhookLive.pipe(Layer.provideMerge(services)),
  { disableLogger: true, memoMap: runtime.memoMap },
);

afterAll(async () => {
  await dispose();
  await runtime.dispose();
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
  effect: Effect.Effect<A, E, SessionService | SqlClient>,
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
