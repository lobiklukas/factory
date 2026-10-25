/**
 * The docs trigger (LOB-197, part 3 of LOB-37).
 *
 * Two halves, because the claim has two halves. The pure cases pin what a delivery *is* — which
 * push payload is one, which is not, and what its delivery id (and so its branch) comes to — and
 * they need no database. The seam cases drive the same deliveries through the real
 * `TriggerService`, the real `DocsSessionsFromSessionService` port and the real `SessionService`
 * against Postgres, which is what makes "exactly one session, once" and "the branch is
 * `factory/doc-<id>`" facts about the system rather than about a fake.
 *
 * The clock is shortened rather than faked: `docsSchedule` is given a 25 ms interval and the case
 * watches for a few intervals, because the schedule's contract is "one delivery per interval", not
 * "one delivery per 25 ms of CPU". The disabled case waits the same wall clock and asserts nothing
 * arrived at all, which a schedule that fired a disabled tick would fail.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row this file writes carries a
 * per-run repo slug or a per-run session root, so it is safe against a database other suites use.
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import type { TriggerDelivery } from "@repo/domain/Trigger";
import { resolveMapping, startsWork } from "@repo/domain/Trigger";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DOCS_BRANCH_PREFIX,
  DocsSessionsFromSessionService,
  docsBranch,
  docsPushDelivery,
  docsPushEvent,
  docsSchedule,
  docsScheduleDelivery,
  docsTriggerRules,
  scheduleToken,
} from "./DocsTrigger";
import { SessionService, SessionServiceLive } from "./SessionService";
import {
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");

/** A repo only this run registers, so a shared database cannot answer for it. */
const repo = `acme/docs-trigger-${runId}` as RepoSlug;

/** A 40-hex commit, as GitHub's `after` carries it. */
const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";

const pushPayload = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  after: sha,
  deleted: false,
  repository: { full_name: repo.toUpperCase() },
  commits: [
    { message: "docs: say what the trigger does" },
    { message: "fix: a one-line fix\n\nand a body nobody reads" },
  ],
  ...over,
});

describe("a push delivery", () => {
  it("normalizes a push to the default branch into a delivery named after the push", () => {
    const delivery = docsPushDelivery({
      payload: pushPayload(),
      defaultBranch: "main",
    });

    expect(delivery).toBeDefined();
    // The id names the *push*, not the attempt: a redelivery of the same push is a replay, and the
    // branch a docs run works on is this id.
    expect(delivery?.requestId).toBe(`push-acme-docs-trigger-${runId}-${sha}`);
    expect(delivery?.event.source).toBe("github");
    expect(delivery?.event.action).toBe("push");
    expect(delivery?.event.repo).toBe(`acme/docs-trigger-${runId}`);
    expect(delivery?.event.labels).toEqual(["docs"]);
    // The commit messages are the prompt's body, one line each: a push of two commits reads as two
    // lines, and a message's own body is not copied into the prompt.
    expect(delivery?.event.body).toBe(
      "- docs: say what the trigger does\n- fix: a one-line fix",
    );
    expect(docsBranch(delivery?.requestId ?? "")).toBe(
      `${DOCS_BRANCH_PREFIX}push-acme-docs-trigger-${runId}-${sha}`,
    );
  });

  it("refuses a push that is not about the default branch", () => {
    for (const payload of [
      pushPayload({ ref: "refs/heads/factory/ses_1" }),
      pushPayload({ ref: "refs/tags/v1" }),
    ]) {
      expect(docsPushDelivery({ payload, defaultBranch: "main" })).toBe(
        undefined,
      );
    }
    // The default branch is a parameter, not "main": a repo whose trunk is `trunk` docs its trunk.
    expect(
      docsPushDelivery({
        payload: pushPayload({ ref: "refs/heads/trunk" }),
        defaultBranch: "trunk",
      }),
    ).toBeDefined();
  });

  it("refuses a branch deletion, and a payload it cannot read", () => {
    expect(
      docsPushEvent({
        payload: pushPayload({ deleted: true }),
        defaultBranch: "main",
      }),
    ).toBe(undefined);
    // GitHub sends an all-zeros `after` for a deletion, with or without `deleted`.
    expect(
      docsPushEvent({
        payload: pushPayload({ after: "0".repeat(40), deleted: undefined }),
        defaultBranch: "main",
      }),
    ).not.toBe(undefined);
    expect(
      docsPushEvent({
        payload: pushPayload({ after: undefined }),
        defaultBranch: "main",
      }),
    ).toBe(undefined);
    expect(
      docsPushEvent({
        payload: pushPayload({ repository: { full_name: "not a slug" } }),
        defaultBranch: "main",
      }),
    ).toBe(undefined);
    expect(docsPushEvent({ payload: null, defaultBranch: "main" })).toBe(
      undefined,
    );
  });

  it("is the rule that admits the lifecycle actions, so no other rule inherits them", () => {
    const [rule] = docsTriggerRules(repo);
    expect(rule?.startsWorkFor).toEqual(["push", "schedule"]);
    // A rule that asks for nothing extra admits nothing extra: `create` is the seam's default and
    // the docs rule is the only one that says a push or a schedule starts work.
    expect(startsWork("push", [])).toBe(false);
    expect(startsWork("push", [rule?.startsWorkFor ?? []])).toBe(true);
    expect(startsWork("create", [])).toBe(true);
    expect(startsWork("update", [rule?.startsWorkFor ?? []])).toBe(false);
  });

  it("maps through the docs rule, and carries the rendered prompt", () => {
    const rules = docsTriggerRules(repo);
    const delivery = docsPushDelivery({
      payload: pushPayload(),
      defaultBranch: "main",
    });
    expect(delivery).toBeDefined();
    const mapping = resolveMapping(rules, delivery!.event);

    expect(mapping?.repo).toBe(repo);
    expect(mapping?.label).toBe("docs");
    expect(mapping?.prompt).toContain("docs: say what the trigger does");
    expect(mapping?.prompt).toContain("documentation only");
  });
});

