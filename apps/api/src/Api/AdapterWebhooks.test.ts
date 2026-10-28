/* oxlint-disable effecttsgo/process-env */
/**
 * `POST /webhooks/jira` and `POST /webhooks/slack`, served in-process (LOB-259).
 *
 * The routes' own answers — the `503` of an unset secret, the `401` of a signature that is missing,
 * wrong or stale, Slack's `url_verification` handshake, the filter's skips, the `replayed` of a
 * redelivery — are given before the seam does anything but dedupe, so the seam here is a recording
 * fake and a case reads what a route handed it. The real seam, session layer and Postgres are the
 * `verify-api` drives' (`jira.sh`, `slack.sh`), which post to a booted API.
 *
 * Each secret-less case signs its body with the *empty* key, which is what an unset secret degrades
 * to (`Webhook.ts`'s `config.secret ?? ""`): without the `503` branch that signature verifies and
 * the delivery reaches the seam, so removing the branch turns these red instead of leaving a `401`
 * to pass for it. The control cases sign with a configured secret.
 */
import { createHmac } from "node:crypto";
import { slackSignature, TriggerService } from "@repo/core";
import type { TriggerDelivery, TriggerOutcome } from "@repo/domain/Trigger";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookRateLimiterLive, WebhookRoutes } from "./Webhook";

const VARIABLES = [
  "JIRA_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_CHANNELS",
  "SLACK_TEXT",
] as const;
const saved = new Map(VARIABLES.map((name) => [name, process.env[name]]));

const configure = (
  values: Partial<Record<(typeof VARIABLES)[number], string>>,
) => {
  for (const name of VARIABLES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const delivered: Array<TriggerDelivery> = [];
const SKIPPED: TriggerOutcome = {
  status: "skipped",
  replayed: false,
  reason: "fake",
};
let answer: TriggerOutcome = SKIPPED;

const { handler, dispose } = HttpRouter.toWebHandler(
  WebhookRoutes.pipe(
    HttpRouter.provideRequest(
      Layer.mergeAll(
        Layer.succeed(
          TriggerService,
          TriggerService.of({
            deliver: (delivery) =>
              Effect.sync(() => {
                delivered.push(delivery);
                return answer;
              }),
          }),
        ),
        WebhookRateLimiterLive,
      ),
    ),
  ),
  { disableLogger: true },
);

beforeEach(() => {
  delivered.length = 0;
  answer = SKIPPED;
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

type Answer = {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | null;
};

const read = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: await response.json(),
  retryAfter: response.headers.get("retry-after"),
});

// ---- Jira -------------------------------------------------------------------------------------

const JIRA_SECRET = "lob-259-jira-secret";

const jiraPayload = (over: Record<string, unknown> = {}) => ({
  timestamp: 1_729_000_000_000,
  webhookEvent: "jira:issue_created",
  issue: {
    id: "10001",
    key: "FAC-1",
    fields: {
      summary: "The widget wobbles",
      description: "It wobbles when it spins.",
      labels: ["factory"],
    },
  },
  ...over,
});

const jiraDigest = (raw: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

const postJira = async (
  body: unknown,
  signWith: string | null = JIRA_SECRET,
  signature?: (raw: string) => string,
): Promise<Answer> => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return read(
    await handler(
      new Request("http://factory.test/webhooks/jira", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signWith === null
            ? {}
            : {
                "x-hub-signature":
                  signature?.(raw) ?? jiraDigest(raw, signWith),
              }),
        },
        body: raw,
      }),
    ),
  );
};

