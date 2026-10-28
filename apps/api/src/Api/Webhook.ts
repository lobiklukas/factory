/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/* oxlint-disable effecttsgo/prefer-schema-over-json */
/**
 * Inbound trigger routes (LOB-188): three adapters over one seam.
 *
 * `POST /webhooks/linear` is the Linear adapter — Linear's own HMAC header and payload —
 * `POST /webhooks/sentry` the Sentry receiver (LOB-81, `@repo/core/Sentry`), and
 * `POST /webhooks/generic` is the plain inbound webhook: any sender that can sign a body and name
 * a label. All three do the same things before the seam sees a delivery, in this order because each
 * one is cheaper than the next and refuses more:
 *
 * 1. **Refuse an oversized body** before it is parsed or written down. The server-wide cap (1 MiB,
 *    LOB-21) is what protects the process; this one (`TRIGGER_MAX_BODY_BYTES`, 64 KiB by default) is
 *    what protects the delivery store and the session queue, and answering it here is what keeps a
 *    huge body from creating a `webhook_deliveries` row.
 * 2. **Verify the signature.** A wrong or missing one is `401` and writes nothing.
 * 3. **Parse and normalize.** A body that is not a JSON object is `400`, and so is one the adapter
 *    cannot address: a generic body with no request id or no label, or a Linear issue body with no
 *    issue id (any other Linear entity is answered and skipped, id or not). A generic body that
 *    names a lifecycle action (`push`, `schedule`) is `400` too: its `action` is whatever the
 *    caller typed, and only the adapter that observed a push or a tick may say one happened
 *    (LOB-235). The adapter names the delivery's idempotency key here and nothing else about it:
 *    the generic sender supplies its own, and the Linear adapter derives one from the issue
 *    (LOB-164), because which deliveries are the same work is a fact about the sender.
 * 4. **Take a token from the route's rate cap**, when the adapter has one, for a delivery that can
 *    start work (Sentry's: an alert storm is a burst of *signed* deliveries, each of which may open
 *    a session). It is counted after the signature, so a caller without the secret cannot spend the
 *    budget an honest alert needs, and after normalization, so a delivery that can start nothing (an
 *    `issue` or `installation` delivery, a malformed body) cannot either: those are cheap skips and
 *    `400`s, and an `issue` firehose must not starve the alerts. A replay of work already handled
 *    still counts, because only the seam knows it is one. A delivery past the cap is `429
 *    rate-limited` with `Retry-After` — typed, never a `500`, and nothing recorded. The cap is per
 *    process (`RateLimiter` over its memory store): it bounds how fast one process opens work, and
 *    unlike the dedupe it is not a fact a restart has to keep.
 * 5. **Delegate.** Everything about replays, refusals, mapping and sessions is
 *    `@repo/core`'s `TriggerService`, so an adapter cannot invent its own claim or skip. The one
 *    outcome the route translates is a replay still `received` — work claimed with no outcome
 *    yet — which is `503 in-progress` rather than `200`, so the sender keeps retrying (LOB-216) —
 *    and one failure: a session the server had no slot for (LOB-70) is `503 at-capacity` with
 *    `Retry-After`, never a `500`, and its claim is released so the retry is a fresh delivery.
 *
 * The signature scheme is shared (`hmac-sha256` over the raw body, hex, in a configurable header)
 * because that is what Linear already does; an adapter whose provider signs differently brings its
 * own check, which is what Slack's timestamped signature does in `@repo/core/Slack` (LOB-191). Sentry
 * signs the shared way, but its check is `@repo/core`'s typed `verifySentrySignature`, so the logged
 * refusal says which of "missing" and "wrong" it was.
 *
 * **A refusal is logged; its payload is not.** Every answer before the seam (`401`, `413`, `429`)
 * writes one warning naming the route, the code, the body's size and the delivery header — never
 * the body, which on a `401` is a stranger's unauthenticated text and on any route may be an
 * alert's stack trace and user data.
 *
 * **A route with no secret refuses every delivery.** An unset secret used to mean "accept", which
 * was harmless while `/webhooks/linear` recorded everything as `skipped`; now that a delivery can
 * start a session, accepting unsigned ones would let anyone who can reach the port open an agent.
 * So the secret is configuration, not a default: `503` names the missing variable, and a
 * deployment that wants the route sets it.
 */
