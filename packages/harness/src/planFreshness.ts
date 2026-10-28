/**
 * The plan-freshness pass (LOB-45): after a factory PR merges, read the plan again.
 *
 * Shaped as a decomposition is (`./decompose`): **one** model call — the `plan-freshness` skill as its
 * instructions, the session's spec and the tracker's current issue set as its input — whose answer is
 * committed to the spec's session as one `PlanRevision` in `factory.planRevisions`. It opens no
 * session, has no tools, and writes to no tracker: a proposal is not a change until a person approves
 * it (`approvePlanRevision` in `@repo/core`).
 *
 * **The call is bounded before it is made.** `planPassWorstCost` prices the request at the dearest
 * rate the catalog could bill it at — every byte of the prompt as an input token (a token is never
 * shorter than a byte) at the highest of the input, cache-read and cache-write rates over the base
 * price and every tier, and the whole `PLAN_MAX_OUTPUT_TOKENS` the call is capped at at the highest
 * output rate, plus any flat per-call charge (`ModelAccess.flatCost`) — so the caller can refuse a
 * pass whose worst case is over its bound, and a pass it lets through cannot spend more than that
 * worst case. The call asks for no prompt cache (`cacheRetention: "none"`), so no 1h cache write,
 * which pi-ai bills at twice the input rate, can be made.
 *
 * **A billed call is always charged.** `requestPlanFreshness` charges the call's spend the moment it
 * settles, uninterruptibly; an interrupt while the call is in flight aborts it, awaits the answer the
 * provider settles with (its partial usage), and charges that before the interrupt goes on.
 *
 * The answer passes through one validator, `validatePlanProposals` (`@repo/domain/PlanFreshness`),
 * against the issue set the prompt showed, on its way to the one writer, `writePlanRevision`. A refused
 * answer commits nothing.
 */
import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Message,
  ModelCostRates,
  Usage,
} from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { titleKey, type CreatedIssue } from "@repo/domain/Decomposition";
import {
  type PlanIssue,
  type PlanProposal,
  type PlanProposalsRefused,
  type PlanRevision,
  type PlanTrigger,
  planProposalsRefused,
  projectPlanRevisions,
  validatePlanProposals,
} from "@repo/domain/PlanFreshness";
import { SessionError } from "@repo/domain/Session";
import { PlanRevisionsDoc } from "./docs";
import {
  DECOMPOSITION_ACCEPTANCE_HEADING,
  DECOMPOSITION_GOAL_HEADING,
  PLAN_ISSUES_HEADING,
  PLAN_PROMPT_PREFIX,
  type ModelAccess,
} from "./models";
import { attempt, type Conversation } from "./session";
import type { Spec } from "./spec";

/**
 * The skill whose body is a pass's instructions, seeded by `0033_seed_plan_freshness_skill.ts`.
 * Named here, once, so the seed and the caller cannot disagree.
 */
export const PLAN_FRESHNESS_SKILL = "plan-freshness";

/** The most output tokens one pass may produce: the cap the call is made with. */
export const PLAN_MAX_OUTPUT_TOKENS = 4_096;

/**
 * Tokens added to the prompt's byte count for what a provider wraps a request in (roles, the system
 * block), so the worst case stays an upper bound for a very short prompt too.
 */
export const PLAN_PROMPT_OVERHEAD_TOKENS = 256;

/** The newest revisions one session keeps; older ones age out, oldest first. */
export const MAX_PLAN_REVISIONS = 20;

/** One line of the prompt: whitespace folded, so the value cannot open a heading of its own. */
const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/**
 * A digest of the spec's goal and criteria: what a revision names the spec by, so a revision read
 * after the spec changed can be told from one made against the current spec.
 */
export const specDigest = (spec: Spec): string =>
  createHash("sha256")
    .update(JSON.stringify({ goal: spec.goal, acceptance: spec.acceptance }))
    .digest("hex")
    .slice(0, 16);

export type PlanFreshnessOptions = {
  /** The model the process serves; the one call runs on it. */
  readonly model: ModelAccess;
  /** The `plan-freshness` skill's body. */
  readonly instructions: string;
  /** The spec's session, named in the prompt. */
  readonly sessionId: string;
  /** The session's spec, already read through `projectSpec`. */
  readonly spec: Spec;
  /** The tracker's issue set, as `ProposalTarget.issues` read it. */
  readonly issues: readonly PlanIssue[];
  /**
   * The merge the pass answers, shown to the model so it can tell work the merge delivered from work
   * still missing. Absent: the prompt names no merge.
   */
  readonly trigger?: PlanTrigger | undefined;
};

