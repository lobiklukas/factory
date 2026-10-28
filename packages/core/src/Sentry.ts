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
 * `Request-ID` is refused — it is not something Sentry sends.
 *
 * **One Sentry issue is one session while that session is open (LOB-82).** The key is the event, so
 * a *new* event in the same issue — the alert firing again — is a new delivery. The event carries
 * its issue as the fingerprint (`data.event.issue_id`, `TriggerEvent.fingerprint`), and the seam
 * binds that to the session the first event opened, in Postgres (`trigger_fingerprints`), so a repeat
 * alert is a recorded skip naming the open session — before and after a restart — and only an issue
 * whose session was closed (its workspace released: done, canceled, merged, discarded) or has been
 * idle past `TRIGGER_FINGERPRINT_IDLE_AFTER` (a run that judged the alert noise and opened no PR is
 * never released) opens another. A card rule files the issue's card under the issue, not the event.
 *
 * **The filter is the deployment's, and a refusal names the field (LOB-82).** `SENTRY_MIN_LEVEL`,
 * `SENTRY_ENVIRONMENTS` and `SENTRY_RELEASES` (`sentryFilterFromEnv`) narrow which alerts are work:
 * an alert outside them keeps its `create` but carries `filtered` — `level "warning" is below
 * SENTRY_MIN_LEVEL "error"` — which the seam records as the delivery's skip reason. It is keyed by
 * its `Request-ID` like any delivery that cannot start work, and spends no rate-cap token.
 *
 * **The title says where it broke.** A session's title is the event's title with its environment and
 * release (`ReferenceError: x (production, release web@1.2.3)`), so a list of sessions tells a
 * production alert from a staging one without opening either. The rule's prompt, when it writes
 * none, is `SENTRY_PROMPT_TEMPLATE`: investigate before editing. The event carries it
 * (`TriggerEvent.defaultPrompt`), so the generic seam names no Sentry vocabulary.
 *
 * **The labels are the mapping.** Sentry names no repository, so a rule says which repo an alert
 * means: every delivery carries `sentry`, and one that names its project also carries
 * `sentry:project:<id>`, so one rule can route a single project ahead of a `sentry` catch-all.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import {
  ruleClaims,
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

/**
 * The default Sentry rule's prompt (LOB-82): what a session opened by an alert is told when the rule
 * that routed it writes no prompt of its own (a blank `prompt`). `{{title}}` and `{{body}}` are
 * `renderPrompt`'s; the body is the alert's facts, one `name: value` line each (`alertBody`).
 *
 * An alert is a symptom with a stack trace, not a task: the cheapest wrong outcome is an agent that
 * edits the line the trace points at and silences the error. So the session is told to establish the
 * cause, and say it, before it changes anything — and that "this is not ours" or "this is noise" is
 * an answer that ends the run without a change. Documented in `.pi/skills/verify-api/features/sentry.md`.
 */
export const SENTRY_PROMPT_TEMPLATE = [
  "A Sentry alert fired: {{title}}",
  "",
  "{{body}}",
  "",
  "Investigate before you edit anything. Find where this error is raised and why: read the culprit and the code around it, and reproduce the failure with a test if you can. Then state the root cause in a short paragraph before you change any file.",
  "",
  "If the cause is outside this repository, or the alert is noise, say so and stop without editing. Otherwise fix the root cause rather than the symptom, keep the change as small as the fix needs, and open a pull request whose description names the Sentry issue and the root cause.",
].join("\n");

/** Sentry's event levels, least to most severe: what `SENTRY_MIN_LEVEL` compares against. */
export const SENTRY_LEVELS = [
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
] as const;
export type SentryLevel = (typeof SENTRY_LEVELS)[number];

/**
 * Which alerts are work (LOB-82). Each field absent is "any"; an alert that fails one is a recorded
 * skip naming that field and the value it carried.
 *
 * - `minLevel`: the alert's `level` is at least this severe (`SENTRY_LEVELS`).
 * - `environments`: the alert's `environment` is one of these.
 * - `releases`: the alert's `release` is one of these; an entry ending in `*` is a prefix
 *   (`web@2.*`), because a release is a version and an exact list would need an edit per deploy.
 *
 * An alert that names no environment (or release) fails a filter that lists some: the operator asked
 * for these and only these, and "unknown" is not one of them.
 */
export type SentryFilter = {
  readonly minLevel?: SentryLevel | undefined;
  readonly environments?: ReadonlyArray<string> | undefined;
  readonly releases?: ReadonlyArray<string> | undefined;
};

/** The variables a filter is read from. */
export const SENTRY_MIN_LEVEL_VARIABLE = "SENTRY_MIN_LEVEL";
export const SENTRY_ENVIRONMENTS_VARIABLE = "SENTRY_ENVIRONMENTS";
export const SENTRY_RELEASES_VARIABLE = "SENTRY_RELEASES";

const isSentryLevel = (value: string): value is SentryLevel =>
  (SENTRY_LEVELS as ReadonlyArray<string>).includes(value);

const commaList = (
  raw: string | undefined,
): ReadonlyArray<string> | undefined => {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length === 0 ? undefined : entries;
};

/**
 * The filter an environment names. A blank or unset variable is "any"; a `SENTRY_MIN_LEVEL` that is
 * not a Sentry level is an error naming the variable and the levels it may be, which the route
 * answers `503` — a typo must not quietly admit every alert, or none.
 */
export const sentryFilterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly filter: SentryFilter }
  | { readonly ok: false; readonly message: string } => {
  const level = (env[SENTRY_MIN_LEVEL_VARIABLE] ?? "").trim().toLowerCase();
  const minLevel = level === "" || !isSentryLevel(level) ? undefined : level;
  if (level !== "" && minLevel === undefined) {
    return {
      ok: false,
      message: `${SENTRY_MIN_LEVEL_VARIABLE} is "${level}"; it must be one of ${SENTRY_LEVELS.join(", ")}`,
    };
  }
  const environments = commaList(env[SENTRY_ENVIRONMENTS_VARIABLE]);
  const releases = commaList(env[SENTRY_RELEASES_VARIABLE]);
  return {
    ok: true,
    filter: {
      ...(minLevel === undefined ? {} : { minLevel }),
      ...(environments === undefined ? {} : { environments }),
      ...(releases === undefined ? {} : { releases }),
    },
  };
};

