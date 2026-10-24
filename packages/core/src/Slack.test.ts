/**
 * The Slack adapter (LOB-191): its signature check, the filter that decides what a message means,
 * and the two Web API calls the write-back makes.
 *
 * The seam's own behaviour — dedupe, the action filter, the label mapping, the claim release — is
 * `TriggerService.test.ts`'s and `Trigger.test.ts`'s and is not re-proved here. The end-to-end half
 * (a signed message creates one session, a replay creates none, a stale delivery is refused, a
 * filtered message records why, the reply lands in the thread) is
 * `.pi/skills/verify-api/slack.ts` against the real session layer and a loopback Slack.
 */
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import type { SessionId } from "@repo/domain/Session";
import {
  parseSlackAddress,
  SLACK_REPLAY_WINDOW_SECONDS,
  slackAddress,
  slackConfigFromEnv,
  slackDelivery,
  slackDeliveryFor,
  slackEvent,
  slackReply,
  slackRequestId,
  slackSignature,
  verifySlackSignature,
  type SlackFilter,
  SlackWriteBack,
} from "./Slack";
import { TriggerWriteBack } from "./TriggerService";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const filter: SlackFilter = { channels: ["C0ENG"] };

/** Slack's `event_callback` payload for a message, as the Events API documents it. */
const payload = (
  over: {
    readonly type?: string;
    readonly channel?: string;
    readonly ts?: string;
    readonly threadTs?: string;
    readonly text?: string;
    readonly subtype?: string;
    readonly botId?: string;
    readonly eventId?: string;
  } = {},
): Record<string, unknown> => ({
  token: "verification-token",
  team_id: "T0ACME",
  api_app_id: "A0ACME",
  type: "event_callback",
  event_id: over.eventId ?? "Ev0ACME",
  event_time: 1_699_999_999,
  event: {
    type: over.type ?? "message",
    channel: over.channel ?? "C0ENG",
    user: "U0ALICE",
    text: over.text ?? "Fix the widget\nIt wobbles when it spins.",
    ts: over.ts ?? "1699999999.000100",
    ...(over.threadTs === undefined ? {} : { thread_ts: over.threadTs }),
    ...(over.subtype === undefined ? {} : { subtype: over.subtype }),
    ...(over.botId === undefined ? {} : { bot_id: over.botId }),
  },
});

/** The Web API's two calls; `existing` is what the thread answers. */
const makeFakeHttp = (
  over: {
    readonly status?: number;
    readonly ok?: boolean;
    readonly error?: string;
    readonly existing?: ReadonlyArray<unknown>;
    readonly repliesStatus?: number;
  } = {},
) => {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly query: string;
    readonly authorization: string | undefined;
    readonly body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const reqBody =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.searchParams.toString(),
          authorization: request.headers["authorization"],
          body: reqBody,
        });
        const answer =
          request.method === "GET"
            ? {
                status: over.repliesStatus ?? 200,
                body: {
                  ok: true,
                  messages: over.existing ?? [],
                },
              }
            : {
                status: over.status ?? 200,
                body:
                  over.ok === false
                    ? { ok: false, error: over.error ?? "channel_not_found" }
                    : { ok: true, ts: "1699999999.000200" },
              };
        const text = yield* Schema.encodeEffect(Json)(answer.body).pipe(
          Effect.orDie,
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(text, {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }).pipe(Effect.orDie),
    ),
  );
  return { requests, layer: client };
};

const sessionId = "01J8Z000000000000000000000" as SessionId;

const writeBack = (
  over: Parameters<typeof makeFakeHttp>[0] = {},
  config: { readonly sessionUrlBase?: string } = {},
) => {
  const fake = makeFakeHttp(over);
  const layer = SlackWriteBack({
    apiUrl: "http://127.0.0.1:9414",
    botToken: Redacted.make("xoxb-test-token"),
    ...config,
  }).pipe(Layer.provide(fake.layer));
  return { fake, layer };
};

const write = (
  layer: Layer.Layer<TriggerWriteBack>,
  key = "C0ENG:1699999999.000000:1699999999.000100",
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const port = yield* TriggerWriteBack;
      yield* port.write({
        event: {
          source: "slack",
          key,
          action: "create",
          title: "",
          body: "",
          labels: ["C0ENG"],
        },
        sessionId,
      });
    }).pipe(Effect.provide(layer)),
  );