/** The prompt's heading over the merge the pass answers. */
export const PLAN_MERGE_HEADING = "## the merge";

/**
 * The one request's user message. The marker opens it, so a scripted model answers a pass; the spec
 * is laid out under the decomposition's headings and each issue is one JSON object on a line of its
 * own, so the derived faux answer reads back exactly what a real model was shown.
 */
export const planFreshnessPrompt = (
  options: Pick<
    PlanFreshnessOptions,
    "sessionId" | "spec" | "issues" | "trigger"
  >,
): string =>
  [
    `${PLAN_PROMPT_PREFIX} session ${options.sessionId}`,
    "",
    ...(options.trigger === undefined
      ? []
      : [
          PLAN_MERGE_HEADING,
          `- ${JSON.stringify({
            pr: options.trigger.pr,
            number: options.trigger.number,
            ...(options.trigger.title === undefined
              ? {}
              : { title: oneLine(options.trigger.title) }),
          })}`,
          "This pull request just merged work against the spec below. What it delivered is done: do not propose adding it again.",
          "",
        ]),
    DECOMPOSITION_GOAL_HEADING,
    oneLine(options.spec.goal),
    "",
    DECOMPOSITION_ACCEPTANCE_HEADING,
    ...options.spec.acceptance.map((line) => `- ${oneLine(line)}`),
    "",
    PLAN_ISSUES_HEADING,
    ...options.issues.map(
      (issue) =>
        `- ${JSON.stringify({
          issue: issue.identifier,
          title: issue.title,
          state: issue.state,
          closed: issue.closed,
          acceptance: issue.acceptance,
        })}`,
    ),
    "",
    "## your answer",
    "Reply with only a JSON object shaped",
    '{"proposals": [{"kind": "add", "title": "...", "goal": "...", "change": "...", "acceptance": ["..."]},',
    ' {"kind": "rescope", "issue": "<identifier>", "title": "...", "goal": "...", "change": "...", "acceptance": ["..."]},',
    ' {"kind": "close", "issue": "<identifier>", "reason": "..."}]}.',
    "Name only issues listed above, each at most once. An empty list says the plan is still fresh.",
  ].join("\n");

/**
 * What the call can cost at most, in US dollars, before it is made: every byte of the system prompt
 * and the message (plus `PLAN_PROMPT_OVERHEAD_TOKENS`) at the dearest per-token input rate the
 * catalog names — input, cache read or cache write, over the base price and every tier — all of
 * `PLAN_MAX_OUTPUT_TOKENS` at the dearest output rate, and the access's flat per-call charge.
 * pi-ai bills a request at one tier's rates (`calculateCost`), and the call asks for no prompt cache,
 * so no billed split of the same tokens can cost more. `undefined` when the process serves no such
 * model, which the call itself then refuses.
 */
export const planPassWorstCost = (
  model: ModelAccess,
  instructions: string,
  prompt: string,
): number | undefined => {
  const served = model.models.getModel(model.provider, model.modelId);
  if (served === undefined) return undefined;
  const rates: readonly ModelCostRates[] = [
    served.cost,
    ...(served.cost.tiers ?? []),
  ];
  const inputRate = Math.max(
    ...rates.map((one) => Math.max(one.input, one.cacheRead, one.cacheWrite)),
  );
  const outputRate = Math.max(...rates.map((one) => one.output));
  const inputTokens =
    Buffer.byteLength(instructions, "utf8") +
    Buffer.byteLength(prompt, "utf8") +
    PLAN_PROMPT_OVERHEAD_TOKENS;
  return (
    (inputTokens * inputRate) / 1_000_000 +
    (PLAN_MAX_OUTPUT_TOKENS * outputRate) / 1_000_000 +
    (model.flatCost ?? 0)
  );
};

/** One call's answer, and what that call cost. */
export type PlanFreshnessRequest = {
  readonly answer: AssistantMessage;
  /** The call's spend, already charged through the guard's `charge` by the time it is answered. */
  readonly usage: Usage;
};

