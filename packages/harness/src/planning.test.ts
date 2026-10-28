/**
 * The planning run's `plan` tool, at the harness seam (D10).
 *
 * The card is the control plane's; what is proven here is what the harness does with the callback it
 * is handed: that a planner run — scripted through `FAUX_MODEL_SCRIPTS`' `plan` row, as the board's
 * drive scripts it — calls the tool and the plan is committed to its log and posted, that a plan
 * without `risks` is refused naming the field (nothing committed, nothing posted) and the run
 * retries, and that no other run is offered the tool. `packages/core`'s session suite drives the
 * same path through a real card, and `.pi/skills/verify-board/drive.sh` through `factory board`.
 *
 * No database: Pi Durable's in-memory storage and the faux provider, so this runs in the default gate.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TranscriptEntry } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RunProfile } from "./loader";
import {
  createFauxModelAccess,
  FAUX_MODEL_ID,
  parseFauxModelScripts,
  type FauxSpecAttempt,
} from "./models";
import { decodePlan, projectPlan, type Plan } from "./plan";
import {
  describePlan,
  PLAN_TOOL,
  type PlanOptions,
  type PlanReceipt,
} from "./planning";
import { decideStageCall, readOnlyStageOf } from "./policy";
import {
  closeHarness,
  openSession,
  readOfferedTools,
  readPlan,
  readSessionLog,
  submitMessage,
} from "./session";

const TASK = "tsk_00000000000000000000000000";

const PLAN = {
  summary: "Export the card count from the web app",
  steps: ["add apps/web/src/card.ts exporting the count", "verify web"],
  surfaces: ["web"],
  risks: ["the count is read before the board loads"],
} as const;

/** The plan a model that forgot the field sends: every field but `risks`. */
const WITHOUT_RISKS: FauxSpecAttempt = {
  summary: PLAN.summary,
  steps: [...PLAN.steps],
  surfaces: [...PLAN.surfaces],
};

const COMPLETE: FauxSpecAttempt = { ...WITHOUT_RISKS, risks: [...PLAN.risks] };

const call = (name: string, args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id: "call-1",
  name,
  arguments: args,
});

const planner: RunProfile = { column: "planning", role: "planner", skills: [] };

/** A poster that records what it was handed and answers the card at revision 4. */
const recorder = () => {
  const posts: { plan: Plan; callId: string }[] = [];
  const options: PlanOptions = {
    post: (request) => {
      posts.push(request);
      return Promise.resolve<PlanReceipt>({ taskId: TASK, revision: 4 });
    },
  };
  return { posts, options };
};

/**
 * One run of a session, settled. The attempts are the faux model's own script row, read the way
 * `apps/api` reads `FAUX_MODEL_SCRIPTS` — so the drive's table shape is what is proven here.
 */
const runOnce = (options: {
  readonly run?: RunProfile;
  readonly plan?: PlanOptions;
  readonly attempts: readonly FauxSpecAttempt[];
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scripts = yield* parseFauxModelScripts(
        JSON.stringify({
          [FAUX_MODEL_ID]: { command: "ls", plan: options.attempts },
        }),
        [FAUX_MODEL_ID],
      );
      const faux = createFauxModelAccess({ fauxModelScripts: scripts });
      const storage = new MemoryStorage();
      const { harness, root } = yield* openSession({
        storage,
        model: faux.access,
        cwd: mkdtempSync(join(tmpdir(), "factory-planning-")),
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.plan === undefined ? {} : { plan: options.plan }),
      });
      const submitted = yield* submitMessage(root, {
        content: "plan this card",
      });
      yield* Effect.promise(() =>
        submitted.submission.wait(BACKGROUND_CONTEXT),
      );
      const plan = yield* readPlan(harness, root);
      const log = yield* readSessionLog(storage);
      const offered = yield* readOfferedTools(storage);
      yield* closeHarness(harness);
      return { plan, offered, entries: log.entries };
    }),
  );

const planResults = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === PLAN_TOOL,
  );

