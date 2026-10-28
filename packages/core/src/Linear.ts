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
 * a label a rule names (`updatedFrom.labelIds` lacks it, the issue now carries it) — the issue
 * triaged into the factory after it was filed. Both normalize to `create`; every other action keeps
 * Linear's own name, so the seam's filter refuses it and the reason reads
 * `action "update" is not "create"`. A delivery about another entity (`type: "Comment"`,
 * `"IssueSLA"`, …) is answered too, not refused, even when its `data` names no id: a `400` would
 * make Linear retry it three times and eventually disable the webhook, so it is normalized to
 * `Comment:create` and recorded as a skip that names what arrived.
 *
 * **One issue is one session, so the idempotency key names the issue, not the delivery.** Linear's
 * `Linear-Delivery` header "uniquely identifies this payload", and its docs do not say a retry (1
 * minute, 1 hour, 6 hours) reuses it; the body's `webhookTimestamp` is "when the webhook was sent",
 * so a retry's body — and its signature — differ too. Keying the dedupe on either would let a retry
 * open a second session. So a delivery that would start work is keyed by its issue once a rule
 * claims it (`linear:<issue id>:mapped`): a retry, the `create` and a later label-adding `update`,
 * and a second mapped label all collapse into the one session. Because that key outlives any one
 * delivery, it is marked `keyedByWork`: a skip under it for an unregistered repo is reclaimed by the
 * next delivery once the operator registers the repo. One the rules do not claim is keyed
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
import { isWebLink } from "@repo/domain/Task";
import {
  externalRefOf,
  resolveMapping,
  ruleClaims,
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
 * The subject issue. Linear's `data` is the entity itself; a payload that wraps an issue as
 * `data.issue` or a top-level `issue` (what a self-hosted relay tends to emit) reads the same way,
 * because all three spell the same fields. Only an issue is unwrapped: a `Comment`'s `data.issue`
 * is the issue it was left on, not the comment, so another entity reads `data` itself (`linearEvent`).
 */
const issueSubject = (
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

/** An entity's own id: Linear's `id`, else a relay's `identifier` (`ENG-42`). */
const entityId = (entity: Record<string, unknown>): string | undefined =>
  stringField(entity, "id") ?? stringField(entity, "identifier");

/**
 * The team an issue belongs to, by its key (`ENG`): Linear's `data.team.key`, or a relay's bare
 * `team` string. A team rule (LOB-266) claims by this value; an issue naming none is in no team.
 */
const teamKey = (entity: Record<string, unknown>): string | undefined =>
  stringField(entity, "team") ?? stringField(asRecord(entity["team"]), "key");

/**
 * Whether an `update` added a label a rule claims. `updatedFrom` carries only the properties that
 * changed, so a `labelIds` there is the issue's label set *before* this update; a label the issue
 * carries now that is not in it was added. Only an added label whose name a rule names counts: an
 * issue that already carried a mapped label (filed before the webhook or the rule existed) is not
 * triaged into the factory by someone adding `P1` to it. A removal, an update that did not touch
 * labels, and an added id no `labels` object names are not work.
 */
const addedAClaimedLabel = (
  body: Record<string, unknown>,
  issue: Record<string, unknown>,
  rules: ReadonlyArray<TriggerRule>,
): boolean => {
  const before = asRecord(body["updatedFrom"])?.["labelIds"];
  if (!Array.isArray(before)) return false;
  const previous = new Set(strings(before));
  const claimed = new Set(rules.flatMap((rule) => rule.label ?? []));
  const added = new Set(labelIds(issue).filter((id) => !previous.has(id)));
  if (added.size === 0) return false;
  const labels = Array.isArray(issue["labels"]) ? issue["labels"] : [];
  return labels.some((entry) => {
    const label = asRecord(entry);
    const id = stringField(label, "id");
    const name = stringField(label, "name");
    return (
      id !== undefined &&
      name !== undefined &&
      added.has(id) &&
      claimed.has(name)
    );
  });
};

/**
 * A Linear webhook payload, normalized against the rules that decide which label adds are work.
 *
 * `undefined` is "this names nothing this adapter can address": not an object, or an issue (a body
 * typed `Issue`, or a relay's untyped one) with no id. The caller answers that as a bad request.
 * Any other entity Linear sends is an event the seam will refuse by name — with or without an id,
 * because some (`IssueSLA`, `OAuthApp`) carry none in `data`, and a `400` to Linear is a retry and,
 * in the end, a disabled webhook.
 */
export const linearEvent = (
  payload: unknown,
  rules: ReadonlyArray<TriggerRule>,
): TriggerEvent | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;

  // A payload with no `type` is a relay's hand-written issue; Linear itself always sends one.
  const type = stringField(body, "type") ?? LINEAR_ISSUE_TYPE;
  const action = stringField(body, "action") ?? TRIGGER_ACTION;

  if (type !== LINEAR_ISSUE_TYPE) {
    // Another entity: its own key space, and an action the filter cannot mistake for an issue's.
    // The delivery, not this key, is what tells two of them apart (`linearRequestId`).
    const entity = asRecord(body["data"]) ?? {};
    return {
      source: "linear",
      key: `${type}:${entityId(entity) ?? "no-id"}`,
      action: `${type}:${action}`,
      title: stringField(entity, "title") ?? "",
      body:
        stringField(entity, "description") ?? stringField(entity, "body") ?? "",
      labels: labelNames(entity["labels"]),
    };
  }

  const entity = issueSubject(body);
  if (entity === undefined) return undefined;
  const id = entityId(entity);
  if (id === undefined) return undefined;

  const starts =
    action === TRIGGER_ACTION ||
    (action === "update" && addedAClaimedLabel(body, entity, rules));
  const team = teamKey(entity);
  // The issue's own link (Linear's `data.url`, or the webhook's top-level `url` for its subject), so a
  // card filed from it can link back (LOB-254). Only a web link: anything else is no link.
  const url = stringField(entity, "url") ?? stringField(body, "url");
  return {
    source: "linear",
    key: id,
    // Only the two starting deliveries are renamed; an edit stays `update` so the recorded reason
    // names what Linear sent.
    action: starts ? TRIGGER_ACTION : action,
    title: stringField(entity, "title") ?? "",
    body: stringField(entity, "description") ?? "",
    labels: labelNames(entity["labels"]),
    ...(team === undefined ? {} : { team }),
    ...(url === undefined || !isWebLink(url) ? {} : { url }),
  };
};

/** What the dedupe key of a delivery that starts nothing is made of, in the order it is tried. */
export type LinearDeliveryHeaders = {
  /** `Linear-Delivery`: the UUID Linear puts on every payload it sends. */
  readonly delivery?: string | undefined;
};

/**
 * Whether the event can start work: the seam's own question (`startsWork` over the rule the mapping
 * would route to), asked the same way here, so the key and the filter cannot disagree about which
 * deliveries are work.
 */
const canStartWork = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule>,
): boolean => {
  const routing = rules.find((rule) => ruleClaims(rule, event));
  const asked =
    routing?.startsWorkFor === undefined ? [] : [routing.startsWorkFor];
  return startsWork(event.action, asked);
};

