/**
 * The Linear adapter (LOB-164, part 2 of LOB-14): a Linear issue webhook in, one bound session out.
 *
 * Part 1 (`@repo/domain/Trigger` + `./TriggerService`) owns everything after normalization — the
 * dedupe claim, the action filter, the label → `{repo, baseRef, prompt}` mapping, the recorded skip
 * reason and the session. This file is the two things only Linear knows: how its payload reads as a
 * `TriggerEvent`, and which deliveries are the same piece of work.
 *
 * **The repo is the rule's.** Linear names no repository, so the label is the whole mapping: a rule
 * in `TRIGGER_RULES` says which repo, base ref and prompt a label means, and an issue carrying no
 * label any rule names is recorded `skipped` with the labels it did carry.
 *
 * **Two deliveries start work.** An issue `create` carrying the label, and an `update` that *adds*
 * a label (`updatedFrom.labelIds` lacks one the issue now carries) — the issue triaged into the
 * factory after it was filed. Both normalize to `create`; every other action keeps Linear's own
 * name, so the seam's filter refuses it and the reason reads `action "update" is not "create"`.
 * A delivery about another entity (`type: "Comment"`, `"Project"`, …) is answered too, not refused:
 * a `400` would make Linear retry it three times and eventually disable the webhook, so it is
 * normalized to `Comment:create` and recorded as a skip that names what arrived.
 *
 * **One issue is one session, so the idempotency key names the issue, not the delivery.** Linear's
 * `Linear-Delivery` header "uniquely identifies this payload", and its docs do not say a retry (1
 * minute, 1 hour, 6 hours) reuses it; the body's `webhookTimestamp` is "when the webhook was sent",
 * so a retry's body — and its signature — differ too. Keying the dedupe on either would let a retry
 * open a second session. So a delivery that would start work is keyed by its issue once a rule
 * claims it (`linear:<issue id>:mapped`): a retry, the `create` and a later label-adding `update`,
 * and a second mapped label all collapse into the one session. One the rules do not claim is keyed
 * by its label set, exactly as on GitHub (`GitHub.ts`), so an issue filed unlabelled records its
 * skip without swallowing the delivery that labels it later.
 *
 * A delivery that **cannot** start work — an edit, a state change, a removal — is keyed by the
 * delivery itself, never by the issue: an edit that arrived first must not claim the issue's key
 * and turn the label that arrives later into a replay of a skip. Its own retry may record a second
 * skip row; a skip starts nothing, so that costs a row and not a session.
 *
 * `webhookId` is not a delivery id. Linear's docs call it the "ID uniquely identifying this
 * webhook" — the subscription — so it is the same on every delivery that subscription sends, and
 * nothing here reads it.
 */
import {
  resolveMapping,
  startsWork,
  TRIGGER_ACTION,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";

/** The one Linear entity type that starts work. */
export const LINEAR_ISSUE_TYPE = "Issue";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Linear's `labels` are objects (`{id, name, color, parentId}`); a bare string is accepted too,
 * because that is what a hand-written payload carries.
 */
const labelNames = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry): ReadonlyArray<string> => {
        if (typeof entry === "string") return [entry];
        const name = stringField(asRecord(entry), "name");
        return name === undefined ? [] : [name];
      })
    : [];

/** The issue's current label ids: `labelIds`, and the ids its `labels` objects carry. */
const labelIds = (issue: Record<string, unknown>): ReadonlyArray<string> => {
  const fromObjects = Array.isArray(issue["labels"])
    ? issue["labels"].flatMap((entry): ReadonlyArray<string> => {
        const id = stringField(asRecord(entry), "id");
        return id === undefined ? [] : [id];
      })
    : [];
  return [...new Set([...strings(issue["labelIds"]), ...fromObjects])];
};

/**
 * The subject entity. Linear's `data` is the entity itself; a payload that wraps an issue as
 * `data.issue` or a top-level `issue` (what a self-hosted relay tends to emit) reads the same way,
 * because all three spell the same fields.
 */
const subject = (
  body: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const data = asRecord(body["data"]) ?? body;
  const nested = asRecord(data["issue"]);
  if (nested !== undefined) return nested;
  if (
    stringField(data, "id") === undefined &&
    stringField(data, "identifier") === undefined
  ) {
    return asRecord(body["issue"]);
  }
  return data;
};

/**
 * Whether an `update` added a label. `updatedFrom` carries only the properties that changed, so a
 * `labelIds` there is the issue's label set *before* this update; a label the issue carries now
 * that is not in it was added. A removal, or an update that did not touch labels, is not.
 */