import { Clock, Duration, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RateLimiter } from "effect/persistence";
import {
  ENV_RULES_ORIGIN,
  JIRA_SIGNATURE_HEADER,
  jiraDelivery,
  linearDeliveryFor,
  SENTRY_REQUEST_ID_HEADER,
  SENTRY_RESOURCE_HEADER,
  SENTRY_SIGNATURE_HEADER,
  sentryDelivery,
  sentryFilterFromEnv,
  sentryStartsWork,
  slackDelivery,
  slackFilterFromEnv,
  slackUrlVerification,
  verifyJiraSignature,
  verifySentrySignature,
  verifySlackSignature,
  TaskServiceLive,
  TriggerCardsFromTaskService,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
  triggerFailureAnswer,
} from "@repo/core";
import type {
  TriggerAuthor,
  TriggerDelivery,
  TriggerEvent,
  TriggerRule,
} from "@repo/domain/Trigger";
import { LIFECYCLE_ACTIONS, TRIGGER_ACTION } from "@repo/domain/Trigger";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readTriggerRules } from "./WebhookBoot";
import {
  slackEnv,
  TriggerAuthorPermissionsLive,
  TriggerWriteBacksLive,
} from "./TriggerAdapters";

/** The default cap on a trigger delivery, in bytes. */
const DEFAULT_MAX_BODY_BYTES = 65_536;

/**
 * The `Retry-After` on a replay of a delivery still in flight, in seconds: about how long an honest
 * claim takes to record its outcome. A sender that honours it re-reads the row then; one that keeps
 * its own schedule (Linear) is still told to retry by the status.
 */
const IN_PROGRESS_RETRY_AFTER_S = 60;

/** The header a generic sender signs into, when the deployment names none. */
const DEFAULT_SECRET_HEADER = "x-trigger-signature";

/** Where a generic sender puts the delivery's idempotency key, when it is not in the body. */
const DEFAULT_DELIVERY_HEADER = "x-trigger-delivery";

/** A signature check's answer: `ok`, or the reason it is not, which the refusal log names. */
type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: string };

const verifySignature = (
  raw: string,
  signature: string | undefined,
  secret: string,
): SignatureVerdict => {
  if (!signature) return { ok: false, refusal: "missing-signature" };
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    )
      ? { ok: true }
      : { ok: false, refusal: "bad-signature" };
  } catch {
    return { ok: false, refusal: "bad-signature" };
  }
};

/** The default cap on Sentry deliveries one process admits: this many per window. */
const DEFAULT_SENTRY_RATE_LIMIT = 20;

/** The default window the Sentry cap counts over, in seconds. */
const DEFAULT_SENTRY_RATE_WINDOW_S = 60;

/**
 * A positive integer from an environment value, or the default when it is unset or not one. The
 * caller reads `process.env["NAME"]` itself, so the dev-task guard sees every name (LOB-257).
 */
const positiveInteger = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * How much of a request header a refusal log may carry. The header is the sender's text, so it is
 * cut and stripped of control characters: a log line is one line, whoever wrote the header.
 */
const MAX_LOGGED_HEADER_CHARS = 128;

const loggable = (value: string | undefined): string =>
  value === undefined
    ? "none"
    : Array.from(value.slice(0, MAX_LOGGED_HEADER_CHARS), (char) => {
        const code = char.charCodeAt(0);
        return code < 0x20 || code === 0x7f ? "?" : char;
      }).join("");

