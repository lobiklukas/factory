/**
 * Plan freshness after a merge (LOB-45), from a signed `pull_request` delivery to the revision on
 * the spec's session, against real Postgres, the real session layer, Linear's in-process fake behind
 * the tracker port, and a faux model whose plan-freshness calls are counted.
 *
 * The story each case starts from is the factory's own: a card is specified by one run (the session
 * that holds `factory.spec`), built by another (the session whose PR merges), and its delegating
 * Linear issue already has children — the plan. A merge is delivered the way GitHub delivers it.
 *
 * What is proven, per acceptance criterion:
 *
 * - the cadence on: one merged delivery files exactly one revision on the spec's session, and a
 *   redelivery of the same merge files none and makes no call;
 * - the cadence off: no revision, no call, and no dedupe row either;
 * - one call at most, charged to the spec session's ledger and within the bound; a pass whose worst
 *   case is over the bound is refused before the call;
 * - an answer naming an issue outside the plan, or two proposals about one issue, is refused with
 *   every fault named and nothing stored — and the redelivery does not pay for it twice;
 * - no session is opened and the tracker sees reads only: the fake's ledger of writes stays empty;
 * - declining makes no call, and nothing is sent; a declined revision cannot be approved;
 * - the revision names the spec it was derived from, and the spec's session lists it.
 *
 * Approval through LOB-202's port is proven last: each kind lands once, and approving again sends
 * nothing.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { DatabaseLive } from "@repo/storage-postgres";
import { createFauxModelAccess, PLAN_PROMPT_PREFIX } from "@repo/harness";
import { PlanProposalsRefused } from "@repo/domain/PlanFreshness";
import type { SessionSnapshot } from "@repo/domain/Session";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_STATES,
  LinearIssueSyncLive,
  LinearProposalTracker,
} from "./LinearSync";
import { CANCELED, DONE, type FakeOptions, makeLinear } from "./linearFake";
import {
  handlePlanFreshnessDelivery,
  planFreshnessConfigOf,
  type PlanFreshnessConfig,
  PlanFreshnessPasses,
  PlanFreshnessPassesLive,
} from "./PlanFreshness";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";
import { sessionRequestIdOf } from "./TriggerService";

const SECRET = "plan-freshness-secret";
const PERSON = "person:lukas";
const SPEC = {
  goal: "Keep the plan fresh",
  acceptance: ["the schema exists", "the RPC answers"],
  gaps: [] as string[],
  openQuestions: [] as string[],
};
/** The plan as the tracker holds it: one criterion done, one issue nobody needs, one to re-scope. */
const PLAN = [
  { title: "the schema exists", state: DONE },
  {
    title: "a dashboard nobody asked for",
    description: "goal\n\n**Acceptance**\n\n- [ ] it renders",
  },
  { title: "the RPC, half of it" },
];
const ON: PlanFreshnessConfig = { cadence: "merged", maxCost: 1 };
const OFF: PlanFreshnessConfig = { cadence: "off", maxCost: 1 };

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-plan-freshness-"));
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterAll(async () => {
  for (const runtime of runtimes) await runtime.dispose();
});

/**
 * A service whose faux specs `SPEC`, with the Linear fake behind the tracker. `answer.body` scripts
 * the next plan-freshness answer (derived when undefined); `planCalls` counts the calls that carried
 * a plan-freshness prompt — the faux's own count also counts a run's steps.
 */
