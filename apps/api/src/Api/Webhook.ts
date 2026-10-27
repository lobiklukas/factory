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
 * 3. **Parse and normalize.** A body that is not JSON, or that has no request id, is `400`.
 * 4. **Delegate.** Everything about replays, refusals, mapping and sessions is
 *    `@repo/core`'s `TriggerService`, so an adapter cannot invent its own idempotency.
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
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "@repo/core";
import type { TriggerEvent, TriggerRule } from "@repo/domain/Trigger";
import { TriggerRules } from "@repo/domain/Trigger";
import { createHmac, timingSafeEqual } from "node:crypto";

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

/** Linear's `labels` are objects (`{name}`); a payload with bare strings is accepted too. */
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
 * Linear's issue payload, normalized. `key` is the issue id — what a write-back would address —
 * so a delivery about the same issue always names the same thing.
 *
 * Linear's `data` is the issue itself for a `type: "Issue"` webhook; a payload that wraps it as
 * `data.issue` (what a self-hosted relay tends to emit) reads the same way, because both spell the
 * same three fields.
 */
const linearEvent = (
  payload: Record<string, unknown>,
): TriggerEvent | undefined => {
  const data = asRecord(payload["data"]) ?? payload;
  const nested = asRecord(data["issue"]);
  const issue =
    nested ??
    (stringField(data, "id") === undefined &&
    stringField(data, "identifier") === undefined
      ? asRecord(payload["issue"])
      : data);
  if (issue === undefined) return undefined;
  const key = stringField(issue, "id") ?? stringField(issue, "identifier");
  if (key === undefined) return undefined;
  return {
    source: "linear",
    key,
    action: stringField(payload, "action") ?? "create",
    title: stringField(issue, "title") ?? "",
    body: stringField(issue, "description") ?? "",
    labels: labelNames(issue["labels"]),
  };
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

/** One adapter: how its body is authenticated, scoped and normalized. */
type Adapter = {
  /** The header the signature arrives in, in whatever case `config` named it. */
  readonly signatureHeader: string;
  /** The signature's secret, or `undefined` when this deployment configured none. */
  readonly secret: string | undefined;
  /** Where a sender may put the delivery id in the body, after the header. */
  readonly deliveryHeader: string;
  readonly normalize: (
    payload: Record<string, unknown>,
  ) => TriggerEvent | undefined;
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

    const requestId =
      (req.headers[config.deliveryHeader.toLowerCase()] as
        | string
        | undefined) ??
      stringField(body, "requestId") ??
      stringField(body, "webhookId") ??
      stringField(body, "id");
    if (requestId === undefined) {
      return badRequest("missing requestId", "missing-request-id");
    }

    const event = config.normalize(body);
    if (event === undefined) {
      return badRequest(
        "the payload does not name an issue or a label",
        "bad-payload",
      );
    }

    const outcome = yield* triggers.deliver({ requestId, event }).pipe(
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

const LinearRoute = HttpRouter.add(
  "POST",
  "/webhooks/linear",
  handle(() => ({
    signatureHeader: "linear-signature",
    secret: process.env["LINEAR_WEBHOOK_SECRET"],
    secretVariable: "LINEAR_WEBHOOK_SECRET",
    deliveryHeader: "linear-delivery",
    normalize: linearEvent,
  })),
);

const GenericRoute = HttpRouter.add(
  "POST",
  "/webhooks/generic",
  handle(() => ({
    signatureHeader:
      process.env["TRIGGER_SECRET_HEADER"] ?? DEFAULT_SECRET_HEADER,
    secret: process.env["TRIGGER_SECRET"],
    secretVariable: "TRIGGER_SECRET",
    deliveryHeader:
      process.env["TRIGGER_DELIVERY_HEADER"] ?? DEFAULT_DELIVERY_HEADER,
    normalize: genericEvent,
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
const WebhookRoutes = Layer.mergeAll(LinearRoute, GenericRoute);

export const WebhookLive = WebhookRoutes.pipe(
  HttpRouter.provideRequest(
    TriggerServiceLive({ rules: rulesFromEnv() }).pipe(
      Layer.provide(
        Layer.mergeAll(TriggerSessionsFromSessionService, NoWriteBack),
      ),
    ),
  ),
);