const parseJson = (raw: string): Effect.Effect<unknown> =>
  // oxlint-disable-next-line effecttsgo(prefer-schema-over-json)
  Effect.sync((): unknown => {
    try {
      // oxlint-disable-next-line effecttsgo(prefer-schema-over-json)
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

const badRequest = (error: string, code: string) =>
  HttpServerResponse.setStatus(
    HttpServerResponse.jsonUnsafe({ ok: false, error, code }),
    400,
  );

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

/** A generic sender's `labels`: bare strings, or Linear-style `{name}` objects. */
const labelNames = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") names.push(entry);
    else {
      const name = stringField(asRecord(entry), "name");
      if (name !== undefined) names.push(name);
    }
  }
  return names;
};

/**
 * A generic sender's `author` (S-trigger-trust-gating): a bare id, or `{id, login?, name?}`. The
 * sender holds the route's secret, so it is the one vouching for who it names; a rule's trust gate
 * checks the name against its allowlist like any other source's.
 */
const genericAuthor = (value: unknown): TriggerAuthor | undefined => {
  if (typeof value === "string") return value === "" ? undefined : { id: value };
  const record = asRecord(value);
  const id = stringField(record, "id");
  if (id === undefined || id === "") return undefined;
  const login = stringField(record, "login");
  const name = stringField(record, "name");
  return {
    id,
    ...(login === undefined ? {} : { login }),
    ...(name === undefined ? {} : { name }),
  };
};

/**
 * The generic payload: `{requestId?, action?, label?, labels?, title?, body?, author?, createdAt?}`.
 * `label` is the one field a sender must supply — it is what a mapping rule matches — and the rest is
 * carried into the prompt, or, for `author` and `createdAt`, to a rule's trust gate. `action`
 * defaults to `create`; a lifecycle action, or any action a rule admits through `startsWorkFor`, is
 * refused by `genericDelivery`.
 */
const genericEvent = (
  payload: Record<string, unknown>,
): TriggerEvent | undefined => {
  const label = stringField(payload, "label");
  const labels = [
    ...labelNames(payload["labels"]),
    ...(label === undefined ? [] : [label]),
  ];
  if (labels.length === 0) return undefined;
  const title = stringField(payload, "title") ?? "";
  const key = stringField(payload, "key") ?? stringField(payload, "requestId");
  const author = genericAuthor(payload["author"]);
  const createdAt = stringField(payload, "createdAt");
  return {
    source: "generic",
    key: key ?? title,
    action: stringField(payload, "action") ?? "create",
    title,
    body: stringField(payload, "body") ?? "",
    labels,
    ...(author === undefined ? {} : { author }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
};

/**
 * A body the adapter cannot turn into a delivery: the `400` it answers, and its code. `status` is
 * for the one refusal that is not the sender's fault — the route's own configuration does not parse
 * (`503 not-configured`), which the sender should retry once an operator fixes it.
 */
type Refusal = {
  readonly refused: string;
  readonly code: string;
  readonly status?: 503;
};

/** How an adapter reads a request header: by name, in any case. */
type HeaderLookup = (name: string) => string | undefined;

/**
 * The actions the generic caller may not name: the two lifecycle actions, and any other a rule
 * admits through `startsWorkFor`. A rule's list is operator config of any string, so a fixed
 * denylist alone would let a caller name `release` the moment a rule asked for it — and the seam
 * would record that rule mapping it (LOB-235 review). `create` is the generic caller's own action
 * and is never in this set.
 */
const callerCannotName = (
  rules: ReadonlyArray<TriggerRule>,
): ReadonlySet<string> =>
  new Set(
    [
      ...LIFECYCLE_ACTIONS,
      ...rules.flatMap((rule) => rule.startsWorkFor ?? []),
    ].filter((action) => action !== TRIGGER_ACTION),
  );

/**
 * The generic adapter's delivery: the id is the configured header, else the body's own
 * `requestId` — the sender names its delivery, because nothing else can.
 */
const genericDelivery = (deliveryHeader: string) => {
  return (
    payload: Record<string, unknown>,
    header: HeaderLookup,
    rules: ReadonlyArray<TriggerRule>,
  ): TriggerDelivery | Refusal => {
    const refusedActions = callerCannotName(rules);
    const requestId =
      header(deliveryHeader) ??
      stringField(payload, "requestId") ??
      stringField(payload, "webhookId") ??
      stringField(payload, "id");
    if (requestId === undefined) {
      return { refused: "missing requestId", code: "missing-request-id" };
    }
    const event = genericEvent(payload);
    if (event === undefined) {
      return {
        refused: "the payload does not name an issue or a label",
        code: "bad-payload",
      };
    }
    // The generic caller types its own `action`, so it cannot be the one that says a push or a
    // schedule tick happened: those are facts only the GitHub push route and the schedule daemon
    // observe (LOB-197). Admitting one would let the seam record `rule "docs" mapped it …` about a
    // delivery no push produced (LOB-235). The same holds for any action a rule's `startsWorkFor`
    // admits (`callerCannotName`). Refusing it here, before the seam, also writes no
    // `webhook_deliveries` row, so nothing recorded can claim it. Any other non-`create` action
    // still reaches the seam, whose filter records it `skipped` with its reason.
    if (refusedActions.has(event.action)) {
      return {
        refused: `the generic webhook cannot name the lifecycle action "${event.action}"; only the adapter that observes it can, so send "create"`,
        code: "lifecycle-action",
      };
    }
    return { requestId, event };
  };
};

/** One adapter: how its body is authenticated, and how it becomes a delivery. */
type Adapter = {
  /** The header the signature arrives in, in whatever case `config` named it. */
  readonly signatureHeader: string;
  /** The signature's secret, or `undefined` when this deployment configured none. */
  readonly secret: string | undefined;
  /**
   * The normalized event and its idempotency key. The key is the adapter's, because which
   * deliveries are the same work is a fact about the sender: the generic caller names its own,
   * and the Linear adapter derives it from the issue (`@repo/core/Linear`).
   */
  readonly delivery: (
    payload: Record<string, unknown>,
    header: HeaderLookup,
    rules: ReadonlyArray<TriggerRule>,
  ) => TriggerDelivery | Refusal;
  /** The variable the missing-secret refusal names, so an operator knows what to set. */
  readonly secretVariable: string;
  /** The route's path, which the refusal log names. */
  readonly route: string;
  /** The header naming one delivery, which the refusal log carries in place of the body. */
  readonly deliveryHeader: string;
  /**
   * The adapter's own signature check, when its provider's is typed in `@repo/core`; the shared
   * hex HMAC over the raw body otherwise.
   */
  readonly verify?: (
    raw: string,
    signature: string | undefined,
    secret: string,
    /** What a scheme that signs more than the body needs: the other headers, and the time. */
    request: { readonly header: HeaderLookup; readonly nowSeconds: number },
  ) => SignatureVerdict;
  /**
   * A signed payload that is a handshake, not a delivery: the JSON body to answer `200` with, or
   * `undefined` for a payload that is one. Nothing is recorded, and the seam is not asked.
   */
  readonly handshake?: (
    payload: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  /**
   * The route's rate cap: at most `limit` signed deliveries that `counts` admits per
   * `windowSeconds` in this process. Absent is uncapped, which is what the Linear and generic
   * routes are today. `counts` is "can this delivery start work", asked the seam's way, so a
   * delivery the seam will only skip spends none of the budget.
   */
  readonly rateCap?: {
    readonly limit: number;
    readonly windowSeconds: number;
    readonly counts: (
      delivery: TriggerDelivery,
      rules: ReadonlyArray<TriggerRule>,
    ) => boolean;
  };
};

/** A real failure, not a refusal: `500`, so the sender retries rather than stopping on work nobody recorded. */
const storageFailure = (cause: {
  readonly message: string;
  readonly code: string;
}) =>
  HttpServerResponse.setStatus(
    HttpServerResponse.jsonUnsafe({
      ok: false,
      error: cause.message,
      code: cause.code,
    }),
    500,
  );

const handle = (adapter: () => Adapter) =>
  Effect.gen(function* () {
    const config = adapter();
    const triggers = yield* TriggerService;
    const limiter = yield* RateLimiter.RateLimiter;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* req.text;
    const size = Buffer.byteLength(raw, "utf8");

    // The one record a refusal leaves: what was refused and why, never what it said.
    const logRefusal = (code: string) =>
      Effect.logWarning(
        `webhook ${config.route}: refused ${code} (delivery ${loggable(
          req.headers[config.deliveryHeader.toLowerCase()] as
            | string
            | undefined,
        )}, ${size} bytes)`,
      );

    const secret = config.secret ?? "";
    if (secret === "") {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({
          ok: false,
          error: `this route has no secret configured (${config.secretVariable}); it accepts nothing until one is set`,
          code: "not-configured",
        }),
        503,
      );
    }

    const cap = Number(
      process.env["TRIGGER_MAX_BODY_BYTES"] ?? DEFAULT_MAX_BODY_BYTES,
    );
    const limit =
      Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_BODY_BYTES;
    if (size > limit) {
      yield* logRefusal("body-too-large");
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({
          ok: false,
          error: `the delivery is ${size} bytes; the limit is ${limit}`,
          code: "body-too-large",
        }),
        413,
      );
    }

    // Header names are case-insensitive, and the incoming map is lowercase; a configured
    // `X-Trigger-Signature` must not turn every signed delivery into a 401.
    const signatureHeader = config.signatureHeader.toLowerCase();
    const header: HeaderLookup = (name) =>
      req.headers[name.toLowerCase()] as string | undefined;
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const verdict = (config.verify ?? verifySignature)(
      raw,
      req.headers[signatureHeader] as string | undefined,
      secret,
      { header, nowSeconds },
    );
    if (!verdict.ok) {
      yield* logRefusal(verdict.refusal);
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({
          ok: false,
          error: "bad signature",
          code: verdict.refusal,
        }),
        401,
      );
    }

    // oxlint-disable-next-line effecttsgo(prefer-schema-over-json)
    const payload = yield* parseJson(raw);
    const body = asRecord(payload);
    if (body === undefined) {
      return badRequest("the body is not a JSON object", "bad-json");
    }

    const handshake = config.handshake?.(body);
    if (handshake !== undefined)
      return HttpServerResponse.jsonUnsafe(handshake);

    // The rules this delivery is normalized against: the stored routes as they are right now, then
    // `TRIGGER_RULES` (LOB-266). Read after the refusals that need no rule, so a stranger's unsigned
    // body costs no query; the seam reads the same set again to map, and the two reads differ only
    // if an operator edits a route between them.
    const read = yield* triggers.rules.pipe(
      Effect.map((rules) => ({ ok: true as const, rules })),
      Effect.catchTag("TriggerError", (cause) =>
        Effect.succeed({ ok: false as const, cause }),
      ),
    );
    if (!read.ok) return storageFailure(read.cause);
    const rules = read.rules;
    const delivery = config.delivery(body, header, rules);
    if ("refused" in delivery) {
      if (delivery.status === 503) {
        yield* logRefusal(delivery.code);
        return HttpServerResponse.setStatus(
          HttpServerResponse.jsonUnsafe({
            ok: false,
            error: delivery.refused,
            code: delivery.code,
          }),
          503,
        );
      }
      return badRequest(delivery.refused, delivery.code);
    }

    // The rate cap, on signed deliveries that can start work only. One key per route: the cap
    // bounds how fast this process lets the route open work, whoever the sender says it is. A
    // delivery the seam would only skip spends no token, so a firehose of them cannot starve an
    // alert of the budget.
    if (
      config.rateCap !== undefined &&
      config.rateCap.counts(delivery, rules)
    ) {
      const { limit: perWindow, windowSeconds } = config.rateCap;
      const admitted = yield* limiter
        .consume({
          algorithm: "fixed-window",
          onExceeded: "fail",
          key: `webhook:${config.route}`,
          limit: perWindow,
          window: Duration.seconds(windowSeconds),
        })
        .pipe(
          Effect.as({ verdict: "admitted" as const }),
          Effect.catchTag("RateLimiterError", (error) =>
            Effect.succeed(
              error.reason._tag === "RateLimitExceeded"
                ? {
                    verdict: "exceeded" as const,
                    retryAfterSeconds: Math.max(
                      1,
                      Math.ceil(Duration.toSeconds(error.reason.retryAfter)),
                    ),
                  }
                : {
                    verdict: "unavailable" as const,
                    message: error.message,
                  },
            ),
          ),
        );
      if (admitted.verdict === "unavailable") {
        // The cap's store did not answer. The memory store cannot fail; a shared one could, and the
        // honest answer then is "not now", not a delivery admitted past a cap nobody counted.
        yield* logRefusal("rate-cap-unavailable");
        return HttpServerResponse.jsonUnsafe(
          {
            ok: false,
            code: "rate-cap-unavailable",
            error: `the rate cap could not be read: ${admitted.message}`,
          },
          {
            status: 503,
            headers: { "retry-after": String(windowSeconds) },
          },
        );
      }
      if (admitted.verdict === "exceeded") {
        yield* logRefusal("rate-limited");
        return HttpServerResponse.jsonUnsafe(
          {
            ok: false,
            code: "rate-limited",
            error: `this route admits ${perWindow} deliveries per ${windowSeconds}s; retry after ${admitted.retryAfterSeconds}s`,
            limit: perWindow,
            windowSeconds,
            retryAfterSeconds: admitted.retryAfterSeconds,
          },
          {
            status: 429,
            headers: { "retry-after": String(admitted.retryAfterSeconds) },
          },
        );
      }
    }

    const outcome = yield* triggers.deliver(delivery).pipe(
      Effect.map((delivered) => ({ ok: true as const, delivered })),
      // A refusal is an answer (`skipped`), so only a failure reaches here: answer `500` so the
      // sender retries, rather than `200` on work that never got recorded — or, when the session
      // layer was at capacity (LOB-70), `503 at-capacity` with `Retry-After`: a "not now", whose
      // claim the seam released, so the redelivery claims afresh and opens the session then.
      Effect.catchTag("TriggerError", (cause) =>
        Effect.succeed({ ok: false as const, cause }),
      ),
    );
    if (!outcome.ok) {
      if (outcome.cause.code !== "at-capacity")
        return storageFailure(outcome.cause);
      yield* logRefusal("at-capacity");
      const answer = triggerFailureAnswer(outcome.cause);
      return HttpServerResponse.jsonUnsafe(answer.body, {
        status: answer.status,
        ...(answer.headers === undefined ? {} : { headers: answer.headers }),
      });
    }
    const delivered = outcome.delivered;
    if (delivered.replayed && delivered.status === "received") {
      // A replay of a claim with no outcome yet is not an answer a sender may stop on: the first
      // process may be working, or may have died (`SIGKILL`) and left a claim that only the seam's
      // reclaim window recovers. A `200` here would end Linear's retries for good — it retries a
      // failed delivery after 1 minute, 1 hour and 6 hours, and only on a non-`200` — so a killed
      // delivery's first retry, which lands inside the window, would be its last (LOB-216). `503`
      // with `Retry-After` keeps the sender retrying until a later attempt reads the recorded
      // outcome or reclaims the stale claim; the body still says what the seam saw.
      return HttpServerResponse.jsonUnsafe(
        {
          ok: false,
          status: delivered.status,
          replayed: true,
          code: "in-progress",
          error: "this delivery is claimed and has no outcome yet; retry later",
        },
        {
          status: 503,
          headers: { "retry-after": String(IN_PROGRESS_RETRY_AFTER_S) },
        },
      );
    }
    return HttpServerResponse.jsonUnsafe({
      ok: true,
      status: delivered.status,
      replayed: delivered.replayed,
      ...(delivered.sessionId === undefined
        ? {}
        : { sessionId: delivered.sessionId }),
      ...(delivered.taskId === undefined ? {} : { taskId: delivered.taskId }),
      ...(delivered.reason === undefined ? {} : { reason: delivered.reason }),
    });
  });

/**
 * The Linear adapter (`@repo/core/Linear`, LOB-164). It derives its own delivery: the key is the
 * issue for a delivery that can start work, so a retry Linear sends with a fresh header and a fresh
 * `webhookTimestamp` cannot open a second session. `rules` is the seam's own set (`TriggerService.rules`: the stored
 * routes, then `TRIGGER_RULES`), so the key and the mapping cannot disagree about which payloads a rule claims.
 */
const linearRoute = HttpRouter.add(
  "POST",
  "/webhooks/linear",
  handle(() => ({
    route: "/webhooks/linear",
    deliveryHeader: "linear-delivery",
    signatureHeader: "linear-signature",
    secret: process.env["LINEAR_WEBHOOK_SECRET"],
    secretVariable: "LINEAR_WEBHOOK_SECRET",
    delivery: (payload, header, rules) =>
      linearDeliveryFor(rules)(payload, {
        delivery: header("linear-delivery"),
      }) ?? {
        refused: "the payload does not name a Linear issue",
        code: "bad-payload",
      },
  })),
);

/**
 * The generic adapter. `rules` is the seam's own set (`TriggerService.rules`), so the actions it
 * refuses are exactly the ones a rule would otherwise admit from a caller-typed `action`.
 */
const genericRoute = HttpRouter.add(
  "POST",
  "/webhooks/generic",
  handle(() => ({
    route: "/webhooks/generic",
    deliveryHeader:
      process.env["TRIGGER_DELIVERY_HEADER"] ?? DEFAULT_DELIVERY_HEADER,
    signatureHeader:
      process.env["TRIGGER_SECRET_HEADER"] ?? DEFAULT_SECRET_HEADER,
    secret: process.env["TRIGGER_SECRET"],
    secretVariable: "TRIGGER_SECRET",
    delivery: genericDelivery(
      process.env["TRIGGER_DELIVERY_HEADER"] ?? DEFAULT_DELIVERY_HEADER,
    ),
  })),
);

/**
 * The Sentry receiver (`@repo/core/Sentry`, LOB-81): Sentry's own signature header, checked with the
 * integration's Client Secret (`SENTRY_CLIENT_SECRET`); the delivery keyed by the alerted event; and
 * the one rate-capped route — `SENTRY_RATE_LIMIT` signed deliveries that can start work per
 * `SENTRY_RATE_WINDOW_SECONDS` (20 per 60 s by default) in this process. An alert storm is the burst
 * the cap exists for: every alert past it is `429`, and every one inside it is still deduped by its
 * event. A delivery no rule lets start work (`issue`, `comment`, `installation`, …) spends no token;
 * `rules` is the seam's, so the cap, the key and the filter agree on which those are. Neither does an
 * alert outside `SENTRY_MIN_LEVEL`, `SENTRY_ENVIRONMENTS` or `SENTRY_RELEASES` (LOB-82): the seam
 * records it skipped with the field that failed.
 */
const sentryRoute = HttpRouter.add(
  "POST",
  "/webhooks/sentry",
  handle(() => ({
    route: "/webhooks/sentry",
    deliveryHeader: SENTRY_REQUEST_ID_HEADER,
    signatureHeader: SENTRY_SIGNATURE_HEADER,
    secret: process.env["SENTRY_CLIENT_SECRET"],
    secretVariable: "SENTRY_CLIENT_SECRET",
    verify: (raw, signature, clientSecret) =>
      verifySentrySignature({ raw, signature, clientSecret }),
    rateCap: {
      limit: positiveInteger(
        process.env["SENTRY_RATE_LIMIT"],
        DEFAULT_SENTRY_RATE_LIMIT,
      ),
      windowSeconds: positiveInteger(
        process.env["SENTRY_RATE_WINDOW_SECONDS"],
        DEFAULT_SENTRY_RATE_WINDOW_S,
      ),
      counts: (delivery, rules) => sentryStartsWork(delivery.event, rules),
    },
    delivery: (payload, header, rules) => {
      // The filter (LOB-82) is read per delivery, like Slack's: which alerts are work is the
      // deployment's, and a value that does not parse refuses the delivery naming the variable
      // rather than quietly admitting every alert, or none.
      const read = sentryFilterFromEnv({
        SENTRY_MIN_LEVEL: process.env["SENTRY_MIN_LEVEL"],
        SENTRY_ENVIRONMENTS: process.env["SENTRY_ENVIRONMENTS"],
        SENTRY_RELEASES: process.env["SENTRY_RELEASES"],
      });
      if (!read.ok) {
        return { refused: read.message, code: "not-configured", status: 503 };
      }
      return sentryDelivery(
        payload,
        {
          resource: header(SENTRY_RESOURCE_HEADER),
          requestId: header(SENTRY_REQUEST_ID_HEADER),
        },
        rules,
        read.filter,
      );
    },
  })),
);

/**
 * The Jira Cloud adapter (`@repo/core/Jira`, LOB-189, served by LOB-259): an admin webhook
 * registered with a secret signs `sha256=<hex>` into `X-Hub-Signature`, checked with
 * `JIRA_WEBHOOK_SECRET`. The delivery's key is the one Jira's payload gives it
 * (`jira:<event>:<issue>:<timestamp>`), so a replayed body is one delivery. Only the comment back on
 * the issue needs `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` (`./TriggerAdapters`); without
 * them the route still opens sessions and writes nothing back.
 */
const jiraRoute = HttpRouter.add(
  "POST",
  "/webhooks/jira",
  handle(() => ({
    route: "/webhooks/jira",
    deliveryHeader: "x-atlassian-webhook-identifier",
    signatureHeader: JIRA_SIGNATURE_HEADER,
    secret: process.env["JIRA_WEBHOOK_SECRET"],
    secretVariable: "JIRA_WEBHOOK_SECRET",
    verify: (raw, signature, secret) =>
      verifyJiraSignature({ raw, signature, secret }),
    delivery: (payload) =>
      jiraDelivery(payload) ?? {
        refused: "the payload does not name a Jira issue",
        code: "bad-payload",
      },
  })),
);

/**
 * The Slack Events adapter (`@repo/core/Slack`, LOB-191, served by LOB-259): Slack's own timestamped
 * signature, checked with `SLACK_SIGNING_SECRET`, whose `url_verification` handshake is answered and
 * whose payloads that carry no event (`app_rate_limited`) are answered `200` and ignored, because
 * Slack retries and eventually disables a subscription whose URL answers anything else. The filter
 * is the environment's, read per request: the channels to watch (`SLACK_CHANNELS`) and an optional
 * phrase (`SLACK_TEXT`); a message outside them is recorded `skipped` with the reason. The reply in
 * the thread needs `SLACK_BOT_TOKEN` too (`./TriggerAdapters`).
 */
const slackRoute = HttpRouter.add(
  "POST",
  "/webhooks/slack",
  handle(() => ({
    route: "/webhooks/slack",
    deliveryHeader: "x-slack-request-timestamp",
    signatureHeader: "x-slack-signature",
    secret: process.env["SLACK_SIGNING_SECRET"],
    secretVariable: "SLACK_SIGNING_SECRET",
    verify: (raw, signature, signingSecret, request) =>
      verifySlackSignature({
        raw,
        signature,
        timestamp: request.header("x-slack-request-timestamp"),
        signingSecret,
        nowSeconds: request.nowSeconds,
      }),
    handshake: (payload) => {
      const verification = slackUrlVerification(payload);
      if (verification !== undefined) return verification;
      const type = payload["type"];
      return type === "event_callback"
        ? undefined
        : {
            ok: true,
            ignored: `a "${typeof type === "string" ? type : ""}" payload carries no event`,
          };
    },
    delivery: (payload) => {
      const filter = slackFilterFromEnv(slackEnv());
      return (
        slackDelivery(payload, filter) ?? {
          refused: "the payload carries no Slack event",
          code: "bad-payload",
        }
      );
    },
  })),
);

/**
 * Every route, still asking for the seam and the rate cap per request. Exported so a test can serve
 * them with a fake `TriggerService` — the route-level refusals (`503`, `413`, `401`, `400`, `429`) are answered before the
 * seam is called, and a case that proves one must not need Postgres and a session layer to do it.
 * The rules a route normalizes against are the seam's own (`TriggerService.rules`), so a case that
 * needs the generic adapter to read some serves a fake seam that answers them.
 */
export const WebhookRoutes = Layer.mergeAll(
  linearRoute,
  genericRoute,
  sentryRoute,
  jiraRoute,
  slackRoute,
);

/**
 * The routes' rate caps, counted in this process's memory. Provided once beside the seam
 * (`provideRequest` builds a layer once and hands its services to every request), so every request
 * counts against the same window; a test serves its own, so its counts start at zero.
 */
export const WebhookRateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory),
);

