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
 * - **The cap counts signed deliveries that can start work only**, so a caller without the secret
 *   cannot spend the budget an honest alert needs, and neither can a firehose of `issue` deliveries
 *   the seam would only skip — unless a rule opts that action in, when it is work and counts.
 * - **The filter is read from the environment per delivery (LOB-82)**: an alert outside it reaches
 *   the seam marked `filtered` with the field that failed, keyed by its `Request-ID` and spending no
 *   token; a `SENTRY_MIN_LEVEL` that is not a level is `503 not-configured`, before the seam.
 *
 * The seam is a recording fake, as in `Webhook.test.ts`: the question is whether the route let a
 * delivery through. Each case serves the routes afresh, so its rate-cap window starts empty.
 * `packages/core/src/Sentry.test.ts` is where the seam's dedupe runs against Postgres.
 */
import { createHmac } from "node:crypto";
import { sentrySignature, TriggerService } from "@repo/core";
import type { RepoSlug } from "@repo/domain/Session";
import type {
  TriggerDelivery,
  TriggerOutcome,
  TriggerRule,
} from "@repo/domain/Trigger";
import { Effect, Layer, Logger } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookRateLimiterLive, WebhookRoutes } from "./Webhook";

const VARIABLES = [
  "SENTRY_CLIENT_SECRET",
  "SENTRY_RATE_LIMIT",
  "SENTRY_RATE_WINDOW_SECONDS",
  "SENTRY_MIN_LEVEL",
  "SENTRY_ENVIRONMENTS",
  "SENTRY_RELEASES",
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
const serve = (rules: ReadonlyArray<TriggerRule> = []) =>
  HttpRouter.toWebHandler(
    WebhookRoutes.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.succeed(
            TriggerService,
            TriggerService.of({
              rules: Effect.succeed(rules),
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
const alert = (eventId: string, over: Record<string, unknown> = {}) => ({
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
      ...over,
    },
    triggered_rule: "Very Important Alert!",
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
});

/** A new-issue delivery (`Sentry-Hook-Resource: issue`), which starts nothing unless a rule opts in. */
const newIssue = (issueId: string) => ({
  action: "created",
  data: {
    issue: {
      id: issueId,
      title: `Error: ${CANARY}`,
      project: { id: "1", slug: "web" },
    },
  },
});

type Served = ReturnType<typeof serve>;

const post = async (
  served: Served,
  payload: unknown,
  options: {
    /** The signature header; `null` sends none. Defaults to the body signed with `SECRET`. */
    readonly signature?: string | null;
    readonly requestId?: string;
    /** `Sentry-Hook-Resource`; defaults to an issue alert's. */
    readonly resource?: string;
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
        "sentry-hook-resource": options.resource ?? "event_alert",
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

  it("spends nothing on a delivery that cannot start work: an issue firehose leaves the alerts their budget", async () => {
    configure({
      SENTRY_CLIENT_SECRET: SECRET,
      SENTRY_RATE_LIMIT: "2",
    });
    for (let n = 1; n <= 5; n += 1) {
      const answer = await post(served, newIssue(`firehose-${n}`), {
        resource: "issue",
        requestId: `req-firehose-${n}`,
      });
      expect(answer.status).toBe(200);
    }
    // A signed body the adapter cannot address is a 400 and spends nothing either.
    expect(
      (
        await post(served, {
          action: "triggered",
          data: { event: { title: CANARY } },
        })
      ).status,
    ).toBe(400);

    const alerts = [];
    for (let n = 1; n <= 3; n += 1) {
      alerts.push((await post(served, alert(`after-firehose-${n}`))).status);
    }
    expect(alerts).toEqual([200, 200, 429]);
    // Every issue delivery still reached the seam, which records each as its skip.
    expect(delivered.map((delivery) => delivery.event.action)).toEqual([
      ...Array.from({ length: 5 }, () => "issue:created"),
      "create",
      "create",
    ]);
  });

  it("counts an action a rule opts in: it is work, so it spends the budget an alert would", async () => {
    await served.dispose();
    configure({
      SENTRY_CLIENT_SECRET: SECRET,
      SENTRY_RATE_LIMIT: "1",
    });
    served = serve([
      {
        label: "sentry",
        repo: "acme/web" as RepoSlug,
        prompt: "{{title}}",
        startsWorkFor: ["issue:created"],
      },
    ]);
    const optedIn = await post(served, newIssue("opted-in"), {
      resource: "issue",
      requestId: "req-opted-in",
    });
    expect(optedIn.status).toBe(200);
    expect(delivered[0]).toMatchObject({
      requestId: "sentry:work:issue:opted-in:issue:created",
      keyedByWork: true,
    });
    expect((await post(served, alert("after-opt-in"))).status).toBe(429);
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

describe("the Sentry filter and title on the route (LOB-82)", () => {
  it("hands the seam an alert titled with its environment and release, bound to its issue", async () => {
    const answer = await post(
      served,
      alert("titled-event", {
        environment: "production",
        release: "web@1.2.3",
      }),
    );

    expect(answer.status).toBe(200);
    expect(delivered[0]?.event).toMatchObject({
      title: `ReferenceError: ${CANARY} (production, release web@1.2.3)`,
      fingerprint: "1117540176",
    });
    expect(delivered[0]?.event.filtered).toBeUndefined();
  });

  it("marks an alert outside the environment's filter, keys it by its Request-ID, and spends no token on it", async () => {
    configure({
      SENTRY_CLIENT_SECRET: SECRET,
      SENTRY_RATE_LIMIT: "1",
      SENTRY_MIN_LEVEL: "error",
      SENTRY_ENVIRONMENTS: "production",
      SENTRY_RELEASES: "web@2.*",
    });
    const refusals = [
      {
        over: {
          level: "warning",
          environment: "production",
          release: "web@2.1",
        },
        filtered: 'level "warning" is below SENTRY_MIN_LEVEL "error"',
      },
      {
        over: { environment: "staging", release: "web@2.1" },
        filtered:
          'environment "staging" is not in SENTRY_ENVIRONMENTS [production]',
      },
      {
        over: { environment: "production", release: "web@1.0" },
        filtered: 'release "web@1.0" is not in SENTRY_RELEASES [web@2.*]',
      },
    ];
    for (const [n, { over, filtered }] of refusals.entries()) {
      const answer = await post(served, alert(`filtered-${n}`, over), {
        requestId: `req-filtered-${n}`,
      });
      expect(answer.status).toBe(200);
      expect(delivered[n]).toMatchObject({
        requestId: `sentry:delivery:req-filtered-${n}`,
        event: { action: "create", filtered },
      });
      expect(delivered[n]?.keyedByWork).toBeUndefined();
    }

    // None of the three spent the one token: an alert inside the filter still has it.
    const admitted = await post(
      served,
      alert("admitted", { environment: "production", release: "web@2.1" }),
    );
    expect(admitted.status).toBe(200);
    expect(delivered[3]).toMatchObject({
      requestId: "sentry:event:admitted",
      keyedByWork: true,
    });
    expect(delivered[3]?.event.filtered).toBeUndefined();
    expect(
      (
        await post(
          served,
          alert("past-the-cap", {
            environment: "production",
            release: "web@2.2",
          }),
        )
      ).status,
    ).toBe(429);
  });

  it("refuses every delivery 503 naming the variable while SENTRY_MIN_LEVEL is not a level", async () => {
    configure({ SENTRY_CLIENT_SECRET: SECRET, SENTRY_MIN_LEVEL: "severe" });
    const answer = await post(served, alert("misconfigured"), {
      requestId: "req-misconfigured",
    });

    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({
      ok: false,
      code: "not-configured",
      error:
        'SENTRY_MIN_LEVEL is "severe"; it must be one of debug, info, warning, error, fatal',
    });
    expect(delivered).toHaveLength(0);
    const refusal = logged.filter((line) => line.includes("refused"));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("not-configured");
    expect(refusal[0]).toContain("req-misconfigured");
    expect(logged.join("\n")).not.toContain(CANARY);
  });
});
