/**
 * The Sentry receiver (LOB-81, part 1 of LOB-33): a signed Sentry integration-platform webhook in,
 * at most one session per alerted event out.
 *
 * Part 1 of LOB-34 (`@repo/domain/Trigger` + `./TriggerService`) owns everything after
 * normalization — the durable dedupe claim in `webhook_deliveries`, the action filter, the label →
 * `{repo, baseRef, prompt}` mapping, the recorded skip reason and the session. This file is the three
 * things only Sentry knows: how its delivery is signed, how its payload reads as a `TriggerEvent`,
 * and which deliveries are the same piece of work. The route (`apps/api`'s `/webhooks/sentry`) adds
 * the body cap and the rate cap, which are the route's, not Sentry's.
 *
 * **The signature is Sentry's documented one.** `Sentry-Hook-Signature` is the hex HMAC-SHA256 of
 * the request body under the integration's Client Secret. The check is over the raw body as it
 * arrived; Sentry's own sample re-serializes a parsed body, which agrees with the raw bytes for the
 * JSON Sentry sends and never accepts a body nobody signed (`docs/testing-third-parties.md` names
 * what that reading cannot prove). The verdict is typed, so a route can log *why* it refused —
 * `missing-signature` and `bad-signature` are different fixes — without logging the body.
 *
 * **An issue alert is the delegation, and only it starts work by default.** Sentry sends several
 * resources (`Sentry-Hook-Resource`): `event_alert` is the one an operator configured as "this
 * deserves attention" — an alert rule fired for an event — and its `triggered` action normalizes to
 * `create`. Every other delivery (`issue`, `metric_alert`, `error`, `comment`, `installation`, …)
 * keeps `<resource>:<action>` as its action, so the seam's filter records it skipped with a reason
 * that names what arrived — `issue:created` is every new issue in every project, a firehose rather
 * than an alert — and an operator who does want one opts its rule in with `startsWorkFor`.
 *
 * **One piece of work is one session, so the key names the work, not the delivery.** Two alert
 * rules that fire for the same event are two deliveries with two `Request-ID`s and one piece of
 * work, and Sentry's docs do not say whether a re-sent delivery keeps its `Request-ID`. So an issue
 * alert is keyed by `data.event.event_id` (`sentry:event:<id>`) and marked `keyedByWork`: a skip
 * under it for an unregistered repo is reclaimed by the next alert once the operator registers the
 * repo. An action a rule opts in (`startsWorkFor`, e.g. `issue:created`) is work too, so it is keyed
 * the same way, by what it is about and what happened to it (`sentry:work:issue:<id>:issue:created`),
 * whatever `Request-ID` it arrived with; the rules are the seam's own (`sentryDelivery`'s `rules`),
 * so the key and the filter agree on which deliveries are work, as Linear's do (LOB-164). A delivery
 * that cannot start work is keyed by its `Request-ID`, one row per delivery, and one with no
 * `Request-ID` is refused — it is not something Sentry sends. Binding a *repeat* alert for the same
 * issue (a new event in one fingerprint) to the open session is LOB-82's, not this key's.
 *
 * **The labels are the mapping.** Sentry names no repository, so a rule says which repo an alert
 * means: every delivery carries `sentry`, and one that names its project also carries
 * `sentry:project:<id>`, so one rule can route a single project ahead of a `sentry` catch-all.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import {
  startsWork,
  TRIGGER_ACTION,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";

/** The headers a Sentry delivery carries, lowercase as an incoming header map has them. */
export const SENTRY_SIGNATURE_HEADER = "sentry-hook-signature";
export const SENTRY_RESOURCE_HEADER = "sentry-hook-resource";
export const SENTRY_REQUEST_ID_HEADER = "request-id";

/** The resource whose `triggered` delivery starts work: an issue alert rule fired. */
export const SENTRY_ALERT_RESOURCE = "event_alert";
const SENTRY_ALERT_ACTION = "triggered";

/** The label every Sentry delivery carries: what a catch-all rule matches. */
export const SENTRY_LABEL = "sentry";

/** The label naming a delivery's Sentry project, so one rule can route one project. */
export const sentryProjectLabel = (projectId: string): string =>
  `${SENTRY_LABEL}:project:${projectId}`;