describe("the schedule", () => {
  it("names each tick after the interval it covers, not the wake", () => {
    // Two wakes inside one interval are one delivery — the seam answers the second as a replay —
    // and the next interval is a new one.
    expect(scheduleToken(repo, 1000, 250)).toBe(scheduleToken(repo, 1249, 250));
    expect(scheduleToken(repo, 1000, 250)).not.toBe(
      scheduleToken(repo, 1250, 250),
    );
    const delivery = docsScheduleDelivery({ repo, at: 1000, everyMs: 250 });
    expect(delivery.event.action).toBe("schedule");
    expect(delivery.event.labels).toEqual(["docs"]);
    expect(docsBranch(delivery.requestId)).toBe(
      `${DOCS_BRANCH_PREFIX}${delivery.requestId}`,
    );
  });

  it("fires once per interval on a shortened clock", async () => {
    const delivered: Array<TriggerDelivery> = [];
    const everyMs = 25;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          docsSchedule({
            everyMs,
            repo,
            deliver: (delivery) =>
              Effect.sync(() => {
                delivered.push(delivery);
              }),
          }),
        );
        yield* Effect.sleep(Duration.millis(120));
        yield* Effect.suspend(() => Effect.sync(() => fiber.interruptUnsafe()));
      }),
    );

    expect(delivered.length).toBeGreaterThanOrEqual(2);
    // One delivery per interval: no two ticks name the same interval, because a second wake inside
    // one would be a replay rather than a second run.
    const ids = new Set(delivered.map((delivery) => delivery.requestId));
    expect(ids.size).toBe(delivered.length);
  });

  it("fires nothing at all when it is disabled", async () => {
    for (const everyMs of [undefined, 0, -1]) {
      const delivered: Array<TriggerDelivery> = [];
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            docsSchedule({
              everyMs,
              repo,
              deliver: (delivery) =>
                Effect.sync(() => {
                  delivered.push(delivery);
                }),
            }),
          );
          yield* Effect.sleep(Duration.millis(60));
          yield* Effect.suspend(() =>
            Effect.sync(() => fiber.interruptUnsafe()),
          );
        }),
      );
      expect(delivered).toEqual([]);
    }
  });
});

/** What the seam and the real session layer need, wired the way a deployment wires them. */
const sessionRoot = mkdtempSync(join(tmpdir(), "docs-trigger-"));

