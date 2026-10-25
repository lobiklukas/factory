/**
 * Inbound triggers (LOB-188, part 1 of LOB-34): one typed path from a delivery to a session.
 *
 * Every way work arrives from outside — Linear today, a generic webhook, Jira (LOB-189), and the
 * GitHub and Slack adapters that are the rest of LOB-34 — goes through the same five steps:
 * authenticate, dedupe, filter, map, create. This file is the two shapes those steps agree on:
 *
 * - `TriggerEvent` is what an adapter normalizes its payload into. The adapter owns the wire
 *   format (a Linear HMAC and its `data.issue`, a generic JSON body) and nothing else; everything
 *   after the normalization is shared, so a new adapter is one extractor and one fake.
 * - `TriggerRule` is the mapping, `label -> {repo, baseRef, prompt}`. A rule is operator config,
 *   not a row, because which label means which repo is a deployment's opinion and not a fact the
 *   log should carry.
 *
 * A rule's `repo` is the fallback, not the answer: a source that knows its own repository —
 * GitHub's `repository.full_name` (LOB-190), where the same label means a different repo per
 * installation — puts it on the event, and the event's repo wins. A deployment-level default would
 * silently run the wrong repo's work on the right issue's words.
 *
 * `resolveMapping` and `renderPrompt` are pure, so the mapping half is testable with no database
 * and the service half (dedupe, create) is the only part that needs one.
 */
import { Schema } from "effect";
import { RepoSlug, SessionId } from "@repo/domain/Session";

/**
 * Where a delivery came from. `generic` is the plain inbound webhook: the caller names the label
 * its payload carries and the seam does the rest. `jira` is the Jira Cloud issue webhook (LOB-189),
 * `github` GitHub's issues webhook (LOB-190), `slack` a Slack Events API message (LOB-191).
 */
export const TriggerSource = Schema.Literals([
  "linear",
  "generic",
  "jira",
  "github",
  "slack",
]);
export type TriggerSource = typeof TriggerSource.Type;

/**
 * One inbound delivery, normalized by its adapter.
 *
 * `key` is the source's own identifier — a Linear issue id, a webhook caller's ticket key — and it
 * is what a write-back would address. `action` is what the payload says happened; only `create`
 * starts a session, so an edited Linear issue is filtered rather than opening a second one.
 */
export const TriggerEvent = Schema.Struct({
  source: TriggerSource,
  key: Schema.String,
  action: Schema.String,
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Schema.String),
  /**
   * The repository the payload names, when the source names one. Absent means "the rule decides".
   */
  repo: Schema.optional(RepoSlug),
});
export type TriggerEvent = typeof TriggerEvent.Type;

/**
 * One mapping rule: an event carrying `label` works on `repo`, at `baseRef`, with `prompt`.
 *
 * `prompt` is a template; `renderPrompt` substitutes `{{key}}`, `{{source}}`, `{{title}}`,
 * `{{body}}` and `{{labels}}`, so one rule can carry the payload's own words into the session's
 * first message without a rule per issue.
 */
export const TriggerRule = Schema.Struct({
  label: Schema.String,
  repo: RepoSlug,
  baseRef: Schema.optional(Schema.String),
  prompt: Schema.String,
  /**
   * Actions beyond `create` that start work *when this rule claims the event* (LOB-197).
   *
   * The seam's filter refuses an action no rule asked for, so widening it is a decision an operator
   * makes per rule rather than one every adapter inherits: a docs rule admits `push` and `schedule`
   * because a repository's own lifecycle is what starts a docs run, and a rule for a tracker admits
   * nothing extra. Without this the generic webhook — whose `action` is whatever its caller typed —
   * could name a `push` no push produced.
   */
  startsWorkFor: Schema.optional(Schema.Array(Schema.String)),
});
export type TriggerRule = typeof TriggerRule.Type;

export const TriggerRules = Schema.Array(TriggerRule);
export type TriggerRules = typeof TriggerRules.Type;

/** What a mapped event runs: the repo, the ref, and the rendered prompt. */
export const TriggerMapping = Schema.Struct({
  repo: RepoSlug,
  baseRef: Schema.optional(Schema.String),
  prompt: Schema.String,
  /** The rule's label, so a recorded outcome says which rule chose this repo. */
  label: Schema.String,
});
export type TriggerMapping = typeof TriggerMapping.Type;

/** One delivery as the seam records it: its idempotency key and the event. */
export const TriggerDelivery = Schema.Struct({
  /** The source's idempotency key: the dedupe fact, and the session's own request id. */
  requestId: Schema.String,
  event: TriggerEvent,
});
export type TriggerDelivery = typeof TriggerDelivery.Type;

/**
 * Why a delivery started nothing. `filtered` is the seam's own policy (an action that is not a
 * create), `unmappable` is "no rule matches these labels", and `unregistered-repo` is a rule that
 * names a repo nobody registered — the one refusal an operator fixes by registering a repo.
 */
