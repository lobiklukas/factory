/* oxlint-disable effecttsgo/process-env */
/**
 * The trigger routes' own refusals, served in-process (LOB-216).
 *
 * `POST /webhooks/linear` and `POST /webhooks/generic` answer `503 not-configured` when their secret
 * is unset, before anything is verified or written down (`Webhook.ts`'s `handle`). The
 * `verify-api` drive cannot reach that branch — it boots one API with both secrets set — so these
 * cases serve the app's own `WebhookRoutes` through `HttpRouter.toWebHandler` with each secret
 * unset in turn.
 *
 * The seam is a recording fake: the question is whether a route lets a delivery through, and a
 * refusal that reached `TriggerService.deliver` would be one the ledger shows. Each refused body is
 * signed with the *empty* key, which is what an unset secret degrades to (`config.secret ?? ""`):
 * without the `503` branch that signature verifies, the delivery reaches the seam, and the route
 * answers `200`. So removing the branch turns these red, rather than leaving a `401` to pass for it.
 * The control case signs with a configured secret and proves the same harness does reach the seam.
 *
 * The routes read their secrets per request, so each case sets the environment it needs and the
 * `afterEach` puts the process's own values back.
 */
import { createHmac } from "node:crypto";
import { TriggerService } from "@repo/core";
import type { TriggerDelivery } from "@repo/domain/Trigger";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookRoutes } from "./Webhook";

const SECRETS = ["TRIGGER_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;
const saved = new Map(SECRETS.map((name) => [name, process.env[name]]));

/** Every delivery a route handed the seam, in order. */
const delivered: Array<TriggerDelivery> = [];

const { handler, dispose } = HttpRouter.toWebHandler(
  WebhookRoutes.pipe(
    HttpRouter.provideRequest(
      Layer.succeed(
        TriggerService,
        TriggerService.of({
          deliver: (delivery) =>
            Effect.sync(() => {
              delivered.push(delivery);
              return { status: "skipped", replayed: false, reason: "fake" };
            }),
        }),
      ),
    ),
  ),
  { disableLogger: true },
);

const sign = (body: string, secret: string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const post = async (
  path: "/webhooks/generic" | "/webhooks/linear",
  payload: unknown,
  secret: string,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const body = JSON.stringify(payload);
  const response = await handler(
    new Request(`http://factory.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [path === "/webhooks/linear"
          ? "linear-signature"
          : "x-trigger-signature"]: sign(body, secret),
      },
      body,
    }),
  );
  return { status: response.status, body: await response.json() };
};

const generic = { requestId: "lob-216-generic", label: "factory" };
const linear = {
  type: "Issue",
  action: "create",
  data: { id: "lob-216-issue", title: "Fix it", labels: [] },
};

/** Set each named secret, and unset the rest — `undefined` is the unset a deployment ships. */
const configure = (
  secrets: Partial<Record<(typeof SECRETS)[number], string>>,
): void => {
  for (const name of SECRETS) {
    const value = secrets[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeEach(() => {
  delivered.length = 0;
  // The signature header the generic body is signed into is the default one.
  delete process.env["TRIGGER_SECRET_HEADER"];
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(async () => {
  await dispose();
});

describe("a trigger route with no secret", () => {
  it("refuses a generic delivery with 503, naming TRIGGER_SECRET, and hands the seam nothing", async () => {
    configure({ LINEAR_WEBHOOK_SECRET: "linear-secret" });
    const answer = await post("/webhooks/generic", generic, "");

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ ok: false, code: "not-configured" });
    expect(JSON.stringify(answer.body)).toContain("TRIGGER_SECRET");
    expect(delivered).toHaveLength(0);
  });

  it("refuses a Linear delivery with 503, naming LINEAR_WEBHOOK_SECRET, and hands the seam nothing", async () => {
    configure({ TRIGGER_SECRET: "generic-secret" });
    const answer = await post("/webhooks/linear", linear, "");

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ ok: false, code: "not-configured" });
    expect(JSON.stringify(answer.body)).toContain("LINEAR_WEBHOOK_SECRET");
    expect(delivered).toHaveLength(0);
  });

  it("treats a secret set to the empty string as unset", async () => {
    configure({ TRIGGER_SECRET: "", LINEAR_WEBHOOK_SECRET: "" });

    expect((await post("/webhooks/generic", generic, "")).status).toBe(503);
    expect((await post("/webhooks/linear", linear, "")).status).toBe(503);
    expect(delivered).toHaveLength(0);
  });

  it("is the only route refused: with its secret set, the same harness reaches the seam", async () => {
    // The control: without it, a harness that never reached the handler would pass the cases above.
    configure({
      TRIGGER_SECRET: "generic-secret",
      LINEAR_WEBHOOK_SECRET: "linear-secret",
    });

    const viaGeneric = await post(
      "/webhooks/generic",
      generic,
      "generic-secret",
    );
    const viaLinear = await post("/webhooks/linear", linear, "linear-secret");

    expect(viaGeneric.status).toBe(200);
    expect(viaLinear.status).toBe(200);
    expect(delivered.map((delivery) => delivery.event.source)).toEqual([
      "generic",
      "linear",
    ]);
  });
});