const world = (
  options: {
    readonly fauxCost?: number;
    readonly linear?: FakeOptions;
    /**
     * Hold every plan-freshness call until `gate.open()`, then answer it as a provider that billed
     * the call whatever the abort said: the faux is called without the signal.
     */
    readonly slow?: boolean;
  } = {},
) => {
  const key = `ENG-${randomBytes(3).toString("hex")}`;
  const fake = makeLinear({
    ...options.linear,
    identifier: key,
    children: PLAN,
  });
  const faux = createFauxModelAccess({
    fauxSpec: [SPEC],
    ...(options.fauxCost === undefined ? {} : { fauxCost: options.fauxCost }),
  });
  const answer: { body: string | undefined } = { body: undefined };
  let planCalls = 0;
  let open: () => void = () => {};
  // oxlint-disable-next-line effecttsgo/new-promise -- a gate the case opens by hand.
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const gate = { open: () => open() };
  const models = faux.access.models;
  const counted: typeof models.completeSimple = async (
    request,
    context,
    ...rest
  ) => {
    const planning = context.messages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith(PLAN_PROMPT_PREFIX),
    );
    if (planning) planCalls += 1;
    if (planning && options.slow === true) {
      await opened;
      const [callOptions] = rest;
      if (callOptions !== undefined) {
        const { signal: _ignored, ...unsignalled } = callOptions;
        rest = [unsignalled];
      }
    }
    const message = await models.completeSimple(request, context, ...rest);
    return planning && answer.body !== undefined
      ? { ...message, content: [{ type: "text", text: answer.body }] }
      : message;
  };
  const access = {
    ...faux.access,
    models: new Proxy(models, {
      get: (target, name) => {
        if (name === "completeSimple") return counted;
        const value: unknown = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const tracker = LinearProposalTracker.pipe(
    Layer.provide(
      LinearIssueSyncLive({
        apiUrl: "http://linear.test/graphql",
        apiKey: Redacted.make("lin_api_test"),
        states: DEFAULT_LINEAR_STATES,
      }),
    ),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      SessionServiceLive({ model: access, sessionRoot }),
      TaskServiceLive,
    ).pipe(
      Layer.provide(tracker),
      Layer.provideMerge(fake.layer),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
  runtimes.push(runtime);
  return { answer, fake, gate, key, runtime, planCalls: () => planCalls };
};

const waitUntil = <E, R>(check: Effect.Effect<boolean, E, R>, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/**
 * A card specified by one run and built by another, whose PR is `pr`: the spec session is
 * delegated from Linear issue `key`. Answers both sessions.
 */
const merged = (key: string, pr: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* TaskService;
    const sessions = yield* SessionService;
    const boardId = `brd_${randomBytes(13).toString("hex")}`;
    yield* sql`
      INSERT INTO board_instances (id, repo, definition_id, definition_version)
      VALUES (${boardId}, ${`factory-test/${randomBytes(6).toString("hex")}`}, 'default', 1)
    `;
    const created = yield* tasks.create({
      boardId,
      title: "a card whose plan goes stale",
      actor: PERSON,
    });
    const card = yield* tasks.move({
      taskId: created.id,
      expectedRevision: created.revision,
      to: "specifying",
      actor: PERSON,
    });
    const specRun = yield* sessions.create({
      title: card.title,
      taskId: card.id,
      taskColumn: card.column,
    });
    yield* sessions.send({ sessionId: specRun.id, content: "specify it" });
    yield* waitUntil(
      Effect.map(
        sessions.get(specRun.id),
        (snapshot) =>
          !snapshot.live.busy &&
          snapshot.entries.some(
            (entry) =>
              entry.kind === "toolResult" &&
              entry.toolName === "spec" &&
              entry.isError !== true,
          ),
      ),
      "the specifying run to declare its spec and settle",
    );
    yield* sql`UPDATE sessions SET request_id = ${sessionRequestIdOf(`linear:${key}:mapped`)} WHERE id = ${specRun.id}`;
    const buildRun = yield* sessions.create({
      title: card.title,
      taskId: card.id,
      taskColumn: card.column,
    });
    yield* sql`UPDATE sessions SET pr_url = ${pr} WHERE id = ${buildRun.id}`;
    return { spec: specRun.id, build: buildRun.id };
  });

const prUrl = () =>
  `https://github.com/factory-test/plan-${randomBytes(4).toString("hex")}/pull/7`;

/**
 * A signed `pull_request` delivery GitHub would send for `pr`'s merge (or `merged: false`), its
 * passes run inline, or handed to `fork` as the route does.
 */
const delivery = (
  pr: string,
  config: PlanFreshnessConfig,
  merged = true,
  fork?: (pass: Effect.Effect<void>) => Effect.Effect<void>,
) => {
  const raw = JSON.stringify({
    action: "closed",
    pull_request: {
      html_url: pr,
      number: 7,
      merged,
      title: "Build the schema",
    },
  });
  return handlePlanFreshnessDelivery({
    secret: SECRET,
    raw,
    signature: `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    config,
    ...(fork === undefined ? {} : { fork }),
  });
};

const sessionCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    readonly n: number;
  }>`SELECT count(*)::int AS n FROM sessions`;
  return rows[0]?.n ?? 0;
});

const claimOf = (requestId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{
      readonly status: string;
      readonly skipReason: string | null;
    }>`
      SELECT status, skip_reason FROM webhook_deliveries WHERE request_id = ${requestId}
    `;
  });

/** What a session has spent, over every model its ledger names. */
const spendOf = (snapshot: SessionSnapshot): number =>
  snapshot.usage.models.reduce(
    (total, model) => total + model.usage.costTotal,
    0,
  );

const errorOf = (exit: Exit.Exit<unknown, unknown>) =>
  Option.getOrThrow(Exit.findErrorOption(exit));

describe("plan freshness after a merged PR (LOB-45)", () => {
  it("files exactly one revision on the spec's session, and a redelivery files none and calls nothing", async () => {
    const { fake, key, runtime, planCalls } = world();
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        const before = yield* sessionCount;
        const first = yield* delivery(pr, ON);
        const callsAfterFirst = planCalls();
        const again = yield* delivery(pr, ON);
        return {
          runs,
          first,
          again,
          callsAfterFirst,
          sessionsBefore: before,
          sessionsAfter: yield* sessionCount,
          spec: yield* sessions.get(runs.spec),
          build: yield* sessions.get(runs.build),
          claim: yield* claimOf(`plan-freshness:${runs.spec}:${pr}`),
        };
      }),
    );
    expect(outcome.first).toMatchObject({
      status: "merged",
      passes: [
        { sessionId: outcome.runs.spec, outcome: "proposed", proposals: 3 },
      ],
    });
    expect(outcome.again).toMatchObject({
      status: "merged",
      passes: [{ sessionId: outcome.runs.spec, outcome: "replayed" }],
    });
    // One call, and the redelivery none.
    expect(outcome.callsAfterFirst).toBe(1);
    expect(planCalls()).toBe(1);
    // Exactly one revision, on the spec's session, not on the session whose PR merged.
    expect(outcome.spec.planRevisions).toHaveLength(1);
    expect(outcome.build.planRevisions).toBeUndefined();
    const [revision] = outcome.spec.planRevisions ?? [];
    expect(revision).toMatchObject({
      key: `merged:${pr}`,
      trigger: { pr, number: 7, title: "Build the schema" },
      decision: "pending",
      // The spec it was derived from.
      spec: { sessionId: outcome.runs.spec, goal: SPEC.goal },
    });
    expect(revision?.spec.digest).toMatch(/^[0-9a-f]{16}$/);
    // What the pass was shown: the plan, each issue's state and acceptance checklist.
    expect(revision?.issues.map((one) => [one.title, one.closed])).toEqual([
      ["the schema exists", true],
      ["a dashboard nobody asked for", false],
      ["the RPC, half of it", false],
    ]);
    expect(revision?.issues[1]?.acceptance).toEqual(["it renders"]);
    // The faux's derived reading: add the criterion no issue is titled by, close the issues no
    // criterion names.
    expect(
      revision?.proposals.map((one) =>
        one.kind === "add" ? [one.kind, one.title] : [one.kind, one.issue],
      ),
    ).toEqual([
      ["add", "the RPC answers"],
      ["close", revision?.issues[1]?.identifier],
      ["close", revision?.issues[2]?.identifier],
    ]);
    // No session opened, and the tracker saw reads only.
    expect(outcome.sessionsAfter).toBe(outcome.sessionsBefore);
    expect(fake.writes()).toEqual([]);
    expect(fake.seen.map((one) => one.operation)).toEqual(["issuePlan"]);
    expect(outcome.claim).toMatchObject([{ status: "processed" }]);
  });

  it("with the cadence off, a merged PR files nothing, calls nothing and claims nothing", async () => {
    const { fake, key, runtime, planCalls } = world();
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        const answered = yield* delivery(pr, OFF);
        return {
          answered,
          spec: yield* sessions.get(runs.spec),
          claim: yield* claimOf(`plan-freshness:${runs.spec}:${pr}`),
        };
      }),
    );
    expect(outcome.answered).toEqual({ status: "off" });
    expect(planCalls()).toBe(0);
    expect(outcome.spec.planRevisions).toBeUndefined();
    expect(outcome.claim).toEqual([]);
    expect(fake.seen).toEqual([]);
  });

  it("is off when nothing is configured, and refuses a cadence or a bound that does not read", () => {
    expect(planFreshnessConfigOf({})).toEqual({
      ok: true,
      config: { cadence: "off", maxCost: 0.25 },
    });
    expect(
      planFreshnessConfigOf({ cadence: " Merged ", maxCost: "0.05" }),
    ).toEqual({ ok: true, config: { cadence: "merged", maxCost: 0.05 } });
    expect(planFreshnessConfigOf({ cadence: "always" }).ok).toBe(false);
    expect(planFreshnessConfigOf({ cadence: "merged", maxCost: "-1" }).ok).toBe(
      false,
    );
  });

  it("ignores an unmerged close and an unsigned delivery", async () => {
    const { key, runtime, planCalls } = world();
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* merged(key, pr);
        const closed = yield* delivery(pr, ON, false);
        const unsigned = yield* handlePlanFreshnessDelivery({
          secret: SECRET,
          raw: JSON.stringify({
            action: "closed",
            pull_request: { html_url: pr, number: 7, merged: true },
          }),
          signature: "sha256=00",
          config: ON,
        });
        return { closed, unsigned };
      }),
    );
    expect(outcome.closed).toMatchObject({ status: "ignored" });
    expect(outcome.unsigned).toMatchObject({ status: "ignored" });
    expect(planCalls()).toBe(0);
  });

  it("charges the one call to the spec's ledger within the bound, and refuses a pass over it before the call", async () => {
    const { key, runtime, planCalls } = world({ fauxCost: 0.05 });
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        const before = spendOf(yield* sessions.get(runs.spec));
        const over = yield* delivery(pr, { cadence: "merged", maxCost: 0.01 });
        const afterRefusal = yield* sessions.get(runs.spec);
        const claim = yield* claimOf(`plan-freshness:${runs.spec}:${pr}`);
        // A refused pass is a recorded decision: a redelivery does not try again at the same bound.
        const replay = yield* delivery(pr, {
          cadence: "merged",
          maxCost: 0.01,
        });
        const callsAfterRefusal = planCalls();
        // A second merge, under a bound the worst case fits.
        const pr2 = `${pr}0`;
        const sql = yield* SqlClient;
        yield* sql`UPDATE sessions SET pr_url = ${pr2} WHERE id = ${runs.build}`;
        const within = yield* delivery(pr2, {
          cadence: "merged",
          maxCost: 0.1,
        });
        const after = spendOf(yield* sessions.get(runs.spec));
        return {
          before,
          over,
          afterRefusal,
          claim,
          replay,
          callsAfterRefusal,
          within,
          after,
        };
      }),
    );
    expect(outcome.over).toMatchObject({
      passes: [{ outcome: "refused", reason: "over_bound" }],
    });
    expect(outcome.callsAfterRefusal).toBe(0);
    expect(outcome.afterRefusal.planRevisions).toBeUndefined();
    expect(spendOf(outcome.afterRefusal)).toBe(outcome.before);
    expect(outcome.claim).toMatchObject([{ status: "skipped" }]);
    expect(outcome.claim[0]?.skipReason).toContain("over the bound");
    expect(outcome.replay).toMatchObject({ passes: [{ outcome: "replayed" }] });
    expect(outcome.within).toMatchObject({ passes: [{ outcome: "proposed" }] });
    expect(planCalls()).toBe(1);
    // The call was charged to the spec session's own ledger, and stayed within the bound.
    const spent = outcome.after - outcome.before;
    expect(spent).toBeCloseTo(0.05, 10);
    expect(spent).toBeLessThanOrEqual(0.1);
  });

  it("answers a forked delivery before a slow call returns, and the pass still files one revision and charges it", async () => {
    const { gate, key, runtime, planCalls } = world({
      fauxCost: 0.05,
      slow: true,
    });
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const passes = yield* PlanFreshnessPasses;
        const runs = yield* merged(key, pr);
        const before = spendOf(yield* sessions.get(runs.spec));
        // The route's way: the pass is handed to the process's passes, and the answer is in while
        // the call is still out — a request GitHub gave up on cannot take the pass with it.
        const answered = yield* delivery(pr, ON, true, passes.run);
        yield* waitUntil(
          Effect.sync(() => planCalls() === 1),
          "the pass's call",
        );
        const during = {
          spec: yield* sessions.get(runs.spec),
          claim: yield* claimOf(`plan-freshness:${runs.spec}:${pr}`),
        };
        gate.open();
        yield* passes.idle;
        return {
          answered,
          during,
          before,
          after: yield* sessions.get(runs.spec),
          claim: yield* claimOf(`plan-freshness:${runs.spec}:${pr}`),
        };
      }).pipe(Effect.provide(PlanFreshnessPassesLive)),
    );
    expect(outcome.answered).toMatchObject({
      status: "merged",
      passes: [{ outcome: "accepted" }],
    });
    expect(outcome.during.spec.planRevisions).toBeUndefined();
    expect(outcome.during.claim).toMatchObject([{ status: "received" }]);
    expect(outcome.after.planRevisions).toHaveLength(1);
    expect(spendOf(outcome.after) - outcome.before).toBeCloseTo(0.05, 10);
    expect(outcome.claim).toMatchObject([{ status: "processed" }]);
    expect(planCalls()).toBe(1);
  });

  it("charges a call the pass was interrupted in, gives the claim back, and a redelivery files the one revision", async () => {
    const { gate, key, runtime, planCalls } = world({
      fauxCost: 0.05,
      slow: true,
    });
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        const before = spendOf(yield* sessions.get(runs.spec));
        const pass = yield* Effect.forkChild(delivery(pr, ON));
        yield* waitUntil(
          Effect.sync(() => planCalls() === 1),
          "the pass's call",
        );
        // A shutdown lands mid-call. The provider bills the call whatever the abort says; the
        // interrupt waits for its answer and charges it before the claim goes back.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(pass));
        // Let the interrupt reach the pass while its call is still held, then let the call answer.
        yield* Effect.sleep(100);
        gate.open();
        yield* Fiber.join(interrupting);
        const interrupted = {
          spec: yield* sessions.get(runs.spec),
          claim: yield* claimOf(`plan-freshness:${runs.spec}:${pr}`),
        };
        const again = yield* delivery(pr, ON);
        return {
          before,
          interrupted,
          again,
          after: yield* sessions.get(runs.spec),
        };
      }),
    );
    expect(spendOf(outcome.interrupted.spec) - outcome.before).toBeCloseTo(
      0.05,
      10,
    );
    expect(outcome.interrupted.spec.planRevisions).toBeUndefined();
    expect(outcome.interrupted.claim).toEqual([]);
    expect(outcome.again).toMatchObject({
      passes: [{ outcome: "proposed" }],
    });
    expect(outcome.after.planRevisions).toHaveLength(1);
    // Both calls were billed, and both are on the ledger.
    expect(spendOf(outcome.after) - outcome.before).toBeCloseTo(0.1, 10);
    expect(planCalls()).toBe(2);
  });

  it("gives the claim back when the plan could not be read, so a redelivery tries again", async () => {
    const { runtime, key, planCalls } = world({
      linear: { refuse: "issuePlan" },
    });
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const runs = yield* merged(key, pr);
        const first = yield* delivery(pr, ON);
        const claim = yield* claimOf(`plan-freshness:${runs.spec}:${pr}`);
        const again = yield* delivery(pr, ON);
        return { first, claim, again };
      }),
    );
    for (const answered of [outcome.first, outcome.again]) {
      expect(answered).toMatchObject({
        passes: [{ outcome: "refused", reason: "tracker_failed" }],
      });
    }
    expect(outcome.claim).toEqual([]);
    expect(planCalls()).toBe(0);
  });

  it("refuses an answer naming issues outside the plan, or one issue twice, with every fault, and stores nothing", async () => {
    const { answer, fake, key, runtime, planCalls } = world();
    answer.body = JSON.stringify({
      proposals: [
        { kind: "close", issue: "OPS-404", reason: "gone" },
        {
          kind: "rescope",
          issue: `${key.split("-")[0]}-13`,
          title: "narrower",
          goal: "g",
          change: "c",
          acceptance: ["a"],
        },
        { kind: "close", issue: `${key.split("-")[0]}-13`, reason: "obsolete" },
      ],
    });
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        const first = yield* delivery(pr, ON);
        const again = yield* delivery(pr, ON);
        const refused = yield* Effect.exit(
          sessions.refreshPlan({
            sessionId: runs.spec,
            key: "merged:by-hand",
            trigger: { pr, number: 7 },
            maxCost: 1,
          }),
        );
        return {
          first,
          again,
          refused,
          spec: yield* sessions.get(runs.spec),
          claim: yield* claimOf(`plan-freshness:${runs.spec}:${pr}`),
        };
      }),
    );
    expect(outcome.first).toMatchObject({
      passes: [{ outcome: "refused", reason: "refused_answer" }],
    });
    expect(outcome.again).toMatchObject({ passes: [{ outcome: "replayed" }] });
    const error = errorOf(outcome.refused);
    if (!Schema.is(PlanProposalsRefused)(error)) {
      throw new Error(`expected PlanProposalsRefused, got ${String(error)}`);
    }
    expect(error.faults.map((fault) => [fault.index, fault.reason])).toEqual([
      [0, "unknown_issue"],
      [2, "duplicate_issue"],
    ]);
    expect(outcome.claim[0]?.skipReason).toContain("OPS-404");
    // The delivery's call and the by-hand call; the redelivery paid for nothing.
    expect(planCalls()).toBe(2);
    expect(outcome.spec.planRevisions).toBeUndefined();
    expect(fake.writes()).toEqual([]);
  });

  it("declining makes no call and sends nothing, and a declined revision cannot be approved", async () => {
    const { fake, key, runtime, planCalls } = world();
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        yield* delivery(pr, ON);
        const readsBefore = fake.seen.length;
        const declined = yield* sessions.declinePlanRevision({
          sessionId: runs.spec,
          key: `merged:${pr}`,
        });
        const again = yield* delivery(pr, ON);
        const approve = yield* Effect.exit(
          sessions.approvePlanRevision({
            sessionId: runs.spec,
            key: `merged:${pr}`,
            approved: [0],
          }),
        );
        const unknown = yield* Effect.exit(
          sessions.declinePlanRevision({
            sessionId: runs.spec,
            key: "merged:nope",
          }),
        );
        return {
          declined,
          again,
          approve,
          unknown,
          readsBefore,
          spec: yield* sessions.get(runs.spec),
        };
      }),
    );
    expect(outcome.declined.decision).toBe("declined");
    expect(outcome.again).toMatchObject({ passes: [{ outcome: "replayed" }] });
    expect(planCalls()).toBe(1);
    expect(errorOf(outcome.approve)).toMatchObject({
      _tag: "ApproveProposalsError",
      reason: "declined",
    });
    expect(errorOf(outcome.unknown)).toMatchObject({ reason: "no_proposals" });
    expect(outcome.spec.planRevisions?.[0]?.decision).toBe("declined");
    // Nothing was sent by the decline or the refused approval, not even a read.
    expect(fake.seen.length).toBe(outcome.readsBefore);
    expect(fake.writes()).toEqual([]);
  });

  it("applies approved proposals of each kind once, through the tracker port, and a second approval sends nothing", async () => {
    const { answer, fake, key, runtime } = world();
    const prefix = key.split("-")[0];
    answer.body = JSON.stringify({
      proposals: [
        {
          kind: "add",
          title: "the RPC answers",
          goal: "g",
          change: "c",
          acceptance: ["the RPC answers"],
        },
        {
          kind: "rescope",
          issue: `${prefix}-13`,
          title: "the RPC, all of it",
          goal: "g",
          change: "c",
          acceptance: ["the RPC answers"],
        },
        {
          kind: "close",
          issue: `${prefix}-12`,
          reason: "no criterion asks for a dashboard",
        },
      ],
    });
    const pr = prUrl();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const runs = yield* merged(key, pr);
        yield* delivery(pr, ON);
        const approved = yield* sessions.approvePlanRevision({
          sessionId: runs.spec,
          key: `merged:${pr}`,
          approved: [0, 1, 2],
        });
        const writesAfterFirst = fake.writes().length;
        const again = yield* sessions.approvePlanRevision({
          sessionId: runs.spec,
          key: `merged:${pr}`,
          approved: [0, 1, 2],
        });
        return {
          approved,
          again,
          writesAfterFirst,
          spec: yield* sessions.get(runs.spec),
        };
      }),
    );
    expect(outcome.approved.applied).toEqual([0, 1, 2]);
    expect(outcome.again.applied).toEqual([]);
    expect(fake.writes().length).toBe(outcome.writesAfterFirst);
    expect(fake.writes("issueCreate")).toHaveLength(1);
    expect(fake.writes("issueUpdate")).toHaveLength(2);
    expect(fake.writes("commentCreate")).toHaveLength(2);
    const rescoped = fake.children.find(
      (one) => one.identifier === `${prefix}-13`,
    );
    expect(rescoped?.title).toBe("the RPC, all of it");
    expect(rescoped?.description).toContain("- [ ] the RPC answers");
    expect(rescoped?.comments).toHaveLength(1);
    const closed = fake.children.find(
      (one) => one.identifier === `${prefix}-12`,
    );
    expect(closed?.state).toEqual(CANCELED);
    expect(closed?.comments[0]).toContain("no criterion asks for a dashboard");
    expect(fake.children.at(-1)?.title).toBe("the RPC answers");
    expect(
      outcome.spec.planRevisions?.[0]?.proposals.map(
        (one) => one.applied?.identifier,
      ),
    ).toEqual([
      fake.children.at(-1)?.identifier,
      `${prefix}-13`,
      `${prefix}-12`,
    ]);
  });
});
