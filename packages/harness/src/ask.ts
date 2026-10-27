/**
 * The ask on the task (LOB-73, part 2 of LOB-46): a run that needs a person **ends**, parked, with
 * its question recorded on the card — and the next run reads the card's whole thread as context.
 *
 * docs/board.md B7 is the rule: asking happens on the task, never in the transcript. Runs here are
 * headless, so a question put to "whoever is watching" is a question nobody answers — Hermes shipped
 * that bug (the worker asked through the interactive channel, timed out, the card sat in `running`,
 * the worker invented a fallback), and Symphony's spec makes it normative that a run must not stall
 * waiting for input. Two halves live here, both model-facing and both without a database:
 *
 * - **`ask`**, a tool. Its call records the question through a callback the control plane supplies
 *   (`AskOptions.ask` — a `question` comment and a `needs_input` block, in one transaction) and
 *   returns `control: { terminate: true }`, so Pi Durable ends the run without another model request.
 *   Nothing waits: the run is not busy after it asks, which is the property the drive asserts. Pi
 *   Durable ends a run only when *every* call of the round asks to, so `ask` refuses — before it
 *   records anything — a round it does not have to itself: a question beside a `bash` call would block
 *   the card while the run went on working past it.
 * - **The thread section**, a prompt section carrying the card's comments, verbatim and oldest first,
 *   within `THREAD_CHAR_CAP`. Its renderer reads the thread through a callback (`ThreadReader`) before
 *   every request, so a question asked by one run and answered by a person reaches the next request
 *   on the card — a new run's or a live one's — and the `pi.system` entry it commits is the record of
 *   what the run was told.
 *
 * The card, the comment store and the block are the control plane's (`@repo/core`'s `TaskService`);
 * this module only knows a callback and a list, which is what keeps the harness free of Postgres.
 */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { Extension, PromptSection } from "@earendil-works/pi-durable";
import {
  defineExtension,
  defineTool,
  LiveDoc,
  section,
} from "@earendil-works/pi-durable";
import { MAX_COMMENT_CHARS, type TaskComment } from "@repo/domain/Task";

/** The tool's name, as the model calls it and as its result is found in the log. */
export const ASK_TOOL = "ask";

/** The name the extension carrying the tool is installed under. */
export const ASK_EXTENSION = "factory.ask";

/** The thread's section key, and so its `<task_thread>` tag in the rendered prompt. */
export const THREAD_SECTION_KEY = "task_thread";

/** The name the extension carrying the thread section is installed under. */
export const THREAD_EXTENSION = "factory.thread";

/** Where a recorded question left the card: the receipt the tool reports to the model. */
export type AskReceipt = {
  readonly taskId: string;
  /** The column the card is blocked from (B4). */
  readonly column: string;
  /** The card's revision after the ask. */
  readonly revision: number;
};

export type AskOptions = {
  /**
   * Record the question on the run's card. `callId` is the tool call's own id, unique in the log, so
   * the control plane can make the ask idempotent: a replayed call records nothing twice.
   *
   * A rejection is reported to the model as the tool's error and does **not** end the run — a
   * question that was never recorded must not park a run nobody will be told to answer.
   */
  readonly ask: (request: {
    readonly question: string;
    readonly callId: string;
  }) => Promise<AskReceipt>;
};

/**
 * What the model is told when it asked beside other calls: nothing was recorded, and why. Pi Durable
 * ends a run only when every result of its round asks it to, so a question that shared its round
 * would block the card while the run carried on — the hanging run B7 forbids.
 */
export const describeCrowdedAsk = (calls: number): string =>
  `ask was not recorded: it was one of ${calls} tool calls in this response, and a question has to ` +
  "end the run. Finish the other work first, then call ask alone, as the only tool call of its response.";

/** What the model is told after it asked: the question is on the card, and this run is over. */
export const describeAsk = (receipt: AskReceipt): string =>
  `Asked on task ${receipt.taskId}: the card is blocked (needs_input) from ${receipt.column} ` +
  `at revision ${receipt.revision}. This run ends here. The answer will be a comment on the task, ` +
  "and the next run reads the task's thread.";

/**
 * The `ask` tool, bound to one run's card.
 *
 * `replay: "safe"` because the callback is idempotent by call id: a process that died after the
 * question was recorded but before the result was committed reruns the call on reopen, and the rerun
 * finds the question it already wrote instead of asking again.
 */
