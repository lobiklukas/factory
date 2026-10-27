/**
 * The decomposition pass over a session's spec (LOB-201, part 1 of LOB-43).
 *
 * A decomposition is not a session, for the reason a curation is not one (`./curate`): it makes
 * **one** model call — the `decompose` skill as its instructions, the session's spec as its input —
 * and commits what that call proposed as the session's `factory.proposedIssues` document. It opens
 * no child session, writes to no tracker, and starts nothing: a proposal is not a task until a
 * person accepts it (LOB-43), and accepting is part 2 (LOB-202).
 *
 * The answer passes through one validator, `decodeProposedIssues` (`@repo/domain/Decomposition`),
 * on its way to the one writer, `commitProposedIssues`. A refused answer commits nothing: the log
 * keeps whatever proposals it held before, so a bad second decomposition cannot erase a good first
 * one.
 */
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Clock, Effect, Option, Schema } from "effect";
import {
  decodeProposedIssues,
  type ProposalsRefused,
  type ProposedIssues,
} from "@repo/domain/Decomposition";
import { SessionError } from "@repo/domain/Session";
import { ProposedIssuesDoc } from "./docs";
import {
  DECOMPOSITION_ACCEPTANCE_HEADING,
  DECOMPOSITION_GOAL_HEADING,
  DECOMPOSITION_PROMPT_PREFIX,
  type ModelAccess,
} from "./models";
import { attempt, type Conversation } from "./session";
import type { Spec } from "./spec";

/**
 * The skill whose body is a decomposition's instructions, seeded by
 * `0021_seed_decompose_skill.ts`. Named here, once, so the seed and the caller cannot disagree.
 */
export const DECOMPOSITION_SKILL = "decompose";

/**
 * The most acceptance criteria a spec may carry into one decomposition. The input of one bounded
 * call is bounded too — and bounded by refusal, never by cutting: the criteria are the contract the
 * children are checked against, so a prompt that showed some of them would yield a committed set
 * grounded in part of the spec while the caller was told nothing.
 */
export const MAX_DECOMPOSED_CRITERIA = 50;
/** The longest goal or acceptance criterion, in characters, a decomposition is given whole. */
export const MAX_DECOMPOSED_LINE_CHARS = 1_000;

/**
 * Why `spec` cannot be decomposed as it stands, or `undefined` when it can: no criteria at all,
 * more than `MAX_DECOMPOSED_CRITERIA`, or a goal or criterion longer than
 * `MAX_DECOMPOSED_LINE_CHARS`. Pure, so the caller refuses before any call is made and a refusal
 * costs nothing; the prompt then carries every criterion, each whole.
 */
export const decompositionInputFault = (spec: Spec): string | undefined => {
  if (spec.acceptance.length === 0) {
    return "has no acceptance criteria to decompose against";
  }
  if (spec.acceptance.length > MAX_DECOMPOSED_CRITERIA) {
    return `has ${spec.acceptance.length} acceptance criteria; at most ${MAX_DECOMPOSED_CRITERIA} can be decomposed at once`;
  }
  if (spec.goal.length > MAX_DECOMPOSED_LINE_CHARS) {
    return `has a goal of ${spec.goal.length} characters; at most ${MAX_DECOMPOSED_LINE_CHARS} can be decomposed`;
  }
  const long = spec.acceptance.findIndex(
    (line) => line.length > MAX_DECOMPOSED_LINE_CHARS,
  );
  if (long >= 0) {
    return `has acceptance criterion ${long} of ${spec.acceptance[long]?.length ?? 0} characters; at most ${MAX_DECOMPOSED_LINE_CHARS} can be decomposed`;
  }
  return undefined;
};

/** One line of the prompt: whitespace folded, so the value cannot open a heading of its own. */
const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

export type DecompositionOptions = {
  /** The model the process serves; the one call runs on it. */
  readonly model: ModelAccess;
  /** The `decompose` skill's body: what the model is told before it is asked anything. */
  readonly instructions: string;
  /** The session decomposed, named in the prompt. */
  readonly sessionId: string;
  /** The session's spec, already read through `projectSpec`: the only input. */
  readonly spec: Spec;
};

/**
 * The one request's user message. The marker opens it, so a scripted model answers a
 * decomposition (`models.ts`); each value is on a line of its own under its heading, so the derived
 * faux answer reads the same spec back that a real model was shown. Every criterion is shown whole:
 * a spec too large for that is refused first (`decompositionInputFault`), not cut here.
 */
