/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/* oxlint-disable effecttsgo/prefer-schema-over-json */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { createHmac, timingSafeEqual } from "node:crypto";

const verifySignature = (
  raw: string,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (secret === "") return true;
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

export const WebhookLive = HttpRouter.add(
  "POST",
  "/webhooks/linear",
  Effect.gen(function* () {
    const secret = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* req.text;
    const signature = req.headers["linear-signature"];
    if (!verifySignature(raw, signature, secret)) {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({ error: "bad signature" }),
        401,
      );
    }

    // oxlint-disable-next-line effecttsgo(prefer-schema-over-json)
    const payload = yield* Effect.sync((): unknown => {
      try {
        // oxlint-disable-next-line effecttsgo(prefer-schema-over-json)
        return JSON.parse(raw);
      } catch {
        return null;
      }
    });

    if (payload === null) {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({ error: "bad json" }),
        400,
      );
    }

    const p = payload as Record<string, unknown>;
    const requestId =
      (req.headers["linear-delivery"] as string | undefined) ??
      (p["webhookId"] as string | undefined) ??
      (p["id"] as string | undefined);
    if (!requestId) {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe({ error: "missing requestId" }),
        400,
      );
    }

    const sql = yield* SqlClient;

    const existing = yield* sql<{ request_id: string }>`
      SELECT request_id FROM webhook_deliveries WHERE request_id = ${requestId}
    `;
    if (existing.length > 0) {
      return HttpServerResponse.jsonUnsafe({ ok: true, replayed: true });
    }

    yield* sql`
      INSERT INTO webhook_deliveries (request_id, status) VALUES (${requestId}, 'received')
    `;

    const data = p["data"] as Record<string, unknown> | undefined;
    const issue = (data?.["issue"] ?? p["issue"]) as unknown;
    const hasMapping = false;
    if (!hasMapping) {
      const reason = issue
        ? "no repo mapping for issue labels"
        : "unmappable payload";
      yield* sql`
        UPDATE webhook_deliveries SET status = 'skipped', skip_reason = ${reason}
        WHERE request_id = ${requestId}
      `;
      return HttpServerResponse.jsonUnsafe({ ok: true, skipped: true, reason });
    }

    yield* sql`
      UPDATE webhook_deliveries SET status = 'processed' WHERE request_id = ${requestId}
    `;
    return HttpServerResponse.jsonUnsafe({ ok: true, processed: true });
  }),
);