describe("POST /webhooks/jira", () => {
  it("is 503 naming JIRA_WEBHOOK_SECRET when no secret is set, and hands the seam nothing", async () => {
    for (const secret of [undefined, ""]) {
      configure(secret === undefined ? {} : { JIRA_WEBHOOK_SECRET: secret });
      const refused = await postJira(jiraPayload(), "");
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ ok: false, code: "not-configured" });
      expect(JSON.stringify(refused.body)).toContain("JIRA_WEBHOOK_SECRET");
    }
    expect(delivered).toEqual([]);
  });

  it("hands a signed jira:issue_created to the seam as the adapter's own delivery", async () => {
    configure({ JIRA_WEBHOOK_SECRET: JIRA_SECRET });
    answer = { status: "processed", replayed: false, reason: "mapped" };
    const accepted = await postJira(jiraPayload());
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ ok: true, status: "processed" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      requestId: "jira:create:FAC-1:1729000000000",
      event: {
        source: "jira",
        key: "FAC-1",
        action: "create",
        title: "The widget wobbles",
        labels: ["factory"],
      },
    });
  });

  it("hands a replayed body to the seam under the same id, and relays the replay", async () => {
    configure({ JIRA_WEBHOOK_SECRET: JIRA_SECRET });
    await postJira(jiraPayload());
    answer = { status: "processed", replayed: true };
    const replay = await postJira(jiraPayload());
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true });
    expect(delivered.map((delivery) => delivery.requestId)).toEqual([
      "jira:create:FAC-1:1729000000000",
      "jira:create:FAC-1:1729000000000",
    ]);
  });

  it("is 401 for a missing, wrong or unprefixed signature, and hands the seam nothing", async () => {
    configure({ JIRA_WEBHOOK_SECRET: JIRA_SECRET });
    const missing = await postJira(jiraPayload(), null);
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ code: "missing-signature" });
    const wrong = await postJira(jiraPayload(), "another-secret");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: "bad-signature" });
    const unprefixed = await postJira(jiraPayload(), JIRA_SECRET, (raw) =>
      jiraDigest(raw, JIRA_SECRET).slice("sha256=".length),
    );
    expect(unprefixed.status).toBe(401);
    expect(delivered).toEqual([]);
  });

  it("is 400 for a signed body that is not a Jira issue, with nothing recorded", async () => {
    configure({ JIRA_WEBHOOK_SECRET: JIRA_SECRET });
    const noIssue = await postJira({ webhookEvent: "jira:issue_created" });
    expect(noIssue.status).toBe(400);
    expect(noIssue.body).toMatchObject({ code: "bad-payload" });
    expect((await postJira("[1]")).status).toBe(400);
    expect(delivered).toEqual([]);
  });

  it("is 503 in-progress for a replay whose claim has no outcome yet, so Jira keeps retrying", async () => {
    configure({ JIRA_WEBHOOK_SECRET: JIRA_SECRET });
    answer = { status: "received", replayed: true };
    const inFlight = await postJira(jiraPayload());
    expect(inFlight.status).toBe(503);
    expect(inFlight.body).toMatchObject({ code: "in-progress" });
    expect(inFlight.retryAfter).not.toBeNull();
  });
});

// ---- Slack ------------------------------------------------------------------------------------

const SLACK_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

// oxlint-disable-next-line effecttsgo/global-date -- a test harness signs for the instant it posts: the route's own clock is the real one.
const nowSeconds = () => Math.floor(Date.now() / 1000);

const slackMessage = (over: { text?: string; channel?: string } = {}) => ({
  type: "event_callback",
  event_id: "Ev0ACME",
  event: {
    type: "message",
    channel: over.channel ?? "C0ENG",
    user: "U0ALICE",
    text: over.text ?? "Fix the widget\nIt wobbles when it spins.",
    ts: "1699999999.000100",
    thread_ts: "1699999999.000000",
  },
});

const postSlack = async (
  body: unknown,
  options: {
    readonly secret?: string | null;
    readonly timestamp?: number;
    readonly signature?: string | null;
  } = {},
): Promise<Answer> => {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? nowSeconds());
  const signature =
    options.signature === undefined
      ? options.secret === null
        ? null
        : slackSignature(raw, timestamp, options.secret ?? SLACK_SECRET)
      : options.signature;
  return read(
    await handler(
      new Request("http://factory.test/webhooks/slack", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          ...(signature === null ? {} : { "x-slack-signature": signature }),
        },
        body: raw,
      }),
    ),
  );
};

