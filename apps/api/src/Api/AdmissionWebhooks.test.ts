/* oxlint-disable effecttsgo/process-env */
/**
 * A trigger delivery that finds the server at capacity (LOB-70), served in-process.
 *
 * With `SESSION_MAX_CONCURRENT` reached, a delivery that would open a session is a "not now", not a
 * fault: the route answers `503` with `Retry-After` and `code: "at-capacity"` — never the `500` a
 * failed session create gets — and the seam releases its claim, so the `webhook_deliveries` row is
 * not left `processed` (nor `received`, which would answer the retry as an in-flight replay). Once a
 * slot frees, the sender's redelivery of the *same* delivery is processed and opens its session.
 *
 * Three routes, the ones no person starts: the generic and Linear trigger routes (`./Webhook`'s
 * production seam, `webhookLiveFor`) and GitHub's docs `push` (`./GitHubWebhook`). Each is driven
 * through the app's own route over the real session service on Postgres, capped at one session,
 * in a database this file creates on the server `DATABASE_URL` names and drops in `afterAll`, as
 * `./GitHubWebhook.test.ts` does. The one slot is held by a session the case opens itself, and
 * freed by `close` — the release every owner gets, which is what the idle sweep calls per owner.
 */
import { createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialProvider,
  LinearIssueSync,
  PlanFreshnessPassesLive,
  SessionService,
  SessionServiceLive,
} from "@repo/core";
import { RepoSlug } from "@repo/domain/Session";
import type { TriggerRule } from "@repo/domain/Trigger";
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
import { webhookLiveFor } from "./Webhook";

const run = randomBytes(4).toString("hex");
const repo = RepoSlug.make(`acme/admission-${run}`);
const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo,
    baseRef: "main",
    prompt: "Work on {{title}}: {{body}}",
  },
];

const SECRETS = {
  TRIGGER_SECRET: "lob-70-generic-secret",
  LINEAR_WEBHOOK_SECRET: "lob-70-linear-secret",
  GITHUB_WEBHOOK_SECRET: "lob-70-github-secret",
} as const;
const saved = new Map(
  Object.keys(SECRETS).map((name) => [name, process.env[name]]),
);

/** The repo the rule maps to and the docs push names: a checkout on `main` the registry points at. */
const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-admission-"));
const checkout = mkdtempSync(join(tmpdir(), "factory-api-admission-repo-"));
execSync("git init -b main", { cwd: checkout, stdio: "ignore" });
execSync(
  "git -c user.email=t@t.com -c user.name=t commit -q --allow-empty -m base",
  { cwd: checkout, stdio: "ignore" },
);

/**
 * The run's own database, on the server `DATABASE_URL` names, and `DATABASE_URL` pointed at it before
 * anything reads a config (`./GitHubWebhook.test.ts` explains the order).
 */
const configuredUrl =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const scratchName = `factory_api_admission_${run}`;
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

/** No Linear and no GitHub behind the write-backs: nothing here may leave the process. */
const services = Layer.mergeAll(
  Layer.succeed(
    LinearIssueSync,
    LinearIssueSync.of({
      started: () => Effect.void,
      pullRequestOpened: () => Effect.void,
      failed: () => Effect.void,
      merged: () => Effect.void,
      createChild: () => Effect.die("the webhook does not create issues"),
      blocks: () => Effect.die("the webhook does not relate issues"),
      children: () => Effect.die("the webhook does not read a plan"),
      rescope: () => Effect.die("the webhook does not rescope issues"),
      close: () => Effect.die("the webhook does not close issues"),
    }),
  ),
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
      maxConcurrentSessions: 1,
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
);

// One session service for the cases and the routes (the handler shares the runtime's memo map), so
// the slot a case takes is the one a route is refused for.
const runtime = ManagedRuntime.make(services);
const context = await runtime.runPromise(
  Effect.context<SessionService | SqlClient>(),
);
const { handler, dispose } = HttpRouter.toWebHandler(
  Layer.mergeAll(webhookLiveFor(rules), GitHubWebhookLive).pipe(
    Layer.provideMerge(services),
  ),
  { disableLogger: true, memoMap: runtime.memoMap },
);

const inService = <A, E>(
  effect: Effect.Effect<A, E, SessionService | SqlClient>,
) => Effect.runPromise(Effect.provideContext(effect, context));

await inService(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* sessions.registerRepo({ repo, localPath: checkout });
  }),
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

beforeEach(async () => {
  for (const [name, value] of Object.entries(SECRETS))
    process.env[name] = value;
  // Every owner released, so each case starts with the one slot free.
  await inService(Effect.flatMap(SessionService, (sessions) => sessions.close));
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Take the one slot with a session of the case's own, as a person's create would. */
const fillTheSlot = () =>
  inService(
    Effect.flatMap(SessionService, (sessions) =>
      sessions.create({ title: "holds the one slot" }),
    ),
  );

/** Free it: every owner released, as the idle sweep releases each idle one. */
const freeTheSlot = () =>
  inService(Effect.flatMap(SessionService, (sessions) => sessions.close));

/** A delivery's row, by a fragment of its request id: `undefined` when there is none. */
const deliveryRow = (fragment: string) =>
  inService(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ requestId: string; status: string }>`
        SELECT request_id, status FROM webhook_deliveries
        WHERE request_id LIKE ${`%${fragment}%`}
      `;
      return rows;
    }),
  );

