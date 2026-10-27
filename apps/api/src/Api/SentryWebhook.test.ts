/* oxlint-disable effecttsgo/process-env */
/**
 * `POST /webhooks/sentry`'s own refusals, served in-process (LOB-81).
 *
 * Three claims only the route can make, each answered before the seam is called:
 *
 * - **A bad or missing signature is `401`, hands the seam nothing, and is logged without the
 *   payload.** The log is captured with a recording logger provided beside the seam, and each body
 *   carries a canary string, so a refusal that logged its body — or a route that logged nothing —
 *   turns a case red.
 * - **The rate cap refuses a burst with a typed `429`**, `Retry-After` and the cap it hit, never a
 *   `500`, and the deliveries inside the cap still reach the seam.
 * - **The cap counts signed deliveries only**, so a caller without the secret cannot spend the
 *   budget an honest alert needs.
 *
 * The seam is a recording fake, as in `Webhook.test.ts`: the question is whether the route let a
 * delivery through. Each case serves the routes afresh, so its rate-cap window starts empty.
 * `packages/core/src/Sentry.test.ts` is where the seam's dedupe runs against Postgres.
 */
import { createHmac } from "node:crypto";
import { sentrySignature, TriggerService } from "@repo/core";
import type { TriggerDelivery, TriggerOutcome } from "@repo/domain/Trigger";
import { Effect, Layer, Logger } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookRateLimiterLive, webhookRoutesFor } from "./Webhook";

const VARIABLES = [
  "SENTRY_CLIENT_SECRET",
  "SENTRY_RATE_LIMIT",
  "SENTRY_RATE_WINDOW_SECONDS",
  "TRIGGER_SECRET",
] as const;
const saved = new Map(VARIABLES.map((name) => [name, process.env[name]]));

const SECRET = "lob-81-client-secret";

/** A string no log line may contain: it is only ever in a payload. */
const CANARY = "lob81-payload-canary-do-not-log";

/** Every delivery the route handed the seam, in order. */
const delivered: Array<TriggerDelivery> = [];

/** Every log line the routes wrote while a case ran. */
const logged: Array<string> = [];

const PROCESSED: TriggerOutcome = {
  status: "processed",
  replayed: false,
  reason: "fake",
};

const recordingLogger = Logger.make(({ message }) => {
  logged.push(
    (Array.isArray(message) ? message : [message]).map(String).join(" "),
  );
});

/** The routes over the recording seam, a fresh rate-cap window and the recording logger. */
const serve = () =>
  HttpRouter.toWebHandler(
    webhookRoutesFor([]).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.succeed(
            TriggerService,
            TriggerService.of({
              deliver: (delivery) =>
                Effect.sync(() => {
                  delivered.push(delivery);
                  return PROCESSED;
                }),
            }),
          ),
          WebhookRateLimiterLive,
          Logger.layer([recordingLogger]),
        ),
      ),
    ),
    { disableLogger: true },
  );