describe("the plan validator", () => {
  const refused = (input: unknown) =>
    Effect.runSync(
      decodePlan(input).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
      ),
    );

  /** Mutation: give `risks` a default — the absent field would decode as "no risks". */
  it("refuses a plan without `risks`, naming it, and accepts the explicit none", () => {
    const missing = refused(WITHOUT_RISKS);
    expect(missing?.field).toBe("risks");
    expect(missing?.reason).toBe("missing");
    expect(missing?.message).toBe(
      "plan refused: `risks` is missing — declare the risks, `[]` when there are none",
    );
    expect(refused({ ...COMPLETE, risks: [] })).toBeUndefined();
  });

  /** Mutation: let `steps` or `surfaces` be empty — a plan of nothing would meet `plan_doc`. */
  it("refuses a plan with no step or no surface, and names every fault at once", () => {
    const empty = refused({ ...COMPLETE, steps: [], surfaces: [] });
    expect(empty?.reason).toBe("invalid");
    expect(empty?.fields).toEqual(["steps", "surfaces"]);
    expect(refused({ ...COMPLETE, risks: [""] })?.field).toBe("risks.0");
    expect(refused({ ...COMPLETE, summary: "" })?.field).toBe("summary");
    expect(refused("a plan")?.field).toBe("plan");
  });

  it("reads the document's seed as no plan", () => {
    expect(
      projectPlan({ summary: "", steps: [], surfaces: [], risks: [] }),
    ).toBeUndefined();
    expect(projectPlan(COMPLETE)).toEqual(PLAN);
  });
});

describe("the plan tool", () => {
  it("commits a planner's plan to its log and posts it on the card, keyed by the call", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: planner,
      plan: options,
      attempts: [COMPLETE],
    });

    expect(ran.offered).toContain(PLAN_TOOL);
    expect(ran.plan).toEqual(PLAN);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.plan).toEqual(PLAN);
    const results = planResults(ran.entries);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: false,
      text: describePlan(PLAN, { taskId: TASK, revision: 4 }),
    });
    const logged = ran.entries
      .flatMap((entry) => entry.toolCalls)
      .find((ref) => ref.name === PLAN_TOOL);
    expect(logged?.id).toBeDefined();
    expect(posts[0]?.callId).toBe(logged?.id);
    // The run goes on after it plans and ends on its own answer: the plan does not end it.
    expect(ran.entries.at(-1)?.kind).toBe("assistant");
  });

  it("refuses a plan missing `risks`, posting nothing, and the run retries with it", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: planner,
      plan: options,
      attempts: [WITHOUT_RISKS, COMPLETE],
    });

    const results = planResults(ran.entries);
    expect(results.map((result) => result.isError)).toEqual([true, false]);
    expect(results[0]?.text).toContain("plan refused: `risks` is missing");
    expect(posts).toHaveLength(1);
    expect(ran.plan).toEqual(PLAN);
  });

  it("commits and posts nothing when every attempt is refused", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: planner,
      plan: options,
      attempts: [WITHOUT_RISKS, { ...COMPLETE, steps: [] }],
    });
    expect(planResults(ran.entries).map((result) => result.isError)).toEqual([
      true,
      true,
    ]);
    expect(posts).toHaveLength(0);
    expect(ran.plan).toBeUndefined();
  });

  it("reports a post the card refused as the tool's error, with the plan in the log", async () => {
    const ran = await runOnce({
      run: planner,
      plan: { post: () => Promise.reject(new Error("no task tsk_gone")) },
      attempts: [COMPLETE],
    });
    const results = planResults(ran.entries);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.text).toContain("no task tsk_gone");
    expect(ran.plan).toEqual(PLAN);
  });
});

describe("who is offered the plan tool", () => {
  /** Mutation: install the tool whenever a callback is given — every other run would plan. */
  it("is not offered outside the planning role, so no other run can plan", async () => {
    const { posts, options } = recorder();
    for (const run of [
      { column: "specifying", role: "specifier", skills: [] },
      { column: "building", role: "builder", skills: [] },
      { column: "planning", skills: [] },
      undefined,
    ] satisfies (RunProfile | undefined)[]) {
      const ran = await runOnce({
        ...(run === undefined ? {} : { run }),
        plan: options,
        attempts: [COMPLETE],
      });
      expect(ran.offered).not.toContain(PLAN_TOOL);
      expect(planResults(ran.entries)).toHaveLength(0);
      expect(ran.plan).toBeUndefined();
    }
    expect(posts).toHaveLength(0);
  });

  it("is not offered to a planner with no card to post on", async () => {
    const ran = await runOnce({ run: planner, attempts: [COMPLETE] });
    expect(ran.offered).not.toContain(PLAN_TOOL);
    expect(ran.plan).toBeUndefined();
  });

  it("is a call the read-only planning stage lets through, while its refusals stand", () => {
    const stage = readOnlyStageOf(planner);
    expect(stage?.stage).toBe("planning");
    if (stage === undefined) return;
    expect(decideStageCall(stage, call(PLAN_TOOL, COMPLETE))).toEqual({
      _tag: "allow",
    });
    expect(
      decideStageCall(stage, call("edit", { path: "a.ts", edits: [] }))._tag,
    ).toBe("block");
  });
});