export const decompositionPrompt = (
  options: Pick<DecompositionOptions, "sessionId" | "spec">,
): string =>
  [
    `${DECOMPOSITION_PROMPT_PREFIX} session ${options.sessionId}`,
    "",
    DECOMPOSITION_GOAL_HEADING,
    oneLine(options.spec.goal),
    "",
    DECOMPOSITION_ACCEPTANCE_HEADING,
    ...options.spec.acceptance.map((line) => `- ${oneLine(line)}`),
    "",
    "## your answer",
    "Reply with only a JSON object shaped",
    '{"proposals": [{"title": "...", "goal": "...", "change": "...", "acceptance": ["..."], "blockedBy": []}]}.',
    "`blockedBy` names other proposals by their index in this list, and only where the order is real.",
    "Every proposal needs a title no other proposal has and at least one acceptance line.",
  ].join("\n");

/** One call's answer, and what that call cost. */
export type DecompositionRequest = {
  readonly answer: AssistantMessage;
  /** The call's spend. The caller charges it before it reads the answer: the call was made. */
  readonly usage: Usage;
};

/**
 * The one model call, and the only place this module reaches a provider. An error answer is not a
 * failure here, as in `requestCuration`: the call happened and was billed, and the caller charges it
 * before `decompositionProposals` refuses it.
 */
export const requestDecomposition = (
  options: DecompositionOptions,
): Effect.Effect<DecompositionRequest, SessionError> =>
  Effect.gen(function* () {
    // The caller refuses first (`proposeDecomposition`); refused here too, so no caller can send a
    // spec the prompt would not carry whole.
    const fault = decompositionInputFault(options.spec);
    if (fault !== undefined) {
      return yield* new SessionError({
        code: "invalid_input",
        message: `session ${options.sessionId}'s spec ${fault}`,
      });
    }
    const request = options.model.models.getModel(
      options.model.provider,
      options.model.modelId,
    );
    if (request === undefined) {
      return yield* new SessionError({
        code: "harness",
        message: `this process serves no model ${options.model.provider}/${options.model.modelId}, so nothing can decompose`,
      });
    }
    const message: Message = {
      role: "user",
      content: decompositionPrompt(options),
      timestamp: yield* Clock.currentTimeMillis,
    };
    const answer = yield* Effect.tryPromise({
      try: () =>
        options.model.models.completeSimple(request, {
          systemPrompt: options.instructions,
          messages: [message],
        }),
      catch: (cause) =>
        new SessionError({
          code: "harness",
          message: `the decomposition's model call failed: ${String(cause)}`,
        }),
    });
    return { answer, usage: answer.usage };
  });

/** The answer's text, flattened: a decomposition reads text, not a tool call. */
const answerText = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

const parseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown),
);

/**
 * The JSON value an answer carries, or the raw text when it carries none. A model that fences its
 * JSON in a Markdown block has still answered JSON, so the object is taken between its first `{`
 * and its last `}`; text that is not JSON is handed to the validator as it is, which refuses it as
 * `unreadable` rather than this module inventing a second kind of refusal.
 */
const answerValue = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return text;
  return Option.getOrElse(parseJson(text.slice(start, end + 1)), () => text);
};

/**
 * The proposals in a decomposition's answer, through the one validator. A failed call is the
 * harness's error; an answer the rules refuse is `ProposalsRefused`, naming every fault.
 */
export const decompositionProposals = (
  request: DecompositionRequest,
): Effect.Effect<ProposedIssues, SessionError | ProposalsRefused> =>
  request.answer.stopReason === "error"
    ? Effect.fail(
        new SessionError({
          code: "harness",
          message: `the decomposition's model call failed: ${request.answer.errorMessage ?? "no message"}`,
        }),
      )
    : decodeProposedIssues(answerValue(answerText(request.answer)));

/**
 * Commit `issues` as the conversation's `factory.proposedIssues` inside `tx`, replacing what was
 * there. Takes a value the validator accepted; `writeProposedIssues` is the writer that decodes.
 */
export const commitProposedIssues = (
  tx: Tx,
  conversationId: ConversationId,
  issues: ProposedIssues,
): Promise<void> =>
  tx.doc(ProposedIssuesDoc, conversationId).then((doc) => {
    doc.proposals = issues.proposals.map((proposal) => ({
      title: proposal.title,
      goal: proposal.goal,
      change: proposal.change,
      acceptance: [...proposal.acceptance],
      blockedBy: [...proposal.blockedBy],
    }));
  });

/**
 * Commit the session's proposed issues after `decodeProposedIssues` accepts them. The input is
 * `unknown` on purpose, as `writeSpec`'s is: the validator is the only thing that may say it is a
 * proposal set. A refusal commits nothing. Answers the set as committed — the decoded value.
 */
export const writeProposedIssues = (
  conversation: Conversation,
  input: unknown,
): Effect.Effect<ProposedIssues, ProposalsRefused | SessionError> =>
  Effect.gen(function* () {
    const issues = yield* decodeProposedIssues(input);
    yield* attempt("write proposed issues", () =>
      conversation.commit(
        (tx) => commitProposedIssues(tx, conversation.id, issues),
        BACKGROUND_CONTEXT,
      ),
    );
    return issues;
  });