const addedALabel = (
  body: Record<string, unknown>,
  issue: Record<string, unknown>,
): boolean => {
  const before = asRecord(body["updatedFrom"])?.["labelIds"];
  if (!Array.isArray(before)) return false;
  const previous = new Set(strings(before));
  return labelIds(issue).some((id) => !previous.has(id));
};

/**
 * A Linear webhook payload, normalized.
 *
 * `undefined` is "this names nothing this adapter can address": not an object, or no entity id.
 * The caller answers that as a bad request. Any entity that *has* an id is an event — an issue the
 * seam may map, or another entity the seam will refuse by name.
 */
export const linearEvent = (payload: unknown): TriggerEvent | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  const entity = subject(body);
  if (entity === undefined) return undefined;
  const id = stringField(entity, "id") ?? stringField(entity, "identifier");
  if (id === undefined) return undefined;

  // A payload with no `type` is a relay's hand-written issue; Linear itself always sends one.
  const type = stringField(body, "type") ?? LINEAR_ISSUE_TYPE;
  const action = stringField(body, "action") ?? TRIGGER_ACTION;
  const title = stringField(entity, "title") ?? "";
  const description = stringField(entity, "description") ?? "";

  if (type !== LINEAR_ISSUE_TYPE) {
    // Another entity: its own key space, and an action the filter cannot mistake for an issue's.
    return {
      source: "linear",
      key: `${type}:${id}`,
      action: `${type}:${action}`,
      title,
      body: description,
      labels: labelNames(entity["labels"]),
    };
  }

  const starts =
    action === TRIGGER_ACTION ||
    (action === "update" && addedALabel(body, entity));
  return {
    source: "linear",
    key: id,
    // Only the two starting deliveries are renamed; an edit stays `update` so the recorded reason
    // names what Linear sent.
    action: starts ? TRIGGER_ACTION : action,
    title,
    body: description,
    labels: labelNames(entity["labels"]),
  };
};

/** What the dedupe key of a delivery that starts nothing is made of, in the order it is tried. */
export type LinearDeliveryHeaders = {
  /** `Linear-Delivery`: the UUID Linear puts on every payload it sends. */
  readonly delivery?: string | undefined;
};

/**
 * The idempotency key for a normalized Linear event: **one issue is one unit of work**.
 *
 * Whether the event can start work is the seam's own question (`startsWork` over the rule the
 * mapping would route to), asked the same way here, so this and the filter cannot disagree about
 * which deliveries are work.
 */
export const linearRequestId = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule>,
  payload: unknown,
  headers: LinearDeliveryHeaders = {},
): string => {
  const routing = rules.find((rule) => event.labels.includes(rule.label));
  const asked =
    routing?.startsWorkFor === undefined ? [] : [routing.startsWorkFor];
  if (startsWork(event.action, asked)) {
    if (resolveMapping(rules, event) !== undefined) {
      return `linear:${event.key}:mapped`;
    }
    const labels = [...new Set(event.labels)].sort().join(",");
    return `linear:${event.key}:unmapped:${labels === "" ? "no-labels" : labels}`;
  }
  // Starts nothing: the delivery, not the issue. The header when Linear sent one; otherwise the
  // payload's own send time, which a hand-written relay body is the only sender to omit.
  const body = asRecord(payload);
  const sent = body?.["webhookTimestamp"];
  const delivery =
    headers.delivery ??
    (typeof sent === "number" || typeof sent === "string"
      ? String(sent)
      : (stringField(body, "createdAt") ?? "unknown"));
  return `linear:${event.key}:${event.action}:${delivery}`;
};

/** A payload as the seam takes it: the normalized event, named by its derived delivery id. */
export const linearDelivery = (
  payload: unknown,
  rules: ReadonlyArray<TriggerRule>,
  headers: LinearDeliveryHeaders = {},
): TriggerDelivery | undefined => {
  const event = linearEvent(payload);
  if (event === undefined) return undefined;
  return {
    requestId: linearRequestId(event, rules, payload, headers),
    event,
  };
};

/**
 * The adapter's delivery function, bound to one rule set — the same value the route hands
 * `TriggerServiceLive`, so a payload this keys as mapped is one the seam maps.
 */
export const linearDeliveryFor =
  (rules: ReadonlyArray<TriggerRule>) =>
  (
    payload: unknown,
    headers: LinearDeliveryHeaders = {},
  ): TriggerDelivery | undefined =>
    linearDelivery(payload, rules, headers);