/** Why a delivery's signature was not accepted. A route answers `401` for both and logs which. */
export const SentrySignatureRefusal = Schema.Literals([
  "missing-signature",
  "bad-signature",
]);
export type SentrySignatureRefusal = typeof SentrySignatureRefusal.Type;

export type SentrySignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: SentrySignatureRefusal };

/**
 * The signature Sentry would have sent for this body: hex HMAC-SHA256 under the Client Secret.
 *
 * Exported because the drive and the tests have to sign what they deliver, and a test that spelled
 * the scheme a second time could agree with a wrong implementation.
 */
export const sentrySignature = (raw: string, clientSecret: string): string =>
  createHmac("sha256", clientSecret).update(raw, "utf8").digest("hex");

/**
 * Whether a delivery is signed by the holder of `clientSecret`. An empty secret verifies nothing:
 * a deployment that configured none must not accept a body signed with the empty key.
 */
export const verifySentrySignature = (input: {
  readonly raw: string;
  readonly signature: string | undefined;
  readonly clientSecret: string;
}): SentrySignatureVerdict => {
  const signature = input.signature?.trim() ?? "";
  if (signature === "") return { ok: false, refusal: "missing-signature" };
  if (input.clientSecret === "") return { ok: false, refusal: "bad-signature" };
  const expected = Buffer.from(
    sentrySignature(input.raw, input.clientSecret),
    "utf8",
  );
  const given = Buffer.from(signature.toLowerCase(), "utf8");
  // `timingSafeEqual` throws on different lengths, and a length difference is itself a mismatch.
  if (expected.length !== given.length) {
    return { ok: false, refusal: "bad-signature" };
  }
  return timingSafeEqual(expected, given)
    ? { ok: true }
    : { ok: false, refusal: "bad-signature" };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** A field Sentry sends as a string in one resource and a number in another (`project`, `id`). */
const idField = (
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringField(record, name);
};

/** A project as `data.event` (`project: 1`) or `data.issue` (`project: {id, slug}`) names it. */
const projectId = (
  subject: Record<string, unknown> | undefined,
): string | undefined =>
  idField(subject, "project") ?? idField(asRecord(subject?.["project"]), "id");

/** The labels a delivery carries: `sentry`, and its project when it names one. */
const labelsOf = (
  subject: Record<string, unknown> | undefined,
): ReadonlyArray<string> => {
  const project = projectId(subject);
  return project === undefined
    ? [SENTRY_LABEL]
    : [SENTRY_LABEL, sentryProjectLabel(project)];
};

/**
 * The alert's facts as the prompt's `{{body}}`: one `name: value` line per fact the payload has,
 * in a fixed order, so a rule's prompt carries the alert's own words without a rule per field.
 */
const alertBody = (
  event: Record<string, unknown>,
  triggeredRule: string | undefined,
): string =>
  [
    ["alert rule", triggeredRule],
    ["level", stringField(event, "level")],
    ["culprit", stringField(event, "culprit")],
    ["release", stringField(event, "release")],
    ["environment", stringField(event, "environment")],
    ["issue", idField(event, "issue_id")],
    ["event", stringField(event, "event_id")],
    ["link", stringField(event, "web_url") ?? stringField(event, "url")],
  ]
    .filter((line): line is [string, string] => line[1] !== undefined)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

/**
 * A Sentry delivery, normalized. `resource` is the `Sentry-Hook-Resource` header; with none, the
 * payload's own `data` says which (`data.event` is an alert, `data.issue` an issue), because the
 * header is the one part of a delivery a relay is likely to drop.
 *
 * `undefined` is "this names nothing the receiver can address": not an object, no resource, or an
 * issue alert with no `data.event.event_id` — the one field its key cannot do without. The caller
 * answers that as a bad request. Any other resource is an event the seam will refuse by name.
 */
export const sentryEvent = (
  payload: unknown,
  headers: { readonly resource?: string | undefined } = {},
): TriggerEvent | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  const data = asRecord(body["data"]);
  const declared = headers.resource?.trim() ?? "";
  const resource =
    declared !== ""
      ? declared
      : data?.["event"] !== undefined
        ? SENTRY_ALERT_RESOURCE
        : data?.["issue"] !== undefined
          ? "issue"
          : undefined;
  if (resource === undefined) return undefined;
  const action = stringField(body, "action") ?? "unknown";

  if (resource === SENTRY_ALERT_RESOURCE) {
    const event = asRecord(data?.["event"]);
    const eventId = stringField(event, "event_id");
    if (event === undefined || eventId === undefined) return undefined;
    return {
      source: "sentry",
      key: eventId,
      action:
        action === SENTRY_ALERT_ACTION
          ? TRIGGER_ACTION
          : `${resource}:${action}`,
      title: stringField(event, "title") ?? "",
      body: alertBody(event, stringField(data, "triggered_rule")),
      labels: labelsOf(event),
    };
  }

  // Another resource: its own key space, and an action the filter cannot mistake for an alert's.
  // The delivery, not this key, is what tells two of them apart (`sentryDelivery`).
  const subject = asRecord(data?.[resource]);
  return {
    source: "sentry",
    key: `${resource}:${idField(subject, "id") ?? NO_ID}`,
    action: `${resource}:${action}`,
    title: stringField(subject, "title") ?? "",
    body: stringField(subject, "culprit") ?? "",
    labels: labelsOf(subject),
  };
};

