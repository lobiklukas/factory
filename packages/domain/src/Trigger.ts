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
 * - `TriggerRule` is the mapping, `label -> {repo, baseRef, prompt}`. A rule comes from two places
 *   (LOB-266): `TRIGGER_RULES`, the deployment's fallback, and a stored route (`TriggerRoute`), a row
 *   on the repo registry an operator changes without a restart. The seam reads the stored ones per
 *   delivery and the env ones as the fallback, and the recorded reason names which rule matched.
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
import { RepoSlug, SessionId, Timestamp } from "@repo/domain/Session";

/**
 * Where a delivery came from. `generic` is the plain inbound webhook: the caller names the label
 * its payload carries and the seam does the rest. `jira` is the Jira Cloud issue webhook (LOB-189),
 * `github` GitHub's issues webhook (LOB-190), `slack` a Slack Events API message (LOB-191), `sentry`
 * a Sentry integration-platform webhook (LOB-81).
 */
export const TriggerSource = Schema.Literals([
  "linear",
  "generic",
  "jira",
  "github",
  "slack",
  "sentry",
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
  /**
   * The team the payload belongs to, when the source has teams: a Linear issue's team key. A rule
   * that names a `team` claims only events from it (LOB-266).
   */
  team: Schema.optional(Schema.String),
});
export type TriggerEvent = typeof TriggerEvent.Type;

/**
 * One mapping rule: an event carrying `label` and/or belonging to `team` works on `repo`, at
 * `baseRef`, with `prompt`.
 *
 * A rule names a label, a team, or both (LOB-266): a label alone claims any event carrying it, a team
 * alone claims every event from that team, and both claim only that label's events from that team —
 * the same label can mean a different repo per team. A rule naming neither would claim nothing and is
 * refused when it is decoded, so a typo cannot become a rule that quietly matches nothing.
 *
 * `prompt` is a template; `renderPrompt` substitutes `{{key}}`, `{{source}}`, `{{title}}`,
 * `{{body}}` and `{{labels}}`, so one rule can carry the payload's own words into the session's
 * first message without a rule per issue.
 */
const triggerRuleFields = {
  label: Schema.optional(Schema.NonEmptyString),
  /** A source's team key (`TriggerEvent.team`); absent means "any team". */
  team: Schema.optional(Schema.NonEmptyString),
  repo: RepoSlug,
  baseRef: Schema.optional(Schema.String),
  prompt: Schema.String,
  /**
   * Actions beyond `create` that start work *when this rule claims the event* (LOB-197).
   *
   * The seam's filter refuses an action no rule asked for, so widening it is a decision an operator
   * makes per rule rather than one every adapter inherits: a docs rule admits `push` and `schedule`
   * because a repository's own lifecycle is what starts a docs run, and a rule for a tracker admits
   * nothing extra. The rule the filter consults is the one the mapping picks, so a rule that only
   * *also* claims a label cannot admit an action that lands on another rule's repo.
   *
   * This field does not authenticate the action; the adapter does. The generic webhook's `action`
   * is whatever its caller typed, so that adapter refuses a lifecycle action outright (`400
   * lifecycle-action`, LOB-235) before the seam sees it: a signed caller that names a `docs` label
   * and says `push` is told why, nothing is recorded, and no `reason` names a push no push produced.
   * It refuses every other action listed here too (any rule's, not only `push` and `schedule`),
   * because a string an operator adds is no more observed when the generic caller types it. Only
   * the adapters that observe a push or a tick — the GitHub push route and the schedule daemon
   * (`@repo/core/DocsTrigger`) — deliver one.
   */
  startsWorkFor: Schema.optional(Schema.Array(Schema.String)),
};

/** A rule claims something: it names a label, a team, or both. */
const namesALabelOrATeam = Schema.makeFilter(
  (rule: {
    readonly label?: string | undefined;
    readonly team?: string | undefined;
  }) =>
    rule.label === undefined && rule.team === undefined
      ? "a rule names a label, a team, or both"
      : undefined,
);

export const TriggerRule =
  Schema.Struct(triggerRuleFields).check(namesALabelOrATeam);
export type TriggerRule = typeof TriggerRule.Type;

export const TriggerRules = Schema.Array(TriggerRule);
export type TriggerRules = typeof TriggerRules.Type;

/** What a mapped event runs: the repo, the ref, and the rendered prompt. */
export const TriggerMapping = Schema.Struct({
  repo: RepoSlug,
  baseRef: Schema.optional(Schema.String),
  prompt: Schema.String,
  /** The rule's name (`ruleName`), so a recorded outcome says which rule chose this repo. */
  label: Schema.String,
});
export type TriggerMapping = typeof TriggerMapping.Type;