describe("verifySlackSignature", () => {
  const raw = JSON.stringify(payload({}));
  const now = 1_699_999_999;
  const timestamp = String(now);
  const signed = (over: {
    readonly signature?: string | undefined;
    readonly timestamp?: string | undefined;
    readonly nowSeconds?: number;
    readonly body?: string;
    readonly secret?: string;
  }) =>
    verifySlackSignature({
      raw: over.body ?? raw,
      signature:
        over.signature === undefined
          ? slackSignature(raw, timestamp, SECRET)
          : over.signature,
      timestamp: over.timestamp === undefined ? timestamp : over.timestamp,
      signingSecret: over.secret ?? SECRET,
      nowSeconds: over.nowSeconds ?? now,
    });

  it("accepts Slack's own signature over v0:<timestamp>:<body>", () => {
    expect(signed({})).toEqual({ ok: true });
  });

  it("matches the signature Slack's own documentation says it sends, not one this repo computes", () => {
    // The known-answer vector from Slack's "Verifying requests from Slack" page: a real body, its
    // timestamp, the documented signing secret and the `v0=` hex Slack reports for them. Without
    // this, a wrong construction (no `v0:` in the HMAC input, a different separator, base64) would
    // agree with itself in every other case here.
    const documentedBody =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    const documentedTimestamp = "1531420618";
    const documentedSignature =
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
    expect(slackSignature(documentedBody, documentedTimestamp, SECRET)).toBe(
      documentedSignature,
    );
    expect(
      verifySlackSignature({
        raw: documentedBody,
        signature: documentedSignature,
        timestamp: documentedTimestamp,
        signingSecret: SECRET,
        nowSeconds: Number(documentedTimestamp),
      }),
    ).toEqual({ ok: true });
  });

  it("accepts a delivery at the edge of the window, and refuses one past it", () => {
    expect(signed({ nowSeconds: now + SLACK_REPLAY_WINDOW_SECONDS })).toEqual({
      ok: true,
    });
    expect(
      signed({ nowSeconds: now + SLACK_REPLAY_WINDOW_SECONDS + 1 }),
    ).toEqual({ ok: false, refusal: "outside-window" });
    expect(
      signed({ nowSeconds: now - SLACK_REPLAY_WINDOW_SECONDS - 1 }),
    ).toEqual({ ok: false, refusal: "outside-window" });
  });

  it("refuses a body that changed after it was signed", () => {
    expect(signed({ body: `${raw} ` })).toEqual({
      ok: false,
      refusal: "bad-signature",
    });
  });

  it("refuses a signature made with another secret", () => {
    expect(
      signed({ signature: slackSignature(raw, timestamp, "another-secret") }),
    ).toEqual({ ok: false, refusal: "bad-signature" });
  });

  it("names which piece is missing or malformed rather than answering a bare false", () => {
    expect(
      verifySlackSignature({
        raw,
        signature: undefined,
        timestamp: undefined,
        signingSecret: SECRET,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, refusal: "missing-signature" });
    expect(
      verifySlackSignature({
        raw,
        signature: "",
        timestamp,
        signingSecret: SECRET,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, refusal: "missing-signature" });
    expect(
      verifySlackSignature({
        raw,
        signature: "v0=00",
        timestamp: undefined,
        signingSecret: SECRET,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, refusal: "missing-timestamp" });
    expect(signed({ timestamp: "not-a-number" })).toEqual({
      ok: false,
      refusal: "bad-timestamp",
    });
  });

  it("refuses a signature of the right shape but the wrong length without throwing", () => {
    expect(signed({ signature: "v0=dead" })).toEqual({
      ok: false,
      refusal: "bad-signature",
    });
  });
});

describe("slackEvent", () => {
  it("normalizes a watched message into the seam's event, named by its channel", () => {
    expect(slackEvent(payload({}), filter)).toEqual({
      source: "slack",
      key: "C0ENG:1699999999.000100:1699999999.000100",
      action: "create",
      title: "Fix the widget",
      body: "Fix the widget\nIt wobbles when it spins.",
      labels: ["C0ENG"],
    });
  });

  it("addresses a message in a thread by its root, so the reply lands there", () => {
    const threaded = slackEvent(
      payload({ threadTs: "1699999999.000000" }),
      filter,
    );
    expect(threaded?.title).toBe("Fix the widget");
    expect(threaded?.key).toBe("C0ENG:1699999999.000000:1699999999.000100");
    expect(parseSlackAddress(threaded?.key ?? "")).toEqual({
      channel: "C0ENG",
      rootTs: "1699999999.000000",
      messageTs: "1699999999.000100",
    });
  });

  it("refuses a message in a channel the filter does not watch, and says which", () => {
    expect(slackEvent(payload({ channel: "C0RANDOM" }), filter)?.action).toBe(
      "filtered:channel",
    );
  });

  it("refuses a message that does not carry the filter's phrase", () => {
    const withPhrase: SlackFilter = { channels: ["C0ENG"], text: "deploy" };
    expect(slackEvent(payload({}), withPhrase)?.action).toBe("filtered:text");
    expect(
      slackEvent(payload({ text: "please DEPLOY the widget" }), withPhrase)
        ?.action,
    ).toBe("create");
  });

  it("refuses a bot's own message and an edit, so a reply cannot start a session", () => {
    expect(slackEvent(payload({ botId: "B0ACME" }), filter)?.action).toBe(
      "filtered:bot",
    );
    expect(
      slackEvent(payload({ subtype: "message_changed" }), filter)?.action,
    ).toBe("filtered:subtype:message_changed");
  });

  it("keeps Slack's own event type for an event that starts nothing", () => {
    expect(
      slackEvent(
        { ...payload({}), event: { type: "reaction_added", channel: "C0ENG" } },
        filter,
      )?.action,
    ).toBe("reaction_added");
  });

  it("answers undefined for the url_verification handshake and for a non-event payload", () => {
    expect(
      slackEvent({ type: "url_verification", challenge: "abc" }, filter),
    ).toBeUndefined();
    expect(slackEvent({ type: "app_rate_limited" }, filter)).toBeUndefined();
    expect(slackEvent("not a payload", filter)).toBeUndefined();
  });
});

describe("slackRequestId", () => {
  it("is the message, so Slack's retries of it are one delivery", () => {
    const first = slackDelivery(payload({}), filter);
    // Slack re-sends with a different `event_id` and an `x-slack-retry-num` header.
    const retry = slackDelivery(payload({ eventId: "Ev0RETRY" }), filter);
    expect(retry?.requestId).toBe(first?.requestId);
    expect(first?.requestId).toBe(
      "slack:C0ENG:1699999999.000100:1699999999.000100",
    );
  });

  it("is a different delivery for a different message in the same thread", () => {
    const root = slackDeliveryFor(filter)(payload({}));
    const reply = slackDeliveryFor(filter)(
      payload({ threadTs: "1699999999.000100", ts: "1700000000.000200" }),
    );
    expect(reply?.requestId).not.toBe(root?.requestId);
  });

  it("collapses the thread-broadcast twin of a threaded message into one delivery", () => {
    // Slack sends a threaded reply twice when it is also broadcast to the channel: same `ts`, same
    // `thread_ts`, two deliveries. One message, one session.
    const inThread = slackDelivery(
      payload({ threadTs: "1699999999.000000", ts: "1700000000.000200" }),
      filter,
    );
    const broadcast = slackDelivery(
      payload({
        subtype: "thread_broadcast",
        threadTs: "1699999999.000000",
        ts: "1700000000.000200",
        eventId: "Ev0BROADCAST",
      }),
      filter,
    );
    expect(broadcast?.event.action).toBe("create");
    expect(broadcast?.requestId).toBe(inThread?.requestId);
  });

  it("names a filtered message by its own address, so its skip is one row", () => {
    const rejected = slackDelivery(payload({ channel: "C0RANDOM" }), filter);
    expect(rejected?.requestId).toBe(
      "slack:C0RANDOM:1699999999.000100:1699999999.000100",
    );
    expect(rejected?.event.action).toBe("filtered:channel");
  });

  it("does not normalize a handshake into a delivery at all", () => {
    expect(
      slackDelivery({ type: "url_verification", challenge: "abc" }, filter),
    ).toBeUndefined();
    const event = slackEvent(payload({}), filter);
    expect(event === undefined ? undefined : slackRequestId(event)).toBe(
      "slack:C0ENG:1699999999.000100:1699999999.000100",
    );
  });
});

describe("slackConfigFromEnv", () => {
  const env = {
    apiUrl: undefined,
    botToken: "xoxb-token",
    signingSecret: SECRET,
    sessionUrlBase: undefined,
    channels: "C0ENG, C0OPS",
    text: undefined,
  };

  it("builds the app from a complete environment", () => {
    const app = slackConfigFromEnv(env);
    expect(app?.filter).toEqual({ channels: ["C0ENG", "C0OPS"] });
    expect(Redacted.value(app?.config.botToken ?? Redacted.make(""))).toBe(
      "xoxb-token",
    );
    expect(app?.config.apiUrl).toBeUndefined();
  });

  it("is one app or none: a missing token or secret configures nothing", () => {
    expect(slackConfigFromEnv({ ...env, botToken: undefined })).toBeUndefined();
    expect(slackConfigFromEnv({ ...env, signingSecret: "  " })).toBeUndefined();
  });

  it("watches nothing when no channel is configured", () => {
    expect(slackConfigFromEnv({ ...env, channels: "" })).toBeUndefined();
    expect(slackConfigFromEnv({ ...env, channels: " , " })).toBeUndefined();
  });

  it("carries the optional address and phrase, trimmed", () => {
    const app = slackConfigFromEnv({
      ...env,
      apiUrl: "http://127.0.0.1:9414/",
      sessionUrlBase: "http://localhost:3000/sessions/",
      text: " deploy ",
    });
    expect(app?.config.apiUrl).toBe("http://127.0.0.1:9414");
    expect(app?.config.sessionUrlBase).toBe("http://localhost:3000/sessions/");
    expect(app?.filter.text).toBe("deploy");
    expect(app?.signingSecret).toEqual(Redacted.make(SECRET));
  });
});

describe("SlackWriteBack", () => {
  it("reads the thread, then replies in it, as the bot token names it", async () => {
    const { fake, layer } = writeBack();
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
    expect(fake.requests[0]?.path).toBe("/api/conversations.replies");
    expect(fake.requests[0]?.query).toContain("channel=C0ENG");
    expect(fake.requests[0]?.query).toContain("ts=1699999999.000000");
    const post = fake.requests[1];
    expect(post?.path).toBe("/api/chat.postMessage");
    expect(post?.authorization).toBe("Bearer xoxb-test-token");
    expect(post?.body).toEqual({
      channel: "C0ENG",
      thread_ts: "1699999999.000000",
      text: slackReply(
        { botToken: Redacted.make("xoxb-test-token") },
        sessionId,
      ),
    });
  });

  it("replies nothing when the thread already carries this session's reply", async () => {
    const { fake, layer } = writeBack({
      existing: [
        { text: `Factory started session ${sessionId} for this message.` },
      ],
    });
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("still replies when the thread carries another session's reply", async () => {
    const { fake, layer } = writeBack({
      existing: [
        { text: "Factory started session 01J8ZOTHER for this message." },
      ],
    });
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
  });

  it("names the session in the reply, and links to it when the deployment knows where", () => {
    const withoutLink = slackReply({ botToken: Redacted.make("x") }, sessionId);
    expect(withoutLink).toContain(sessionId);
    expect(withoutLink).not.toContain("http://localhost:3000");
    expect(
      slackReply(
        {
          botToken: Redacted.make("x"),
          sessionUrlBase: "http://localhost:3000/sessions/",
        },
        sessionId,
      ),
    ).toContain(`http://localhost:3000/sessions/${sessionId}`);
  });

  it("fails as a write-back when Slack refuses the reply with an HTTP error", async () => {
    const { layer } = writeBack({ status: 403 });
    const exit = await write(layer);
    expect(exit._tag).toBe("Failure");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        return yield* Effect.flip(
          port.write({
            event: {
              source: "slack",
              key: "C0ENG:1699999999.000100:1699999999.000100",
              action: "create",
              title: "",
              body: "",
              labels: ["C0ENG"],
            },
            sessionId,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(error.code).toBe("write-back");
    expect(error.message).toContain("403");
  });

  it("fails as a write-back when Slack answers 200 with ok=false", async () => {
    const { layer } = writeBack({ ok: false, error: "not_in_channel" });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        return yield* Effect.flip(
          port.write({
            event: {
              source: "slack",
              key: "C0ENG:1699999999.000100:1699999999.000100",
              action: "create",
              title: "",
              body: "",
              labels: ["C0ENG"],
            },
            sessionId,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(error.code).toBe("write-back");
    expect(error.message).toContain("not_in_channel");
  });

  it("fails as a write-back when the event's key names no message address", async () => {
    const { layer } = writeBack();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        return yield* Effect.flip(
          port.write({
            event: {
              source: "slack",
              key: "Ev0ACME",
              action: "create",
              title: "",
              body: "",
              labels: [],
            },
            sessionId,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(error.code).toBe("write-back");
    expect(error.message).toContain("names no channel");
  });
});

describe("slackAddress", () => {
  it("makes a message outside a thread its own root", () => {
    expect(
      slackAddress({ channel: "C0ENG", messageTs: "1700000000.000001" }),
    ).toBe("C0ENG:1700000000.000001:1700000000.000001");
  });

  it("refuses a key that is not one", () => {
    expect(parseSlackAddress("C0ENG")).toBeUndefined();
    expect(parseSlackAddress("a:b:c:d")).toBeUndefined();
    expect(parseSlackAddress("::")).toBeUndefined();
  });
});