/** What a resource's key says when its payload names no id: nothing a work key can be made of. */
const NO_ID = "no-id";

/** The key of the one delivery an alerted event starts work under. */
export const sentryEventRequestId = (eventId: string): string =>
  `sentry:event:${eventId}`;

/** What a Sentry delivery's headers carry, beside its body. */
export type SentryDeliveryHeaders = {
  /** `Sentry-Hook-Resource`: which resource the payload is about. */
  readonly resource?: string | undefined;
  /** `Request-ID`: Sentry's identifier for this one request. */
  readonly requestId?: string | undefined;
};

/** Why a payload is not a delivery: the `400` a route answers, and its code. */
export type SentryRefusal = {
  readonly refused: string;
  readonly code: "bad-payload" | "missing-request-id";
};

/** The key of the one delivery an opted-in action on one Sentry subject starts work under. */
export const sentryWorkRequestId = (event: TriggerEvent): string =>
  `sentry:work:${event.key}:${event.action}`;

/**
 * Whether the event can start work: the seam's own question (`startsWork` over the rule the
 * mapping would route to, the first that claims one of its labels), asked the same way here, so the
 * key, the route's rate cap and the seam's filter cannot disagree about which deliveries are work.
 */
export const sentryStartsWork = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule> = [],
): boolean => {
  const routing = rules.find((rule) => event.labels.includes(rule.label));
  return startsWork(
    event.action,
    routing?.startsWorkFor === undefined ? [] : [routing.startsWorkFor],
  );
};

/**
 * A payload as the seam takes it: the normalized event, named by its derived delivery id. An issue
 * alert is keyed by its event and an action `rules` opt in by its subject and action (both
 * `keyedByWork`); anything else by the `Request-ID` it arrived with. `rules` must be the ones the
 * seam maps with, or the key could call a delivery work the filter refuses, or the reverse.
 */
export const sentryDelivery = (
  payload: unknown,
  headers: SentryDeliveryHeaders = {},
  rules: ReadonlyArray<TriggerRule> = [],
): TriggerDelivery | SentryRefusal => {
  const event = sentryEvent(payload, { resource: headers.resource });
  if (event === undefined) {
    return {
      refused: "the payload does not name a Sentry resource and event",
      code: "bad-payload",
    };
  }
  if (event.action === TRIGGER_ACTION) {
    return {
      requestId: sentryEventRequestId(event.key),
      event,
      keyedByWork: true,
    };
  }
  // An opted-in action names its work only when its subject has an id: `issue:no-id` would make
  // every id-less delivery one piece of work, so that one falls back to its `Request-ID`.
  if (sentryStartsWork(event, rules) && !event.key.endsWith(`:${NO_ID}`)) {
    return {
      requestId: sentryWorkRequestId(event),
      event,
      keyedByWork: true,
    };
  }
  const requestId = headers.requestId?.trim() ?? "";
  if (requestId === "") {
    return {
      refused: `a Sentry ${event.action} delivery carries no Request-ID header`,
      code: "missing-request-id",
    };
  }
  return { requestId: `sentry:delivery:${requestId}`, event };
};