/** One delivery as the seam records it: its idempotency key and the event. */
export const TriggerDelivery = Schema.Struct({
  /** The source's idempotency key: the dedupe fact, and the session's own request id. */
  requestId: Schema.String,
  event: TriggerEvent,
  /**
   * Whether `requestId` names the unit of work (one issue) rather than one delivery of it.
   *
   * A sender's own delivery id is answered once: a retry of it after the operator registers the
   * repo is a replay, and a new delivery is the second chance. An adapter that keys every delivery
   * about an issue by the issue (LOB-164) has no new delivery to offer, so for it the one refusal
   * an operator fixes — `unregistered-repo` — stays reclaimable: the next delivery under the same
   * key is claimed again instead of replaying the old skip.
   */
  keyedByWork: Schema.optional(Schema.Boolean),
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

/** Whether `rule` claims `event`: every field the rule names has to match, and a field it omits is open. */
export const ruleClaims = (rule: TriggerRule, event: TriggerEvent): boolean =>
  (rule.label === undefined || event.labels.includes(rule.label)) &&
  (rule.team === undefined || rule.team === event.team);

/** The first rule that claims the event, in the order given: a specific rule goes before a catch-all. */
export const findRule = (
  rules: ReadonlyArray<TriggerRule>,
  event: TriggerEvent,
): TriggerRule | undefined => rules.find((rule) => ruleClaims(rule, event));

/**
 * What a recorded reason calls a rule: its label, `team ENG` for a team rule, `label in team ENG`
 * for both. A label-only rule reads as it always has (`rule "docs"`).
 */
export const ruleName = (rule: TriggerRule): string =>
  rule.team === undefined
    ? (rule.label ?? "")
    : rule.label === undefined
      ? `team ${rule.team}`
      : `${rule.label} in team ${rule.team}`;

/**
 * The mapping the first claiming rule implies. `undefined` is `unmappable`: the seam has no opinion
 * about this event, so it starts nothing and says so.
 *
 * The event's own repo wins over the rule's when it names one: a rule says *which events start
 * work*, and for GitHub the answer to *which repo* is in the payload.
 */
export const resolveMapping = (
  rules: ReadonlyArray<TriggerRule>,
  event: TriggerEvent,
): TriggerMapping | undefined => {
  const rule = findRule(rules, event);
  if (rule === undefined) return undefined;
  return {
    repo: event.repo ?? rule.repo,
    prompt: renderPrompt(rule.prompt, event),
    label: ruleName(rule),
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
 * (`TriggerRule.startsWorkFor`), and an adapter whose `action` comes from its caller — the generic
 * webhook — refuses both, and any other action a rule lists, before the seam (LOB-235), so it
 * cannot name a push no push produced.
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

/**
 * A stored route's id: `trr_` and twenty-six Crockford base32 characters, the shape of a session's
 * and a card's (`mintTriggerRouteId`). It is what a recorded reason names (`route trr_…`), so it is
 * readable in a log and sortable by when the route was added.
 */
export const TriggerRouteId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^trr_[0-9abcdefghjkmnpqrstvwxyz]{26}$/)),
  Schema.brand("TriggerRouteId"),
);
export type TriggerRouteId = typeof TriggerRouteId.Type;

/**
 * A route as the repo registry stores it (LOB-266): one `TriggerRule` with an id and the instant it
 * was added. Read per delivery, so adding or removing one changes where the next delivery goes with
 * no env edit and no restart. The rule's `repo` is a registered repo (the row references it).
 *
 * Precedence is deterministic: a route naming a label *and* a team first, then a label alone, then
 * a team alone, and the older route first within each; the `TRIGGER_RULES` entries follow, in their
 * own order, as the fallback when no stored route claims the event.
 */
export const TriggerRoute = Schema.Struct({
  id: TriggerRouteId,
  ...triggerRuleFields,
  createdAt: Timestamp,
}).check(namesALabelOrATeam);
export type TriggerRoute = typeof TriggerRoute.Type;

/** What `addTriggerRoute` takes: a rule. The id and the time are the server's. */
export const AddTriggerRouteInput = TriggerRule;
export type AddTriggerRouteInput = typeof AddTriggerRouteInput.Type;

export const ListTriggerRoutesInput = Schema.Struct({});
export type ListTriggerRoutesInput = typeof ListTriggerRoutesInput.Type;

export const ListTriggerRoutesOutput = Schema.Struct({
  /** In the order the seam consults them (`TriggerRoute`'s precedence). */
  routes: Schema.Array(TriggerRoute),
});
export type ListTriggerRoutesOutput = typeof ListTriggerRoutesOutput.Type;

export const RemoveTriggerRouteInput = Schema.Struct({ id: TriggerRouteId });
export type RemoveTriggerRouteInput = typeof RemoveTriggerRouteInput.Type;

/** `removeTriggerRoute` was asked for an id with no row: a typed answer, so a repeat is not a failure. */
export class TriggerRouteNotFound extends Schema.TaggedError<TriggerRouteNotFound>()(
  "TriggerRouteNotFound",
  { id: Schema.String, message: Schema.String },
) {}

/**
 * A stored route the registry refused: the repo is not registered, or the database did not answer.
 * `invalid_input` is the caller's to fix; `storage` is retryable.
 */
export class TriggerRouteError extends Schema.TaggedError<TriggerRouteError>()(
  "TriggerRouteError",
  {
    code: Schema.Literals(["invalid_input", "storage"]),
    message: Schema.String,
  },
) {}
