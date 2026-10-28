/**
 * The planning run's writer (D10): the `plan` tool, which commits the run's typed plan (`./plan`) to
 * its log and posts it on its card.
 *
 * Shaped as the specifier's `spec` tool is (`./specify`, LOB-238), for the same reasons:
 *
 * - **A tool, not a file.** The planning stage is read-only (`./rolePolicy`'s `planner` row): the
 *   tool changes the session's log and the card, never the workspace, so the read-only policy lets
 *   it through (`stageRefusalOf` judges `write`, `edit`, `verify` and `bash`, and nothing else).
 * - **One validator.** The arguments go through `decodePlan` and nothing else: every field is
 *   optional in the tool's parameters, so a plan without `risks` reaches the stage's own refusal —
 *   "plan refused: `risks` is missing — declare the risks, `[]` when there are none" — instead of a
 *   generic schema error. The refusal is the tool's error, which the model reads; nothing is
 *   committed or posted, and the run retries with the field.
 * - **The log, then the card.** The plan is committed as the run's `factory.plan` first, which is
 *   the truth for what the run declared, then posted on the card through a callback the control
 *   plane supplies (`PlanOptions.post`, a `planned` event on the task) — what `plan_doc` is checked
 *   against, and what the person at the plan approval gate reads. The callback is idempotent by tool
 *   call id, so a replay posts nothing twice.
 * - **Only for the planner.** The tool is installed for a run whose role's row says `writesPlan`
 *   (`./loader`'s `resolveRole`), and only when there is a card to post on.
 * - **Told, not only offered.** The extension carries a short `plan_stage` section saying the stage
 *   exits only with a declared plan, so a run on a version whose planning column binds no `plan`
 *   skill (versions before 0044's) is still told to call the tool.
 */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { ConversationId, Extension, Tx } from "@earendil-works/pi-durable";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { PlanDoc } from "./docs";
import { decodePlan, type Plan } from "./plan";
import { items, listed, validated } from "./stageTool";

/** The tool's name, as the model calls it and as its result is found in the log. */
export const PLAN_TOOL = "plan";

/** The name the extension carrying the tool is installed under. */
export const PLAN_EXTENSION = "factory.planning";

/** The stage's section key, and so its `<plan_stage>` tag in the rendered prompt. */
export const PLAN_STAGE_SECTION_KEY = "plan_stage";

/**
 * What every planner run is told about its exit, whatever skills its column binds. `plan_doc` is
 * checked on every definition version, but only the versions seeded since 0044 bind the `plan` skill
 * to `planning`: a card pinned to an earlier one would otherwise learn of the tool only from its
 * description, and could settle in prose with a card that cannot leave the column.
 */
export const PLAN_STAGE_TEXT =
  "This is the planning stage: the card leaves it only once its plan is declared with the `plan` " +
  "tool (summary, steps, surfaces, risks). Read the card and the code, then declare the plan before " +
  "you finish; a plan written only in prose does not count. Do not build, and do not move the card: " +
  "a person approves the plan by moving it on.";

/** Where a posted plan left the card: the receipt the tool reports to the model. */
export type PlanReceipt = {
  readonly taskId: string;
  /** The card's revision after the post. */
  readonly revision: number;
};

export type PlanOptions = {
  /**
   * Post the committed plan on the run's card. `callId` is the tool call's own id, unique in the
   * log, so the control plane can make the post idempotent: a replayed call posts nothing twice. A
   * rejection is reported to the model as the tool's error; the log already holds the plan, and a
   * retry commits the same value again.
   */
  readonly post: (request: {
    readonly plan: Plan;
    readonly callId: string;
  }) => Promise<PlanReceipt>;
};

/**
 * Commit `plan` as the conversation's `factory.plan` inside `tx`. Every field is written, empty
 * `risks` included: a plan that kept an earlier attempt's risks after a rewrite would declare risks
 * the planner withdrew.
 */
export const commitPlan = (
  tx: Tx,
  conversationId: ConversationId,
  plan: Plan,
): Promise<void> =>
  tx.doc(PlanDoc, conversationId).then((doc) => {
    doc.summary = plan.summary;
    doc.steps = [...plan.steps];
    doc.surfaces = [...plan.surfaces];
    doc.risks = [...plan.risks];
  });

/**
 * What the model is told after its plan was committed and posted: where it is, and that a person
 * approves it — the run does not move the card on, the plan approval gate is a person's move.
 */
export const describePlan = (plan: Plan, receipt: PlanReceipt): string =>
  `Plan committed to this run's log and posted on task ${receipt.taskId} ` +
  `(revision ${receipt.revision}): ${plan.steps.length} step(s), surfaces ${listed(plan.surfaces)}, ` +
  `risks ${listed(plan.risks)}. A person approves the plan by moving the card on; ` +
  "do not start the work. Call the tool again to replace the plan.";

/**
 * The `plan` tool, bound to one run's card. `replay: "safe"` because both halves are idempotent:
 * the commit writes the same value again, and the post is keyed by the call id.
 */
export const planTool = (options: PlanOptions) =>
  defineTool({
    name: PLAN_TOOL,
    description:
      "Declare this task's plan for a person to approve before any code is written: a one-line " +
      "summary, the steps the building run will take in order, the surfaces (packages, apps, " +
      "verify-<surface> names) the change touches, and the risks. Every field is required; `steps` " +
      "and `surfaces` need at least one entry, and `risks` is `[]` when there are none — leaving it " +
      "out is refused. The plan is committed to this run's log and posted on the task. Call it " +
      "again to replace it.",
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({ description: "The plan in one statement" }),
      ),
      steps: items("What the building run will do, in order; at least one"),
      surfaces: items(
        "The parts of the repository the change touches; at least one",
      ),
      risks: items("What could go wrong; [] when there is nothing to declare"),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: (args, api, context) =>
      validated(decodePlan, args).then((plan) =>
        api
          .commit((tx) => commitPlan(tx, api.conversationId, plan), context)
          .then(() => options.post({ plan, callId: api.callId }))
          .then((receipt) => {
            const details: JsonValue = {
              taskId: receipt.taskId,
              revision: receipt.revision,
              summary: plan.summary,
              steps: [...plan.steps],
              surfaces: [...plan.surfaces],
              risks: [...plan.risks],
            };
            return {
              content: [
                { type: "text" as const, text: describePlan(plan, receipt) },
              ],
              details,
            };
          }),
      ),
  });

/** The extension installed beside `CodingTools` at `openSession`, for a planner run on a card. */
export const planExtension = (options: PlanOptions): Extension =>
  defineExtension({
    name: PLAN_EXTENSION,
    tools: [planTool(options)],
    sections: [section(PLAN_STAGE_SECTION_KEY, () => PLAN_STAGE_TEXT)],
  });
