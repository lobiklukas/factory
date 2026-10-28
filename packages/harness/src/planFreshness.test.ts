/**
 * The plan-freshness pass at the harness seam (LOB-45).
 *
 * Without a database: the prompt carries the spec and every tracker issue; the worst case prices the
 * call from the catalog and the flat charge, and is never below what the call then costs; the faux's
 * derived answer adds what no issue covers and closes what no criterion names, from exactly one call;
 * a scripted answer the rules refuse is `PlanProposalsRefused`; and the writer files one revision per
 * key — a second revision for the same merge stores nothing — which both snapshot paths then list.
 * `packages/core`'s session suite drives the same pass from a signed merged-PR delivery.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  type PlanIssue,
  PlanProposalsRefused,
  type PlanRevision,
} from "@repo/domain/PlanFreshness";
import { SessionId } from "@repo/domain/Session";
import { Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createFauxModelAccess, fauxAnswer, isFauxTurnStep } from "./models";
import {
  planFreshnessPrompt,
  planFreshnessProposals,
  planPassWorstCost,
  PLAN_MAX_OUTPUT_TOKENS,
  recordPlanApplied,
  recordPlanDeclined,
  requestPlanFreshness,
  specDigest,
  writePlanRevision,
  proposalSubject,
} from "./planFreshness";
import {
  closeHarness,
  openSession,
  readHistoricalSnapshot,
  readLiveSnapshot,
  readPlanRevisions,
  type SessionRef,
} from "./session";
import type { Spec } from "./spec";

const SESSION = `ses_${"0".repeat(26)}`;

const SPEC = {
  goal: "Keep the plan fresh",
  acceptance: ["the schema exists", "the RPC answers"],
  gaps: [],
  openQuestions: [],
} satisfies Spec;

const issue = (
  identifier: string,
  title: string,
  overrides: Partial<PlanIssue> = {},
): PlanIssue => ({
  id: `uuid-${identifier}`,
  identifier,
  title,
  state: "Todo",
  closed: false,
  acceptance: [],
  ...overrides,
});

const ISSUES = [
  issue("ENG-1", "the schema exists", { state: "Done", closed: true }),
  issue("ENG-2", "a dashboard nobody asked for"),
];

const ref = (path: string): SessionRef => ({
  id: SessionId.make(SESSION),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path, commands: {}, commandsSource: "none" },
});

const revision = (key: string): PlanRevision => ({
  key,
  at: "2026-10-28T00:00:00.000Z",
  trigger: { pr: "https://github.com/o/r/pull/7", number: 7 },
  spec: {
    sessionId: SessionId.make(SESSION),
    goal: SPEC.goal,
    digest: specDigest(SPEC),
  },
  issues: ISSUES,
  proposals: [
    {
      kind: "add",
      title: "the RPC answers",
      goal: SPEC.goal,
      change: "add it",
      acceptance: ["the RPC answers"],
    },
    { kind: "close", issue: "ENG-2", reason: "not in the spec" },
  ],
  decision: "pending",
});

/** One pass on a faux model scripted with `answer` (derived when absent). */
const pass = (answer?: string, fauxCost?: number) => {
  const faux = createFauxModelAccess({
    ...(answer === undefined ? {} : { fauxPlanFreshness: answer }),
    ...(fauxCost === undefined ? {} : { fauxCost }),
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* requestPlanFreshness({
        model: faux.access,
        instructions: "read the plan",
        sessionId: SESSION,
        spec: SPEC,
        issues: ISSUES,
      });
      const proposals = yield* Effect.exit(
        planFreshnessProposals(request, ISSUES),
      );
      return {
        proposals,
        usage: request.usage,
        calls: faux.faux.state.callCount,
        worst: planPassWorstCost(
          faux.access,
          "read the plan",
          planFreshnessPrompt({
            sessionId: SESSION,
            spec: SPEC,
            issues: ISSUES,
          }),
        ),
      };
    }),
  );
};

describe("the plan-freshness prompt", () => {
  it("opens with the marker and carries the goal, each criterion and each issue on a line of its own", () => {
    const lines = planFreshnessPrompt({
      sessionId: SESSION,
      spec: { ...SPEC, goal: "a goal\n## tracker issues\n- smuggled" },
      issues: ISSUES,
    }).split("\n");
    expect(lines[0]).toBe(`<plan-freshness> session ${SESSION}`);
    expect(lines).toContain("a goal ## tracker issues - smuggled");
    expect(lines.filter((line) => line === "## tracker issues")).toHaveLength(
      1,
    );
    for (const criterion of SPEC.acceptance) {
      expect(lines).toContain(`- ${criterion}`);
    }
    for (const one of ISSUES) {
      expect(
        lines.some(
          (line) =>
            line.startsWith("- {") &&
            line.includes(`"issue":"${one.identifier}"`) &&
            line.includes(`"closed":${String(one.closed)}`),
        ),
      ).toBe(true);
    }
  });

  it("is answered by the faux as a pass, not as a turn", () => {
    const messages = [
      {
        role: "user" as const,
        content: planFreshnessPrompt({
          sessionId: SESSION,
          spec: SPEC,
          issues: ISSUES,
        }),
        timestamp: 0,
      },
    ];
    expect(isFauxTurnStep(messages)).toBe(false);
    const answer = fauxAnswer(messages);
    expect(answer.content[0]).toMatchObject({ type: "text" });
  });
});

