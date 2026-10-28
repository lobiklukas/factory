/**
 * The specifying run's writer (LOB-238): the `spec` tool, which commits the run's typed spec (LOB-72)
 * to its log and posts it on its card.
 *
 * LOB-72 built the validator and the document, and left `writeSpec` as their only writer — a harness
 * function no run could reach, so a specifying run could say what the card needed only in prose. This
 * is the run-side writer, and it is a tool rather than a file because the stage is read-only (LOB-74):
 * the tool changes the session's log and the card, never the workspace, so the read-only policy lets
 * it through (`stageRefusalOf` judges `write`, `edit`, `verify` and `bash`, and nothing else).
 *
 * - **One validator.** The arguments go through `decodeSpec` and nothing else: the tool's parameters
 *   describe the shape for the model, but every field is optional there, so a spec without `gaps`
 *   reaches LOB-72's refusal — "spec refused: `gaps` is missing — declare the gaps, `[]` when there
 *   are none" — instead of a generic schema error. The refusal is the tool's error, which the model
 *   reads; the run is not ended, and nothing is committed or posted, so it retries with the field.
 * - **The log, then the card.** The document is committed in the run's log first, which is the truth
 *   for what the run declared, then posted on the card through a callback the control plane supplies
 *   (`SpecOptions.post`, a `specified` event on the task) so the card shows it without a fold of the
 *   run's log. The callback is idempotent by tool call id, so a replay posts nothing twice.
 * - **Only for the specifier.** The tool is installed for a run whose column's role
 *   `writesSpec` (`./rolePolicy`, resolved by `./loader`'s `resolveRole`), and only when there is a card to post on — every other
 *   run is never offered it.
 *
 * It does not ask. A spec with gaps is the stage's evidence that it needs a person, and the ask on
 * the task is still how a run parks for one (LOB-73): the result tells the model to ask its open
 * questions, and `ask` — called alone, after the spec — is what blocks the card.
 */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { ConversationId, Extension, Tx } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SpecDoc } from "./docs";
import { decodeSpec, type Spec } from "./spec";
import { items, listed, validated } from "./stageTool";

/** The tool's name, as the model calls it and as its result is found in the log. */
export const SPEC_TOOL = "spec";

/** The name the extension carrying the tool is installed under. */
export const SPEC_EXTENSION = "factory.specify";

/** Where a posted spec left the card: the receipt the tool reports to the model. */
export type SpecReceipt = {
  readonly taskId: string;
  /** The card's revision after the post. */
  readonly revision: number;
};

export type SpecOptions = {
  /**
   * Post the committed spec on the run's card. `callId` is the tool call's own id, unique in the log,
   * so the control plane can make the post idempotent: a replayed call posts nothing twice.
   *
   * A rejection is reported to the model as the tool's error. The log already holds the spec by
   * then, and a retry commits the same value again, so a card that refused the post is told again
   * rather than left behind the log.
   */
  readonly post: (request: {
    readonly spec: Spec;
    readonly callId: string;
  }) => Promise<SpecReceipt>;
};

/**
 * Commit `spec` as the conversation's `factory.spec` inside `tx`. Every field is written, empty lists
 * included: a spec that kept an earlier attempt's gaps after a rewrite would declare gaps the
 * specifier withdrew. Shared by the tool and `writeSpec`, so the two writers cannot drift.
 */
export const commitSpec = (
  tx: Tx,
  conversationId: ConversationId,
  spec: Spec,
): Promise<void> =>
  tx.doc(SpecDoc, conversationId).then((doc) => {
    doc.goal = spec.goal;
    doc.acceptance = [...spec.acceptance];
    doc.gaps = [...spec.gaps];
    doc.openQuestions = [...spec.openQuestions];
  });

/**
 * What the model is told after its spec was committed and posted. A spec with gaps points the run at
 * the ask, because declaring a gap is not the same as asking anyone to close it.
 */
export const describeSpec = (spec: Spec, receipt: SpecReceipt): string => {
  const head =
    `Spec committed to this run's log and posted on task ${receipt.taskId} ` +
    `(revision ${receipt.revision}). Gaps: ${listed(spec.gaps)}.`;
  if (spec.gaps.length === 0) return `${head} Nothing is left to ask.`;
  return (
    `${head} Open questions: ${listed(spec.openQuestions)}. A gap is closed by a person: ask ` +
    "your open questions with the ask tool, in one question, as the only tool call of its response."
  );
};

/**
 * The `spec` tool, bound to one run's card.
 *
 * `replay: "safe"` because both halves are idempotent: the commit writes the same value again, and
 * the post is keyed by the call id.
 */
export const specTool = (options: SpecOptions) =>
  defineTool({
    name: SPEC_TOOL,
    description:
      "Declare this task's spec: the goal, the acceptance criteria the work is checked against, the " +
      "gaps — what the task is missing that you could not supply from the code and the thread — and " +
      "the open questions a person would have to answer to close them. Every field is required. " +
      "`gaps` and `openQuestions` are `[]` when there are none, and leaving one out is refused: say " +
      "explicitly that nothing is missing. The spec is committed to this run's log and posted on the " +
      "task. Call it again to replace it. When it declares gaps, ask the open questions with the ask " +
      "tool afterwards.",
    parameters: Type.Object({
      goal: Type.Optional(
        Type.String({ description: "What the task is for, in one statement" }),
      ),
      acceptance: items("The criteria the work is checked against"),
      gaps: items(
        "What the task is missing that you could not supply; [] when nothing is",
      ),
      openQuestions: items(
        "What you would ask a person to close the gaps; [] when there is nothing to ask",
      ),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: (args, api, context) =>
      validated(decodeSpec, args).then((spec) =>
        api
          .commit((tx) => commitSpec(tx, api.conversationId, spec), context)
          .then(() => options.post({ spec, callId: api.callId }))
          .then((receipt) => {
            const details: JsonValue = {
              taskId: receipt.taskId,
              revision: receipt.revision,
              goal: spec.goal,
              acceptance: [...spec.acceptance],
              gaps: [...spec.gaps],
              openQuestions: [...spec.openQuestions],
            };
            return {
              content: [
                { type: "text" as const, text: describeSpec(spec, receipt) },
              ],
              details,
            };
          }),
      ),
  });

/** The extension installed beside `CodingTools` at `openSession`, for a specifier run on a card. */
export const specExtension = (options: SpecOptions): Extension =>
  defineExtension({ name: SPEC_EXTENSION, tools: [specTool(options)] });
