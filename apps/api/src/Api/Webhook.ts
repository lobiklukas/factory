/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/* oxlint-disable effecttsgo/prefer-schema-over-json */
/**
 * Inbound trigger routes (LOB-188): two adapters over one seam.
 *
 * `POST /webhooks/linear` is the Linear adapter — Linear's own HMAC header and payload — and
 * `POST /webhooks/generic` is the plain inbound webhook: any sender that can sign a body and name
 * a label. Both do the same four things before the seam sees a delivery, in this order because each
 * one is cheaper than the next and refuses more:
 *
 * 1. **Refuse an oversized body** before it is parsed or written down. The server-wide cap (1 MiB,
 *    LOB-21) is what protects the process; this one (`TRIGGER_MAX_BODY_BYTES`, 64 KiB by default) is
 *    what protects the delivery store and the session queue, and answering it here is what keeps a
 *    huge body from creating a `webhook_deliveries` row.
 * 2. **Verify the signature.** A wrong or missing one is `401` and writes nothing.
 * 3. **Parse and normalize.** A body that is not a JSON object is `400`, and so is one the adapter
 *    cannot address: a generic body with no request id or no label, or a Linear issue body with no
 *    issue id (any other Linear entity is answered and skipped, id or not). The adapter names the
 *    delivery's idempotency key here and nothing else about it: the generic sender supplies its
 *    own, and the Linear adapter derives one from the issue (LOB-164), because which deliveries
 *    are the same work is a fact about the sender.
 * 4. **Delegate.** Everything about replays, refusals, mapping and sessions is
 *    `@repo/core`'s `TriggerService`, so an adapter cannot invent its own claim or skip.
 *
 * The signature scheme is shared (`hmac-sha256` over the raw body, hex, in a configurable header)
 * because that is what Linear already does; an adapter whose provider signs differently brings its
 * own check, which is what Slack's timestamped signature does in `@repo/core/Slack` (LOB-191).
 *
 * **A route with no secret refuses every delivery.** An unset secret used to mean "accept", which
 * was harmless while `/webhooks/linear` recorded everything as `skipped`; now that a delivery can
 * start a session, accepting unsigned ones would let anyone who can reach the port open an agent.
 * So the secret is configuration, not a default: `503` names the missing variable, and a
 * deployment that wants the route sets it.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  linearDeliveryFor,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "@repo/core";
import type {
  TriggerDelivery,
  TriggerEvent,
  TriggerRule,
} from "@repo/domain/Trigger";
import { TriggerRules } from "@repo/domain/Trigger";
import { createHmac, timingSafeEqual } from "node:crypto";
import { TriggerWriteBackLive } from "./LinearSync";

/** The default cap on a trigger delivery, in bytes. */
const DEFAULT_MAX_BODY_BYTES = 65_536;

/** The header a generic sender signs into, when the deployment names none. */
const DEFAULT_SECRET_HEADER = "x-trigger-signature";

/** Where a generic sender puts the delivery's idempotency key, when it is not in the body. */
const DEFAULT_DELIVERY_HEADER = "x-trigger-delivery";

const verifySignature = (
  raw: string,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
};

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
 * The generic payload: `{requestId?, action?, label?, labels?, title?, body?}`. `label` is the one
 * field a sender must supply — it is what a mapping rule matches — and the rest is carried into
 * the prompt.
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
  return {
    source: "generic",
    key: key ?? title,
    action: stringField(payload, "action") ?? "create",
    title,
    body: stringField(payload, "body") ?? "",
    labels,
  };
};

/** A body the adapter cannot turn into a delivery: the `400` it answers, and its code. */
type Refusal = { readonly refused: string; readonly code: string };

/** How an adapter reads a request header: by name, in any case. */
type HeaderLookup = (name: string) => string | undefined;

/**
 * The generic adapter's delivery: the id is the configured header, else the body's own
 * `requestId` — the sender names its delivery, because nothing else can.
 */
const genericDelivery =
  (deliveryHeader: string) =>
  (
    payload: Record<string, unknown>,
    header: HeaderLookup,
  ): TriggerDelivery | Refusal => {
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
    return { requestId, event };
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
  ) => TriggerDelivery | Refusal;
  /** The variable the missing-secret refusal names, so an operator knows what to set. */
  readonly secretVariable: string;
};