export const askTool = (options: AskOptions) =>
  defineTool({
    name: ASK_TOOL,
    description:
      "Ask a person a question on this run's task, when the work cannot go on without their " +
      "input: a missing requirement, an ambiguous goal, a decision that is theirs to make. The " +
      "question is recorded on the task, the card is blocked needs_input, and this run ends. Do not " +
      "wait for an answer and do not guess one: the answer is a comment on the task, and the next " +
      "run reads the task's whole thread. Put everything you need to ask into one question, and " +
      "call ask alone: as the only tool call of its response, never beside another call.",
    parameters: Type.Object({
      question: Type.String({
        description: "The question, as the person who answers it will read it",
        maxLength: MAX_COMMENT_CHARS,
      }),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: (args, api, context) =>
      // The round as the generation committed it, every call in call order — including calls the
      // request did not offer and calls a hook blocked, neither of which can ask to terminate. A
      // replayed call reads the same round, so a refusal and a recording are both stable on reopen.
      api
        .snapshot(LiveDoc, api.conversationId, context)
        .then((live) => {
          const calls = live?.tools?.length ?? 0;
          if (calls > 1) throw new Error(describeCrowdedAsk(calls));
          return options.ask({ question: args.question, callId: api.callId });
        })
        .then((receipt) => {
          const details: JsonValue = {
            taskId: receipt.taskId,
            column: receipt.column,
            revision: receipt.revision,
            question: args.question,
          };
          return {
            content: [{ type: "text" as const, text: describeAsk(receipt) }],
            details,
            // The run ends here, without another model request (Pi Durable ends a run when every
            // result of the round asks for it). That is "parked, not hanging": nothing holds a turn
            // open waiting for a person.
            control: { terminate: true as const },
          };
        }),
  });

/** The extension installed beside `CodingTools` at `openSession`, for a run bound to a card. */
export const askExtension = (options: AskOptions): Extension =>
  defineExtension({ name: ASK_EXTENSION, tools: [askTool(options)] });

/**
 * The thread's budget in the prompt, in characters (about 10,000 tokens). Every run on the card pays
 * it on every request, so a long-lived card or a pasted log cannot grow the system prompt without
 * bound. It holds the two newest comments whatever they are — each at most `MAX_COMMENT_CHARS` — so
 * the latest question and the answer to it are always quoted whole.
 */
export const THREAD_CHAR_CAP = 40_000;

/** One comment as prompt text: who wrote it and what it is, then its body exactly as written. */
const blockOf = (comment: TaskComment): string =>
  `[${comment.kind}] ${comment.actor} at revision ${comment.revision}:\n${comment.body}`;

const THREAD_PREAMBLE =
  "The task's thread, oldest first, each comment quoted verbatim. A question is what an " +
  "earlier run asked when it stopped; an answer is a person's reply to it. Work from the " +
  "answers, and do not ask again what is answered here.";

/** The marker that stands where older comments were left out to keep the thread in budget. */
export const omittedMarker = (count: number): string =>
  `[${count} older comment${count === 1 ? "" : "s"} omitted to keep the thread within its budget]`;

/**
 * The thread as the section's inner text, or `undefined` when the card has no comments — no section
 * at all rather than an empty one, the rule every other section here follows.
 *
 * Bodies are not trimmed, wrapped or summarized: the claim the stage makes is that the answer is
 * quoted *verbatim* into the next run's context, and a reformatted answer is a paraphrase. What the
 * budget drops is whole comments, oldest first, and the marker says how many.
 */
export const renderThread = (
  comments: readonly TaskComment[],
  cap: number = THREAD_CHAR_CAP,
): string | undefined => {
  if (comments.length === 0) return undefined;
  const kept: string[] = [];
  let used = 0;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const block = blockOf(comments[index] as TaskComment);
    // The newest two always stay: a question and its answer are never split by the budget.
    if (kept.length >= 2 && used + block.length > cap) break;
    kept.unshift(block);
    used += block.length;
  }
  const omitted = comments.length - kept.length;
  return [
    THREAD_PREAMBLE,
    ...(omitted > 0 ? [omittedMarker(omitted)] : []),
    ...kept,
  ].join("\n\n");
};

/**
 * How the thread section reads the card's thread, oldest first. The control plane supplies it; it is
 * called before every request, so a comment added while a run's harness is open — the answer to a
 * parked run, before a person messages that same session — is in the next request's prompt.
 */
export type ThreadReader = () => Promise<readonly TaskComment[]>;

/**
 * The thread as a prompt section (LOB-73). Rendered before each request; Pi Durable commits a new
 * `pi.system` entry only when the text changed, so an unchanged thread costs no prompt-cache miss.
 */
export const threadExtension = (read: ThreadReader): Extension => {
  const sections: PromptSection[] = [
    section(THREAD_SECTION_KEY, () =>
      read().then((comments) => renderThread(comments)),
    ),
  ];
  return defineExtension({ name: THREAD_EXTENSION, sections });
};