export const TriggerRefusal = Schema.Literals([
  "filtered",
  "unmappable",
  "unregistered-repo",
]);
export type TriggerRefusal = typeof TriggerRefusal.Type;

/**
 * What one delivery did. A replay answers with what the first delivery recorded — `replayed` is
 * the difference between "this delivery started the session" and "this delivery is the same
 * delivery again", which a caller cannot tell from `status` alone.
 */
export const TriggerOutcome = Schema.Struct({
  /**
   * `received` is a replay of a delivery that is still being worked on: the first call claimed the
   * row and has not recorded an outcome yet, so the honest answer is neither processed nor skipped.
   */
  status: Schema.Literals(["processed", "skipped", "received"]),
  replayed: Schema.Boolean,
  sessionId: Schema.optional(SessionId),
  /** The refusal when `skipped`, and the rule that chose the repo when `processed`. */
  reason: Schema.optional(Schema.String),
});
export type TriggerOutcome = typeof TriggerOutcome.Type;

export const TriggerErrorCode = Schema.Literals([
  "storage",
  "session-create",
  "write-back",
]);
export type TriggerErrorCode = typeof TriggerErrorCode.Type;

/**
 * A delivery that failed rather than being refused: the database did not answer, or the session
 * could not be opened. Distinct from `TriggerOutcome.status === "skipped"`, which is a decision,
 * not a failure — a caller should retry this and not that.
 */
export class TriggerError extends Schema.TaggedError<TriggerError>()(
  "TriggerError",
  {
    code: TriggerErrorCode,
    message: Schema.String,
  },
) {}

/** The values `renderPrompt` substitutes. Exported so a test can name them. */
export const promptVariables = (
  event: TriggerEvent,
): Readonly<Record<string, string>> => ({
  source: event.source,
  key: event.key,
  action: event.action,
  title: event.title,
  body: event.body,
  labels: event.labels.join(", "),
});

/**
 * Fill a rule's template with the event's own words. An unknown `{{name}}` is left as written
 * rather than replaced with nothing: a prompt that silently loses text is worse than one that
 * shows the operator the placeholder they spelled wrong.
 */
export const renderPrompt = (template: string, event: TriggerEvent): string => {
  const variables = promptVariables(event);
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = variables[name];
    return value === undefined ? whole : value;
  });
};

/**
 * The first rule whose label the event carries, as the mapping it implies. `undefined` is
 * `unmappable`: the seam has no opinion about this event, so it starts nothing and says so.
 *
 * The event's own repo wins over the rule's when it names one: a rule says *which label starts
 * work*, and for GitHub the answer to *which repo* is in the payload.
 */
export const resolveMapping = (
  rules: ReadonlyArray<TriggerRule>,
  event: TriggerEvent,
): TriggerMapping | undefined => {
  const rule = rules.find((candidate) =>
    event.labels.includes(candidate.label),
  );
  if (rule === undefined) return undefined;
  return {
    repo: event.repo ?? rule.repo,
    prompt: renderPrompt(rule.prompt, event),
    label: rule.label,
    ...(rule.baseRef === undefined ? {} : { baseRef: rule.baseRef }),
  };
};

/**
 * The action the adapters that report an *issue* or *message* arriving normalize to. A Linear
 * `update` delivery, or a `remove`, is a real event about an issue that already has its session;
 * opening a second one is the bug this guards.
 */
export const TRIGGER_ACTION = "create";

/**
 * The action every adapter starts work with, and the two a repository's own lifecycle adds — a push
 * on the default branch and a schedule tick (LOB-197). Both are work that starts without a person,
 * so they go through the seam's dedupe and refusals like any other delivery; an adapter names its own
 * action rather than pretending a push is a create, and the recorded reason says which action
 * arrived.
 *
 * `create` is unconditional; `push` and `schedule` are not. A rule has to ask for one
 * (`TriggerRule.startsWorkFor`), so an adapter whose `action` comes from its caller — the generic
 * webhook — cannot name a push no push produced.
 */
export const LIFECYCLE_ACTIONS: ReadonlyArray<string> = ["push", "schedule"];

/** Every action the seam can be configured to start work with. */
export const TRIGGER_ACTIONS: ReadonlyArray<string> = [
  TRIGGER_ACTION,
  ...LIFECYCLE_ACTIONS,
];

/**
 * Whether this event starts work: `create` always, and a lifecycle action only when a rule that
 * claims the event asked for it. The seam's filter is this function over its own rule set.
 */
export const startsWork = (
  action: string,
  claimed: ReadonlyArray<ReadonlyArray<string>> = [],
): boolean =>
  action === TRIGGER_ACTION || claimed.some((asked) => asked.includes(action));