const runtime = ManagedRuntime.make(
  TriggerServiceLive({ rules: docsTriggerRules(repo) }).pipe(
    Layer.provide(DocsSessionsFromSessionService),
    Layer.provide(NoWriteBack),
    Layer.provideMerge(
      SessionServiceLive({
        model: createModelAccess("faux"),
        sessionRoot,
      }).pipe(Layer.provideMerge(DatabaseLive)),
    ),
    Layer.provideMerge(BunServices.layer),
  ),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionService | TriggerService | SqlClient>,
) => runtime.runPromise(effect);

/**
 * A real checkout the session's worktree is cut from, so "the branch is `factory/doc-<id>`" is a
 * fact about git rather than a string the service reported.
 */
const repoDir = mkdtempSync(join(tmpdir(), "docs-trigger-repo-"));
execSync("git init -q -b main", { cwd: repoDir });
execSync("git config user.email docs-trigger@localhost", { cwd: repoDir });
execSync("git config user.name docs-trigger", { cwd: repoDir });
execSync("git commit -q --allow-empty -m 'docs trigger repo'", {
  cwd: repoDir,
});

/** The sessions this run's repo has, as the index holds them. */
const sessionCount = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ count: string }>`
      SELECT count(*)::text AS count FROM sessions WHERE repo = ${repo}
    `;
      return Number(rows[0]?.count ?? "0");
    }),
  );

const pushDelivery = docsPushDelivery({
  payload: pushPayload(),
  defaultBranch: "main",
})!;

const deliverPush = (delivery: TriggerDelivery) =>
  run(
    Effect.gen(function* () {
      const trigger = yield* TriggerService;
      const sessions = yield* SessionService;
      yield* sessions.registerRepo({ repo, localPath: repoDir });
      return yield* trigger.deliver(delivery);
    }),
  );

describe("a docs delivery through the seam", () => {
  it("starts exactly one docs session on a factory/doc-<id> branch, and a redelivery starts none", async () => {
    const first = await deliverPush(pushDelivery);
    expect(first.status).toBe("processed");
    expect(first.replayed).toBe(false);
    const sessionId = first.sessionId as SessionId;
    expect(sessionId).toBeDefined();

    const snapshot = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.get(sessionId);
      }),
    );
    const branch = `factory/doc-${pushDelivery.requestId}`;
    expect(snapshot.workspace.branch).toBe(branch);
    // The worktree is really on it: not the default branch, and not `factory/<session-id>`.
    expect(
      execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: snapshot.workspace.path,
      })
        .toString()
        .trim(),
    ).toBe(branch);
    // The run was told why it exists: the rule's rendered prompt is its first message.
    expect(snapshot.entries.map((entry) => entry.text).join("\n")).toContain(
      "documentation only",
    );

    const again = await deliverPush(pushDelivery);
    expect(again.status).toBe("processed");
    expect(again.replayed).toBe(true);
    expect(await sessionCount()).toBe(1);
  }, 90_000);

  it("persists the branch on the index, so a fold of the row answers it too", async () => {
    // The row is what a released session's workspace resolves from; a branch only the create call
    // knew would be re-derived as `factory/<session-id>` by every later read.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ branch: string | null }>`
          SELECT branch FROM sessions WHERE repo = ${repo}
        `;
        expect(rows.map((row) => row.branch)).toEqual([
          `factory/doc-${pushDelivery.requestId}`,
        ]);
      }),
    );
  }, 60_000);

  it("starts one session per schedule interval, and one for a redelivered tick", async () => {
    const before = await sessionCount();
    const at = 1_700_000_000_000;
    const delivery = docsScheduleDelivery({ repo, at, everyMs: 60_000 });

    const first = await deliverPush(delivery);
    expect(first.status).toBe("processed");
    expect(first.replayed).toBe(false);
    const again = await deliverPush(delivery);
    expect(again.replayed).toBe(true);
    expect(await sessionCount()).toBe(before + 1);

    const snapshot = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.get(first.sessionId as SessionId);
      }),
    );
    // The branch names the interval the tick covers, so two ticks of one schedule cannot share a
    // branch (`at` is floored to its interval).
    expect(snapshot.workspace.branch).toBe(`factory/doc-${delivery.requestId}`);
  }, 90_000);
});