/** Whether the event is work a rule claims — the deliveries keyed by the issue alone. */
const isMappedWork = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule>,
): boolean =>
  canStartWork(event, rules) && resolveMapping(rules, event) !== undefined;

/** The key of the one delivery an issue starts work under (`linear:<issue id>:mapped`). */
const linearMappedRequestId = (issueId: string): string =>
  `linear:${issueId}:mapped`;

const MAPPED_KEY = /^linear:(.+):mapped$/;

/**
 * The Linear issue a delivery id names, when it is the issue's mapped key — the inverse of
 * `linearMappedRequestId`, beside it so the two cannot drift. A session opened for that delivery is
 * the issue's one session, which is how the write-back (LOB-15, `./LinearSync`) finds the issue a
 * PR or a failure belongs to without a second record of the binding.
 */
export const linearIssueOfDelivery = (
  deliveryId: string | undefined,
): string | undefined => MAPPED_KEY.exec(deliveryId ?? "")?.[1];

/**
 * The Linear issue a card was filed for, from its external ref (`linear:<issue id>`, `externalRefOf`
 * over a Linear event — LOB-254), or `undefined` for a card no Linear delivery filed. The card's runs
 * are how the write-back (`./LinearSync`) reaches the issue when no session was opened by the
 * delivery itself.
 */
export const linearIssueOfExternalRef = (
  externalRef: string | null | undefined,
): string | undefined => {
  const prefix = externalRefOf({ source: "linear", key: "" });
  return externalRef?.startsWith(prefix) === true &&
    externalRef.length > prefix.length
    ? externalRef.slice(prefix.length)
    : undefined;
};

/** The idempotency key for a normalized Linear event: **one issue is one unit of work**. */
export const linearRequestId = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule>,
  payload: unknown,
  headers: LinearDeliveryHeaders = {},
): string => {
  if (isMappedWork(event, rules)) return linearMappedRequestId(event.key);
  if (canStartWork(event, rules)) {
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
  const event = linearEvent(payload, rules);
  if (event === undefined) return undefined;
  return {
    requestId: linearRequestId(event, rules, payload, headers),
    event,
    // The mapped key is the issue, so no later delivery brings a fresh one: an unregistered-repo
    // skip under it must stay reclaimable, or registering the repo could never start the issue.
    ...(isMappedWork(event, rules) ? { keyedByWork: true } : {}),
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