/**
 * The routes over the production seam. `rules` is `TRIGGER_RULES`, decoded and logged at boot
 * (`readTriggerRules`); it is the *fallback* — the seam reads the stored routes (`trigger_routes`)
 * per delivery and consults them first (LOB-266). Every route shares one `TriggerService` instance:
 * the rules and the session port are per-process configuration, and two instances would be two
 * copies of the same config waiting to drift.
 */
const seamFor = (rules: ReadonlyArray<TriggerRule>) =>
  TriggerServiceLive({
    rules,
    storedRoutes: true,
    rulesOrigin: ENV_RULES_ORIGIN,
  }).pipe(
    // Each source's write-back when its credentials are configured (`./TriggerAdapters`): Linear's
    // started move (LOB-15), Jira's and GitHub's comments, Slack's reply. Only the source a delivery
    // came from is written back to. A card rule (LOB-254) files its card through `TaskService`, the
    // one writer of cards.
    Layer.provide(
      Layer.mergeAll(
        TriggerSessionsFromSessionService,
        TriggerCardsFromTaskService.pipe(Layer.provide(TaskServiceLive)),
        TriggerWriteBacksLive,
        // The trust gate's GitHub role lookup (S-trigger-trust-gating), for a rule that asks.
        TriggerAuthorPermissionsLive,
      ),
    ),
  );

export const webhookLiveFor = (rules: ReadonlyArray<TriggerRule>) =>
  WebhookRoutes.pipe(
    HttpRouter.provideRequest(
      Layer.mergeAll(seamFor(rules), WebhookRateLimiterLive),
    ),
  );

/**
 * The seam for a request that is not one of `WebhookRoutes` (the GitHub issue route, whose
 * `POST /webhooks/github` is built in `./GitHubWebhook`). It reads `TRIGGER_RULES` from the
 * environment the same way boot does, so both see one set of fallback rules.
 */
export const TriggerSeamLive = Layer.unwrap(
  readTriggerRules(process.env).pipe(
    Effect.orElseSucceed((): ReadonlyArray<TriggerRule> => []),
    Effect.map(seamFor),
  ),
);