const handle = (adapter: () => Adapter) =>
  Effect.gen(function* () {
    const config = adapter();
    const triggers = yield* TriggerService;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* req.text;

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
    const size = Buffer.byteLength(raw, "utf8");
    if (size > limit) {
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
    if (
      !verifySignature(
        raw,
        req.headers[signatureHeader] as string | undefined,
        secret,
      )
    ) {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({ ok: false, error: "bad signature" }),
        401,
      );
    }

    // oxlint-disable-next-line effecttsgo(prefer-schema-over-json)
    const payload = yield* parseJson(raw);
    const body = asRecord(payload);
    if (body === undefined) {
      return badRequest("the body is not a JSON object", "bad-json");
    }

    const header: HeaderLookup = (name) =>
      req.headers[name.toLowerCase()] as string | undefined;
    const delivery = config.delivery(body, header);
    if ("refused" in delivery) {
      return badRequest(delivery.refused, delivery.code);
    }

    const outcome = yield* triggers.deliver(delivery).pipe(
      Effect.map((delivered) => ({ ok: true as const, delivered })),
      // A refusal is an answer (`skipped`), so only a real failure reaches here: answer `500` so
      // the sender retries, rather than `200` on work that never got recorded.
      Effect.catchTag("TriggerError", (cause) =>
        Effect.succeed({ ok: false as const, cause }),
      ),
    );
    if (!outcome.ok) {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({
          ok: false,
          error: outcome.cause.message,
          code: outcome.cause.code,
        }),
        500,
      );
    }
    const delivered = outcome.delivered;
    return HttpServerResponse.jsonUnsafe({
      ok: true,
      status: delivered.status,
      replayed: delivered.replayed,
      ...(delivered.sessionId === undefined
        ? {}
        : { sessionId: delivered.sessionId }),
      ...(delivered.reason === undefined ? {} : { reason: delivered.reason }),
    });
  });

/**
 * The Linear adapter (`@repo/core/Linear`, LOB-164). It derives its own delivery: the key is the
 * issue for a delivery that can start work, so a retry Linear sends with a fresh header and a fresh
 * `webhookTimestamp` cannot open a second session. `rules` is the value `TriggerServiceLive` maps
 * with, so the key and the mapping cannot disagree about which payloads a rule claims.
 */
const linearRoute = (rules: ReadonlyArray<TriggerRule>) => {
  const deliver = linearDeliveryFor(rules);
  return HttpRouter.add(
    "POST",
    "/webhooks/linear",
    handle(() => ({
      signatureHeader: "linear-signature",
      secret: process.env["LINEAR_WEBHOOK_SECRET"],
      secretVariable: "LINEAR_WEBHOOK_SECRET",
      delivery: (payload, header) =>
        deliver(payload, { delivery: header("linear-delivery") }) ?? {
          refused: "the payload does not name a Linear issue",
          code: "bad-payload",
        },
    })),
  );
};

const GenericRoute = HttpRouter.add(
  "POST",
  "/webhooks/generic",
  handle(() => ({
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
 * The mapping rules a deployment ships: `TRIGGER_RULES` is a JSON array of `{label, repo,
 * baseRef?, prompt}`. An invalid value is empty rather than fatal — a malformed mapping means
 * "nothing is mapped yet", which answers every delivery `skipped` and names why, instead of
 * refusing to boot the API over a typo.
 */
const rulesFromEnv = (): ReadonlyArray<TriggerRule> => {
  const raw = process.env["TRIGGER_RULES"];
  if (raw === undefined || raw.trim() === "") return [];
  try {
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
    return Schema.decodeUnknownSync(TriggerRules)(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
};

/**
 * Both routes share one `TriggerService` instance: the rules and the session port are per-process
 * configuration, and two instances would be two copies of the same config waiting to drift.
 */
const rules = rulesFromEnv();

/**
 * Both routes, still asking for the seam per request. Exported so a test can serve them with a fake
 * `TriggerService` — the route-level refusals (`503`, `413`, `401`, `400`) are answered before the
 * seam is called, and a case that proves one must not need Postgres and a session layer to do it.
 */
export const WebhookRoutes = Layer.mergeAll(linearRoute(rules), GenericRoute);

export const WebhookLive = WebhookRoutes.pipe(
  HttpRouter.provideRequest(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        // Linear's write-back when a key is configured (LOB-15): a delegated issue moves to its
        // started state when its session opens. Otherwise none.
        Layer.mergeAll(TriggerSessionsFromSessionService, TriggerWriteBackLive),
      ),
    ),
  ),
);