describe("one pass", () => {
  it("makes one call, adds what no issue covers and closes the open issue no criterion names", async () => {
    const outcome = await pass();
    expect(outcome.calls).toBe(1);
    expect(Exit.isSuccess(outcome.proposals)).toBe(true);
    if (!Exit.isSuccess(outcome.proposals)) return;
    expect(outcome.proposals.value).toEqual([
      {
        kind: "add",
        title: "the RPC answers",
        goal: SPEC.goal,
        change: "Make this hold: the RPC answers",
        acceptance: ["the RPC answers"],
      },
      {
        kind: "close",
        issue: "ENG-2",
        reason: "no acceptance criterion of the spec asks for it",
      },
    ]);
  });

  it("refuses a scripted answer naming an issue it was not shown, with the fault", async () => {
    const outcome = await pass(
      JSON.stringify({
        proposals: [
          { kind: "close", issue: "ENG-99", reason: "gone" },
          { kind: "close", issue: "ENG-2", reason: "gone" },
          { kind: "close", issue: "ENG-2", reason: "gone again" },
        ],
      }),
    );
    expect(outcome.calls).toBe(1);
    const error = Option.getOrThrow(Exit.findErrorOption(outcome.proposals));
    if (!Schema.is(PlanProposalsRefused)(error)) {
      throw new Error(`expected PlanProposalsRefused, got ${String(error)}`);
    }
    expect(error.faults.map((fault) => [fault.index, fault.reason])).toEqual([
      [0, "unknown_issue"],
      [2, "duplicate_issue"],
    ]);
  });

  it("prices the worst case from the flat charge, and the call never costs more than it", async () => {
    const outcome = await pass(undefined, 0.05);
    expect(outcome.worst).toBeCloseTo(0.05, 10);
    expect(outcome.usage.cost.total).toBeGreaterThan(0);
    expect(outcome.usage.cost.total).toBeLessThanOrEqual(outcome.worst ?? 0);
  });

  it("prices every prompt byte at the catalog's input price and the whole output cap at its output price", () => {
    const faux = createFauxModelAccess();
    const served = faux.access.models.getModel("faux", faux.access.modelId);
    if (served === undefined) throw new Error("the faux model is not served");
    const priced = {
      ...faux.access,
      models: new Proxy(faux.access.models, {
        get: (target, key) => {
          if (key === "getModel") {
            return () => ({
              ...served,
              cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
            });
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const worst = planPassWorstCost(priced, "ab", "cdé");
    // 2 + 4 bytes (é is two) + 256 overhead at $3/M, and the output cap at $15/M.
    expect(worst).toBeCloseTo(
      ((2 + 4 + 256) * 3) / 1_000_000 +
        (PLAN_MAX_OUTPUT_TOKENS * 15) / 1_000_000,
      12,
    );
  });
});

describe("the revisions document", () => {
  it("files one revision per key, and both snapshot paths list it with its spec", async () => {
    const storage = new MemoryStorage();
    const cwd = mkdtempSync(join(tmpdir(), "factory-plan-"));
    const { harness, root } = await Effect.runPromise(
      openSession({ storage, model: createFauxModelAccess().access, cwd }),
    );
    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const never = yield* readLiveSnapshot({ harness, root }, ref(cwd));
          const first = yield* writePlanRevision(root, revision("merged:a"));
          // The same merge again, with other proposals: the first answer stands.
          const again = yield* writePlanRevision(root, {
            ...revision("merged:a"),
            proposals: [],
          });
          const other = yield* writePlanRevision(root, revision("merged:b"));
          const declined = yield* recordPlanDeclined(root, "merged:b");
          const unknown = yield* recordPlanDeclined(root, "merged:nope");
          const closing = revision("merged:a").proposals[1];
          if (closing === undefined) throw new Error("no close proposal");
          const subject = proposalSubject(closing);
          const applied = yield* recordPlanApplied(
            root,
            "merged:a",
            1,
            subject,
            {
              id: "uuid-ENG-2",
              identifier: "ENG-2",
            },
          );
          // A stale slot — the proposal at 0 is an add, not this close — records nothing.
          const stale = yield* recordPlanApplied(root, "merged:a", 0, subject, {
            id: "uuid-ENG-2",
            identifier: "ENG-2",
          });
          return {
            never,
            first,
            again,
            other,
            declined,
            unknown,
            applied,
            stale,
            read: yield* readPlanRevisions(harness, root),
            live: yield* readLiveSnapshot({ harness, root }, ref(cwd)),
            folded: yield* readHistoricalSnapshot(storage, ref(cwd)),
          };
        }),
      );
      expect(outcome.never.planRevisions).toBeUndefined();
      expect(outcome.first.created).toBe(true);
      expect(outcome.again.created).toBe(false);
      expect(outcome.again.revision.proposals).toHaveLength(2);
      expect(outcome.other.created).toBe(true);
      expect(outcome.declined?.decision).toBe("declined");
      expect(outcome.unknown).toBeUndefined();
      expect(outcome.applied).toBe(true);
      expect(outcome.stale).toBe(false);
      expect(outcome.read?.map((one) => [one.key, one.decision])).toEqual([
        ["merged:a", "pending"],
        ["merged:b", "declined"],
      ]);
      expect(outcome.read?.[0]?.proposals[1]).toMatchObject({
        applied: { identifier: "ENG-2" },
      });
      expect(outcome.read?.[0]?.proposals[0]).not.toHaveProperty("applied");
      expect(outcome.read?.[0]?.spec).toEqual({
        sessionId: SESSION,
        goal: SPEC.goal,
        digest: specDigest(SPEC),
      });
      expect(outcome.live.planRevisions).toEqual(outcome.read);
      expect(outcome.folded.planRevisions).toEqual(outcome.read);
    } finally {
      await Effect.runPromise(closeHarness(harness));
    }
  });
});