/** How many sessions a delivery opened, by a fragment of its request id. */
const sessionsFor = (fragment: string) =>
  inService(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ id: string }>`
        SELECT id FROM sessions WHERE request_id LIKE ${`%${fragment}%`}
      `;
      return rows.map((row) => row.id);
    }),
  );

const hmac = (secret: string, raw: string) =>
  createHmac("sha256", secret).update(raw).digest("hex");

type Answer = {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: Record<string, unknown>;
};

const post = async (
  path: string,
  raw: string,
  headers: Record<string, string>,
): Promise<Answer> => {
  const response = await handler(
    new Request(`http://factory.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw,
    }),
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json()) as Record<string, unknown>,
  };
};

const deliverGeneric = (requestId: string) => {
  const raw = JSON.stringify({
    requestId,
    label: "factory",
    title: "a generic delivery at capacity",
    body: "open a session once there is room",
  });
  return post("/webhooks/generic", raw, {
    "x-trigger-signature": hmac(SECRETS.TRIGGER_SECRET, raw),
  });
};

const deliverLinear = (issueId: string) => {
  const raw = JSON.stringify({
    type: "Issue",
    action: "create",
    data: {
      id: issueId,
      identifier: `ADM-${run}`,
      title: "a Linear issue at capacity",
      description: "open a session once there is room",
      labels: [{ name: "factory" }],
    },
  });
  return post("/webhooks/linear", raw, {
    "linear-signature": hmac(SECRETS.LINEAR_WEBHOOK_SECRET, raw),
    "linear-delivery": randomBytes(8).toString("hex"),
  });
};

const deliverPush = (sha: string) => {
  const raw = JSON.stringify({
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: sha,
    deleted: false,
    commits: [{ id: sha, message: "feat: a change worth a docs pass" }],
    head_commit: { id: sha, message: "feat: a change worth a docs pass" },
    repository: {
      name: repo.split("/")[1],
      full_name: repo,
      default_branch: "main",
    },
  });
  return post("/webhooks/github", raw, {
    "x-github-event": "push",
    "x-github-delivery": randomBytes(8).toString("hex"),
    "x-hub-signature-256": `sha256=${hmac(SECRETS.GITHUB_WEBHOOK_SECRET, raw)}`,
  });
};

/** The refusal every route answers at capacity: typed, retryable, never a `500`. */
const expectAtCapacity = (answer: Answer) => {
  expect(answer.status).toBe(503);
  expect(Number(answer.retryAfter)).toBeGreaterThan(0);
  expect(answer.body).toMatchObject({ ok: false, code: "at-capacity" });
  expect(String(answer.body["error"])).toContain("SESSION_MAX_CONCURRENT=1");
};

describe("a trigger delivery at capacity (LOB-70)", () => {
  it("answers a signed generic delivery 503 at-capacity, leaves its row unprocessed, and processes the redelivery once a slot frees", async () => {
    const requestId = `lob-70-generic-${run}`;
    await fillTheSlot();
    const refused = await deliverGeneric(requestId);
    expectAtCapacity(refused);
    // The claim was released: no row a retry would read as processed, or as still in flight.
    expect(await deliveryRow(requestId)).toEqual([]);
    expect(await sessionsFor(requestId)).toEqual([]);

    await freeTheSlot();
    const redelivered = await deliverGeneric(requestId);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body).toMatchObject({
      ok: true,
      status: "processed",
      replayed: false,
    });
    const opened = await sessionsFor(requestId);
    expect(opened).toEqual([redelivered.body["sessionId"]]);
    expect((await deliveryRow(requestId)).map((row) => row.status)).toEqual([
      "processed",
    ]);
  }, 60_000);

  it("answers a signed Linear delivery 503 at-capacity, and processes its redelivery once a slot frees", async () => {
    const issueId = `lob-70-linear-${run}`;
    await fillTheSlot();
    const refused = await deliverLinear(issueId);
    expectAtCapacity(refused);
    expect(await deliveryRow(issueId)).toEqual([]);
    expect(await sessionsFor(issueId)).toEqual([]);

    await freeTheSlot();
    const redelivered = await deliverLinear(issueId);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body).toMatchObject({ ok: true, status: "processed" });
    expect(await sessionsFor(issueId)).toEqual([redelivered.body["sessionId"]]);
    expect((await deliveryRow(issueId)).map((row) => row.status)).toEqual([
      "processed",
    ]);
  }, 60_000);

  it("answers a signed docs push 503 at-capacity, and processes GitHub's redelivery once a slot frees", async () => {
    const sha = randomBytes(20).toString("hex");
    await fillTheSlot();
    const refused = await deliverPush(sha);
    expectAtCapacity(refused);
    expect(await deliveryRow(sha)).toEqual([]);
    expect(await sessionsFor(sha)).toEqual([]);

    await freeTheSlot();
    const redelivered = await deliverPush(sha);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body).toMatchObject({
      ok: true,
      status: "processed",
      replayed: false,
    });
    expect(await sessionsFor(sha)).toEqual([redelivered.body["sessionId"]]);
    expect((await deliveryRow(sha)).map((row) => row.status)).toEqual([
      "processed",
    ]);
  }, 60_000);
});