/**
 * How a caller keeps a billed call from going uncharged. `charge` records one settled call's spend;
 * `restore` is the caller's `Effect.uninterruptibleMask` restore, so only the wait on the provider is
 * interruptible and everything after it — the charge, and whatever the caller does with the answer —
 * runs in the caller's uninterruptible region, with no gap between the two for an interrupt to land in.
 */
export type PlanCallGuard = {
  readonly charge: (usage: Usage) => Effect.Effect<void, SessionError>;
  readonly restore: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
};

/**
 * The one model call, capped at `PLAN_MAX_OUTPUT_TOKENS`, asking for no prompt cache. An error
 * answer is not a failure here, as in `requestDecomposition`: the call happened and was billed, and
 * it is charged before `planFreshnessProposals` refuses it.
 *
 * Called inside the caller's `Effect.uninterruptibleMask`, with its `restore` in `guard`: the wait on
 * the provider is the only interruptible stretch. The spend is charged as soon as the call settles;
 * an interrupt during the wait aborts the request (the signal is the provider's), waits for the answer
 * it settles with, and charges that answer's usage before the interrupt proceeds — a call that was
 * already billed is never dropped on the floor. Without a guard the call is charged nowhere and is
 * interruptible throughout, which is what a test of the call alone wants.
 */
export const requestPlanFreshness = (
  options: PlanFreshnessOptions,
  guard: PlanCallGuard = {
    charge: () => Effect.void,
    restore: (effect) => effect,
  },
): Effect.Effect<PlanFreshnessRequest, SessionError> =>
  Effect.gen(function* () {
    const request = options.model.models.getModel(
      options.model.provider,
      options.model.modelId,
    );
    if (request === undefined) {
      return yield* new SessionError({
        code: "harness",
        message: `this process serves no model ${options.model.provider}/${options.model.modelId}, so no plan can be read`,
      });
    }
    const message: Message = {
      role: "user",
      content: planFreshnessPrompt(options),
      timestamp: yield* Clock.currentTimeMillis,
    };
    const failed = (cause: unknown) =>
      new SessionError({
        code: "harness",
        message: `the plan-freshness model call failed: ${String(cause)}`,
      });
    // The call in flight, kept so an interrupt can wait for the answer it settles with: the
    // `tryPromise` signal aborts the request on an interrupt, and does not wait for it.
    const inFlight: { call?: Promise<AssistantMessage> } = {};
    const answer = yield* guard
      .restore(
        Effect.tryPromise({
          try: (signal) => {
            const call = options.model.models.completeSimple(
              request,
              { systemPrompt: options.instructions, messages: [message] },
              {
                maxTokens: PLAN_MAX_OUTPUT_TOKENS,
                cacheRetention: "none",
                signal,
              },
            );
            inFlight.call = call;
            return call;
          },
          catch: failed,
        }),
      )
      .pipe(
        Effect.onInterrupt(() => {
          const call = inFlight.call;
          if (call === undefined) return Effect.void;
          return Effect.tryPromise({ try: () => call, catch: failed }).pipe(
            Effect.flatMap((aborted) => guard.charge(aborted.usage)),
            Effect.catch((error) =>
              Effect.logError(
                `plan freshness: an interrupted call's spend could not be charged: ${error.message}`,
              ),
            ),
          );
        }),
      );
    yield* guard.charge(answer.usage);
    return { answer, usage: answer.usage };
  });

const parseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown),
);

/** The JSON object an answer carries, or its raw text for the validator to refuse as unreadable. */
const answerValue = (message: AssistantMessage): unknown => {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return text;
  return Option.getOrElse(parseJson(text.slice(start, end + 1)), () => text);
};

/** The proposals in a pass's answer, through the one validator, against the issues it was shown. */
export const planFreshnessProposals = (
  request: PlanFreshnessRequest,
  issues: readonly PlanIssue[],
): Effect.Effect<
  readonly PlanProposal[],
  SessionError | PlanProposalsRefused
> => {
  if (request.answer.stopReason === "error") {
    return Effect.fail(
      new SessionError({
        code: "harness",
        message: `the plan-freshness model call failed: ${request.answer.errorMessage ?? "no message"}`,
      }),
    );
  }
  const result = validatePlanProposals(answerValue(request.answer), issues);
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(planProposalsRefused(result.failure));
};

/** A revision as the document stores it: plain JSON. */
const toJson = (revision: PlanRevision): JsonValue =>
  JSON.parse(JSON.stringify(revision)) as JsonValue;