describe("POST /webhooks/slack", () => {
  it("is 503 naming SLACK_SIGNING_SECRET when no secret is set, handshake included", async () => {
    for (const secret of [undefined, ""]) {
      configure({
        SLACK_CHANNELS: "C0ENG",
        ...(secret === undefined ? {} : { SLACK_SIGNING_SECRET: secret }),
      });
      const refused = await postSlack(slackMessage(), { secret: "" });
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ ok: false, code: "not-configured" });
      expect(JSON.stringify(refused.body)).toContain("SLACK_SIGNING_SECRET");
      const handshake = await postSlack(
        { type: "url_verification", challenge: "abc" },
        { secret: "" },
      );
      expect(handshake.status).toBe(503);
    }
    expect(delivered).toEqual([]);
  });

  it("answers url_verification with the challenge, once the secret is set and before any app is configured", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET });
    const handshake = await postSlack({
      type: "url_verification",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
    expect(handshake.status).toBe(200);
    expect(handshake.body).toEqual({
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
    expect(delivered).toEqual([]);
  });

  it("refuses an unsigned or wrongly signed handshake: the challenge is not echoed to a stranger", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET });
    const body = { type: "url_verification", challenge: "abc" };
    const unsigned = await postSlack(body, { secret: null });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body).toMatchObject({ code: "missing-signature" });
    const wrong = await postSlack(body, { secret: "another-secret" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: "bad-signature" });
    expect(JSON.stringify([unsigned.body, wrong.body])).not.toContain("abc");
  });

  it("refuses a stale delivery as outside-window, even though its signature is correct", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_CHANNELS: "C0ENG" });
    const stale = await postSlack(slackMessage(), {
      timestamp: nowSeconds() - 600,
    });
    expect(stale.status).toBe(401);
    expect(stale.body).toMatchObject({ code: "outside-window" });
    const future = await postSlack(slackMessage(), {
      timestamp: nowSeconds() + 600,
    });
    expect(future.status).toBe(401);
    expect(delivered).toEqual([]);
  });

  it("refuses a missing timestamp, a missing signature and a signature of another body", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_CHANNELS: "C0ENG" });
    const unsigned = await postSlack(slackMessage(), { secret: null });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body).toMatchObject({ code: "missing-signature" });
    const timestamp = String(nowSeconds());
    const other = await postSlack(slackMessage(), {
      signature: slackSignature("{}", timestamp, SLACK_SECRET),
      timestamp: Number(timestamp),
    });
    expect(other.status).toBe(401);
    expect(other.body).toMatchObject({ code: "bad-signature" });
    expect(delivered).toEqual([]);
  });

  it("hands a signed message in a watched channel to the seam, addressed by its thread", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_CHANNELS: "C0ENG" });
    answer = { status: "processed", replayed: false, reason: "mapped" };
    const accepted = await postSlack(slackMessage());
    expect(accepted.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      requestId: "slack:C0ENG:1699999999.000000:1699999999.000100",
      event: {
        source: "slack",
        action: "create",
        title: "Fix the widget",
        labels: ["C0ENG"],
      },
    });
  });

  it("reads the watched channels and the phrase from the environment per request", async () => {
    configure({
      SLACK_SIGNING_SECRET: SLACK_SECRET,
      SLACK_CHANNELS: "C0OPS",
      SLACK_TEXT: "deploy",
    });
    await postSlack(slackMessage({ channel: "C0ENG", text: "deploy it" }));
    await postSlack(slackMessage({ channel: "C0OPS", text: "no keyword" }));
    await postSlack(slackMessage({ channel: "C0OPS", text: "Please DEPLOY" }));
    expect(delivered.map((delivery) => delivery.event.action)).toEqual([
      "filtered:channel",
      "filtered:text",
      "create",
    ]);
  });

  it("answers 200 and ignores a signed payload that carries no event, handing the seam nothing", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_CHANNELS: "C0ENG" });
    const limited = await postSlack({
      type: "app_rate_limited",
      minute_rate_limited: 1_700_000_000,
    });
    expect(limited.status).toBe(200);
    expect(limited.body).toMatchObject({ ok: true });
    expect(delivered).toEqual([]);
  });

  it("is 400 for a signed event_callback with no event, and 503 in-progress for a claim with no outcome", async () => {
    configure({ SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_CHANNELS: "C0ENG" });
    const empty = await postSlack({ type: "event_callback" });
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ code: "bad-payload" });
    answer = { status: "received", replayed: true };
    const inFlight = await postSlack(slackMessage());
    expect(inFlight.status).toBe(503);
    expect(inFlight.body).toMatchObject({ code: "in-progress" });
  });
});