/** Whether `value` is one of `allowed`, where an entry ending in `*` is a prefix. */
const listed = (value: string, allowed: ReadonlyArray<string>): boolean =>
  allowed.some((entry) =>
    entry.endsWith("*")
      ? value.startsWith(entry.slice(0, -1))
      : value === entry,
  );

const quotedList = (entries: ReadonlyArray<string>): string =>
  `[${entries.join(", ")}]`;

/**
 * Why `filter` refuses an alert with these facts, or `undefined` when it admits it. The reason names
 * the field, the value the alert carried and what the filter asked for — the first field that fails,
 * in the order level, environment, release.
 */
export const sentryFilterRefusal = (
  facts: {
    readonly level?: string | undefined;
    readonly environment?: string | undefined;
    readonly release?: string | undefined;
  },
  filter: SentryFilter,
): string | undefined => {
  if (filter.minLevel !== undefined) {
    const level = facts.level?.toLowerCase();
    if (level === undefined) {
      return `level is missing; ${SENTRY_MIN_LEVEL_VARIABLE} is "${filter.minLevel}"`;
    }
    if (!isSentryLevel(level)) {
      return `level "${facts.level}" is not a Sentry level, so it is not at least ${SENTRY_MIN_LEVEL_VARIABLE} "${filter.minLevel}"`;
    }
    if (SENTRY_LEVELS.indexOf(level) < SENTRY_LEVELS.indexOf(filter.minLevel)) {
      return `level "${level}" is below ${SENTRY_MIN_LEVEL_VARIABLE} "${filter.minLevel}"`;
    }
  }
  if (filter.environments !== undefined) {
    if (facts.environment === undefined) {
      return `environment is missing; ${SENTRY_ENVIRONMENTS_VARIABLE} is ${quotedList(filter.environments)}`;
    }
    if (!listed(facts.environment, filter.environments)) {
      return `environment "${facts.environment}" is not in ${SENTRY_ENVIRONMENTS_VARIABLE} ${quotedList(filter.environments)}`;
    }
  }
  if (filter.releases !== undefined) {
    if (facts.release === undefined) {
      return `release is missing; ${SENTRY_RELEASES_VARIABLE} is ${quotedList(filter.releases)}`;
    }
    if (!listed(facts.release, filter.releases)) {
      return `release "${facts.release}" is not in ${SENTRY_RELEASES_VARIABLE} ${quotedList(filter.releases)}`;
    }
  }
  return undefined;
};