const revisionsIn = (doc: {
  readonly revisions: readonly JsonValue[];
}): readonly PlanRevision[] =>
  projectPlanRevisions({ revisions: doc.revisions }) ?? [];

/**
 * Add `revision` to the conversation's `factory.planRevisions` inside `tx`, unless a revision with
 * its key is already there — the merge was answered, and that answer stands. Answers the stored
 * revision and whether this commit made it. The oldest revisions past `MAX_PLAN_REVISIONS` age out.
 */
export const commitPlanRevision = (
  tx: Tx,
  conversationId: ConversationId,
  revision: PlanRevision,
): Promise<{ readonly revision: PlanRevision; readonly created: boolean }> =>
  tx.doc(PlanRevisionsDoc, conversationId).then((doc) => {
    const stored = revisionsIn(doc);
    const existing = stored.find((one) => one.key === revision.key);
    if (existing !== undefined) return { revision: existing, created: false };
    doc.revisions = [...stored, revision]
      .slice(-MAX_PLAN_REVISIONS)
      .map(toJson);
    return { revision, created: true };
  });

/** Commit one revision to the session's log; see `commitPlanRevision`. */
export const writePlanRevision = (
  conversation: Conversation,
  revision: PlanRevision,
): Effect.Effect<
  { readonly revision: PlanRevision; readonly created: boolean },
  SessionError
> =>
  attempt("write plan revision", () =>
    conversation.commit(
      (tx) => commitPlanRevision(tx, conversation.id, revision),
      BACKGROUND_CONTEXT,
    ),
  );

/**
 * Rewrite the revision filed under `key` inside `tx` with `update`, and answer what it became, or
 * `undefined` — writing nothing — when no revision has that key or `update` declines (`undefined`).
 */
const updateRevision = (
  tx: Tx,
  conversationId: ConversationId,
  key: string,
  update: (revision: PlanRevision) => PlanRevision | undefined,
): Promise<PlanRevision | undefined> =>
  tx.doc(PlanRevisionsDoc, conversationId).then((doc) => {
    const stored = revisionsIn(doc);
    const index = stored.findIndex((one) => one.key === key);
    const current = stored[index];
    if (current === undefined) return undefined;
    const next = update(current);
    if (next === undefined) return undefined;
    doc.revisions = stored
      .map((one, at) => (at === index ? next : one))
      .map(toJson);
    return next;
  });

/** Mark the revision under `key` declined; `undefined` when the session has no such revision. */
export const recordPlanDeclined = (
  conversation: Conversation,
  key: string,
): Effect.Effect<PlanRevision | undefined, SessionError> =>
  attempt("decline plan revision", () =>
    conversation.commit(
      (tx) =>
        updateRevision(tx, conversation.id, key, (revision) => ({
          ...revision,
          decision: "declined",
        })),
      BACKGROUND_CONTEXT,
    ),
  );

/** What a proposal is about, as a stable name: the issue it changes, or the title it adds. */
export const proposalSubject = (proposal: PlanProposal): string =>
  proposal.kind === "add"
    ? `add:${titleKey(proposal.title)}`
    : `${proposal.kind}:${proposal.issue.toUpperCase()}`;

/**
 * Record that proposal `index` of the revision under `key` — about `subject` when the approval read
 * it — was applied as `applied`. `false`, writing nothing, unless that slot still holds a proposal
 * about the same subject: the check and the write share one transaction, as `commitCreatedIssue`'s do.
 */
export const recordPlanApplied = (
  conversation: Conversation,
  key: string,
  index: number,
  subject: string,
  applied: CreatedIssue,
): Effect.Effect<boolean, SessionError> =>
  attempt("record applied plan proposal", () =>
    conversation.commit(
      (tx) =>
        updateRevision(tx, conversation.id, key, (revision) => {
          const proposal = revision.proposals[index];
          if (proposal === undefined || proposalSubject(proposal) !== subject) {
            return undefined;
          }
          return {
            ...revision,
            proposals: revision.proposals.map((one, at) =>
              at === index
                ? {
                    ...one,
                    applied: { id: applied.id, identifier: applied.identifier },
                  }
                : one,
            ),
          };
        }).then((next) => next !== undefined),
      BACKGROUND_CONTEXT,
    ),
  );