/** An issue alert as Sentry's documented example shapes one, for one event. */
const alert = (eventId: string) => ({
  action: "triggered",
  installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
  data: {
    event: {
      event_id: eventId,
      issue_id: "1117540176",
      title: `ReferenceError: ${CANARY}`,
      level: "error",
      culprit: `?(${CANARY})`,
      project: 1,
      web_url: "https://sentry.example/organizations/acme/issues/1117540176/",
    },
    triggered_rule: "Very Important Alert!",
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
});

type Served = ReturnType<typeof serve>;

const post = async (
  served: Served,
  payload: unknown,
  options: {
    /** The signature header; `null` sends none. Defaults to the body signed with `SECRET`. */
    readonly signature?: string | null;
    readonly requestId?: string;
  } = {},
) => {
  const body = JSON.stringify(payload);
  const signature =
    options.signature === undefined
      ? sentrySignature(body, SECRET)
      : options.signature;
  const response = await served.handler(
    new Request("http://factory.test/webhooks/sentry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sentry-hook-resource": "event_alert",
        "request-id": options.requestId ?? "req-lob-81",
        ...(signature === null ? {} : { "sentry-hook-signature": signature }),
      },
      body,
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    retryAfter: response.headers.get("retry-after"),
  };
};

const configure = (
  values: Partial<Record<(typeof VARIABLES)[number], string>>,
): void => {
  for (const name of VARIABLES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

let served: Served;

beforeEach(() => {
  delivered.length = 0;
  logged.length = 0;
  configure({ SENTRY_CLIENT_SECRET: SECRET });
  served = serve();
});

afterEach(async () => {
  await served.dispose();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("a Sentry delivery's signature", () => {
  it("is what admits a delivery: a correctly signed alert reaches the seam, keyed by its event", async () => {
    // The control for every refusal below: the same harness, signed, does reach the seam.
    const answer = await post(
      served,
      alert("e4874d664c3540c1a32eab185f12c5ab"),
    );

    expect(answer.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      requestId: "sentry:event:e4874d664c3540c1a32eab185f12c5ab",
      keyedByWork: true,
      event: { source: "sentry", action: "create" },
    });
  });

  it("refuses a missing signature with 401, hands the seam nothing, and logs the refusal without the payload", async () => {
    const answer = await post(served, alert("missing-sig-event"), {
      signature: null,
      requestId: "req-missing-sig",
    });

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({
      ok: false,
      code: "missing-signature",
    });
    expect(delivered).toHaveLength(0);
    const refusal = logged.filter((line) => line.includes("refused"));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("/webhooks/sentry");
    expect(refusal[0]).toContain("missing-signature");
    expect(refusal[0]).toContain("req-missing-sig");
    expect(logged.join("\n")).not.toContain(CANARY);
  });

  it("refuses a wrong signature with 401, hands the seam nothing, and logs the refusal without the payload", async () => {
    const payload = alert("bad-sig-event");
    const answer = await post(served, payload, {
      // A real signature, of another body: the shape is right and the bytes are not.
      signature: sentrySignature(`${JSON.stringify(payload)} `, SECRET),
      requestId: "req-bad-sig",
    });

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ ok: false, code: "bad-signature" });
    expect(delivered).toHaveLength(0);
    const refusal = logged.filter((line) => line.includes("refused"));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("bad-signature");
    expect(refusal[0]).toContain("req-bad-sig");
    expect(logged.join("\n")).not.toContain(CANARY);
  });

  it("refuses a body signed with another secret", async () => {
    const payload = alert("other-secret-event");
    const answer = await post(served, payload, {
      signature: sentrySignature(JSON.stringify(payload), "someone-else"),
    });

    expect(answer.status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  it("refuses every delivery with 503 while no client secret is configured", async () => {
    configure({});
    const answer = await post(served, alert("unconfigured-event"), {
      // Signed with the empty key, which is what an unset secret degrades to.
      signature: sentrySignature(
        JSON.stringify(alert("unconfigured-event")),
        "",
      ),
    });

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: "not-configured" });
    expect(JSON.stringify(answer.body)).toContain("SENTRY_CLIENT_SECRET");
    expect(delivered).toHaveLength(0);
  });

  it("answers an alert with no event id 400, before the seam", async () => {
    const answer = await post(served, {
      action: "triggered",
      data: { event: { title: "no id" } },
    });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "bad-payload" });
    expect(delivered).toHaveLength(0);
  });
});

describe("the Sentry rate cap", () => {
  it("refuses the burst past the cap with a typed 429 and Retry-After, and admits the deliveries inside it", async () => {
    configure({
      SENTRY_CLIENT_SECRET: SECRET,
      SENTRY_RATE_LIMIT: "3",
      SENTRY_RATE_WINDOW_SECONDS: "60",
    });
    const answers = [];
    for (let n = 1; n <= 5; n += 1) {
      answers.push(await post(served, alert(`burst-${n}`)));
    }

    expect(answers.map((answer) => answer.status)).toEqual([
      200, 200, 200, 429, 429,
    ]);
    expect(delivered.map((delivery) => delivery.event.key)).toEqual([
      "burst-1",
      "burst-2",
      "burst-3",
    ]);
    const refused = answers[3];
    expect(refused?.body).toMatchObject({
      ok: false,
      code: "rate-limited",
      limit: 3,
      windowSeconds: 60,
    });
    const retryAfter = Number(refused?.retryAfter);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused?.body["retryAfterSeconds"]).toBe(retryAfter);
    expect(
      logged.filter((line) => line.includes("refused rate-limited")),
    ).toHaveLength(2);
    expect(logged.join("\n")).not.toContain(CANARY);
  });

  it("counts signed deliveries only: unsigned ones spend none of the budget", async () => {
    configure({
      SENTRY_CLIENT_SECRET: SECRET,
      SENTRY_RATE_LIMIT: "2",
    });
    for (let n = 1; n <= 4; n += 1) {
      expect(
        (await post(served, alert(`unsigned-${n}`), { signature: "00" }))
          .status,
      ).toBe(401);
    }
    const first = await post(served, alert("signed-1"));
    const second = await post(served, alert("signed-2"));

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(delivered).toHaveLength(2);
  });

  it("caps only the Sentry route: an exhausted Sentry window leaves the generic route uncapped", async () => {
    configure({
      SENTRY_CLIENT_SECRET: SECRET,
      SENTRY_RATE_LIMIT: "1",
      TRIGGER_SECRET: "generic-secret",
    });
    expect((await post(served, alert("only-one"))).status).toBe(200);
    expect((await post(served, alert("one-too-many"))).status).toBe(429);

    const generic = JSON.stringify({ requestId: "lob-81-generic", label: "x" });
    const viaGeneric = await served.handler(
      new Request("http://factory.test/webhooks/generic", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trigger-signature": createHmac("sha256", "generic-secret")
            .update(generic)
            .digest("hex"),
        },
        body: generic,
      }),
    );
    expect(viaGeneric.status).toBe(200);
    expect(delivered.map((delivery) => delivery.event.source)).toEqual([
      "sentry",
      "generic",
    ]);
  });
});