/**
 * A session's title for an alert: the event's title, then its environment and release when the
 * payload has them — `ReferenceError: x (production, release web@1.2.3)`.
 */
export const sentryTitle = (
  title: string,
  facts: {
    readonly environment?: string | undefined;
    readonly release?: string | undefined;
  },
): string => {
  const where = [
    facts.environment,
    facts.release === undefined ? undefined : `release ${facts.release}`,
  ].filter((part): part is string => part !== undefined);
  if (where.length === 0) return title;
  const suffix = `(${where.join(", ")})`;
  return title === "" ? suffix : `${title} ${suffix}`;
};

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
  filter: SentryFilter = {},
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
    const facts = {
      level: stringField(event, "level"),
      environment: stringField(event, "environment"),
      release: stringField(event, "release"),
    };
    const issueId = idField(event, "issue_id");
    const filtered = sentryFilterRefusal(facts, filter);
    return {
      source: "sentry",
      key: eventId,
      action:
        action === SENTRY_ALERT_ACTION
          ? TRIGGER_ACTION
          : `${resource}:${action}`,
      title: sentryTitle(stringField(event, "title") ?? "", facts),
      body: alertBody(event, stringField(data, "triggered_rule")),
      labels: labelsOf(event),
      // Every event in one Sentry issue shares its `issue_id`: the seam binds the issue to the
      // session its first alert opened.
      ...(issueId === undefined ? {} : { fingerprint: issueId }),
      ...(filtered === undefined ? {} : { filtered }),
      // What a rule with a blank prompt tells the session: the adapter's, not the seam's.
      defaultPrompt: SENTRY_PROMPT_TEMPLATE,
    };
  }

  // Another resource: its own key space, and an action the filter cannot mistake for an alert's.
  // The delivery, not this key, is what tells two of them apart (`sentryDelivery`).
  const subject = asRecord(data?.[resource]);
  const subjectId = idField(subject, "id");
  return {
    source: "sentry",
    key: `${resource}:${subjectId ?? NO_ID}`,
    action: `${resource}:${action}`,
    title: stringField(subject, "title") ?? "",
    body: stringField(subject, "culprit") ?? "",
    labels: labelsOf(subject),
    // An `issue` delivery is about the issue an alert's `issue_id` names, so a rule that opts
    // `issue:created` in and the alerts that follow share one binding.
    ...(resource === "issue" && subjectId !== undefined
      ? { fingerprint: subjectId }
      : {}),
    defaultPrompt: SENTRY_PROMPT_TEMPLATE,
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
  // An alert the deployment's filter refuses starts nothing, whatever a rule admits.
  if (event.filtered !== undefined) return false;
  const routing = rules.find((rule) => ruleClaims(rule, event));
  return startsWork(
    event.action,
    routing?.startsWorkFor === undefined ? [] : [routing.startsWorkFor],
  );
};

/**
 * A payload as the seam takes it: the normalized event, named by its derived delivery id. An issue
 * alert is keyed by its event and an action `rules` opt in by its subject and action (both
 * `keyedByWork`); anything else — an alert `filter` refuses included — by the `Request-ID` it
 * arrived with. `rules` must be the ones the seam maps with, or the key could call a delivery work
 * the filter refuses, or the reverse.
 */
export const sentryDelivery = (
  payload: unknown,
  headers: SentryDeliveryHeaders = {},
  rules: ReadonlyArray<TriggerRule> = [],
  filter: SentryFilter = {},
): TriggerDelivery | SentryRefusal => {
  const event = sentryEvent(payload, { resource: headers.resource }, filter);
  if (event === undefined) {
    return {
      refused: "the payload does not name a Sentry resource and event",
      code: "bad-payload",
    };
  }
  if (event.action === TRIGGER_ACTION && event.filtered === undefined) {
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
