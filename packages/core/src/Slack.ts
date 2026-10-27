/**
 * The Slack adapter (LOB-191, part 4 of LOB-34): a Slack message in, one session and one threaded
 * reply out.
 *
 * Part 1 (`@repo/domain/Trigger` + `./TriggerService`) owns everything after normalization — the
 * dedupe claim, the action filter, the label → `{repo, baseRef, prompt}` mapping, the session and
 * the write-back call. An adapter is therefore one extractor (`slackEvent`), one filter (which
 * messages are a delegation at all) and one client (`SlackWriteBack`); it adds no rule of its own
 * about what makes a delivery a replay, and it modifies no other adapter's module.
 *
 * **Slack signs differently, so the signature check is this adapter's own.** Linear and the generic
 * webhook (part 1) sign the raw body with an HMAC in a header. Slack signs `v0:<timestamp>:<body>`
 * with its signing secret and puts the result in `x-slack-signature` prefixed `v0=`, next to the
 * `x-slack-request-timestamp` the signature covers. That timestamp is also Slack's replay guard: a
 * delivery more than `SLACK_REPLAY_WINDOW_SECONDS` away from now is refused — *typed*, so a route
 * (or a drive) can tell "unsigned", "wrong secret" and "replayed later" apart instead of collapsing
 * all three into a bare `false`. `verifySlackSignature` is that check, and the literal reasons are
 * `SlackSignatureRefusal`.
 *
 * **A message is the delegation, and the filter says which messages.** A Slack message carries no
 * labels, so the channel is what a mapping rule matches: `slackEvent` puts the channel on
 * `TriggerEvent.labels` (as its id, which is what the payload carries), and an operator's rule reads
 * `{label: "C0ENG", repo: "acme/widget", prompt: "…{{body}}…"}`. The filter narrows that to the
 * messages that really are a task — a channel allow-list and an optional phrase the text must
 * contain — and a message it rejects is *recorded* as skipped with the reason in it (`filtered:…`)
 * rather than dropped: "nothing happened" and "this arrived and here is why it started nothing" are
 * different answers to an operator.
 *
 * **The write-back replies in the message's own thread.** A Slack thread's root is addressed by its
 * own `ts`, so the event's key carries all three facts a reply needs — `channel:root:message` — and
 * `slackAddress`/`parseSlackAddress` are the one place that spelling lives. A message that is
 * already in a thread is answered in that thread; one that is not is answered with a reply threaded
 * on itself, which is what Slack's own "reply in thread" does.
 */
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionId } from "@repo/domain/Session";
import {
  TRIGGER_ACTION,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
} from "@repo/domain/Trigger";
import { TriggerWriteBack } from "./TriggerService";

/**
 * How far a delivery's timestamp may be from now, in seconds. Slack's own documented window: a
 * request older (or newer) than this is a replay and is refused before its body is read.
 */
export const SLACK_REPLAY_WINDOW_SECONDS = 300;

/**
 * Why a delivery's signature was not accepted. Each is a different fix — a missing header, a secret
 * that does not match, or a captured delivery replayed later — so the verdict names which.
 */
export const SlackSignatureRefusal = Schema.Literals([
  "missing-signature",
  "missing-timestamp",
  "bad-timestamp",
  "outside-window",
  "bad-signature",
]);
export type SlackSignatureRefusal = typeof SlackSignatureRefusal.Type;

/** `ok` or the one reason it is not. A route answers `401` for every refusal and names it. */
export type SlackSignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: SlackSignatureRefusal };

/**
 * The signature Slack would have sent for this body and timestamp: `v0=` + hex HMAC-SHA256 of
 * `v0:<timestamp>:<body>` under the app's signing secret.
 *
 * Exported because the drive has to sign what it delivers, and because a test that spelled the
 * scheme a second time could agree with a wrong implementation.
 */
export const slackSignature = (
  raw: string,
  timestamp: string,
  signingSecret: string,
): string =>
  `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex")}`;

/**
 * Whether a delivery is Slack's, and recent enough to act on.
 *
 * The order is deliberate: a missing header is cheaper to answer than an HMAC, and the window is
 * checked before the signature because a replayed delivery is one whose signature is *correct* — it
 * was a real delivery once — so "outside-window" is the honest answer, not "bad-signature".
 *
 * `nowSeconds` is required: this adapter reads no ambient clock, so the window is a fact the caller
 * states — a test's fixed instant, a drive's run moment, or a route's Effect `Clock` — instead of
 * something a signature check hides.
 */
export const verifySlackSignature = (input: {
  readonly raw: string;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly signingSecret: string;
  /** The current time in seconds. Required: nothing here reads the wall clock itself. */
  readonly nowSeconds: number;
}): SlackSignatureVerdict => {
  const signature = input.signature ?? "";
  if (signature === "") return { ok: false, refusal: "missing-signature" };
  const timestamp = input.timestamp ?? "";
  if (timestamp === "") return { ok: false, refusal: "missing-timestamp" };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, refusal: "bad-timestamp" };
  if (Math.abs(input.nowSeconds - seconds) > SLACK_REPLAY_WINDOW_SECONDS) {
    return { ok: false, refusal: "outside-window" };
  }
  const expected = slackSignature(input.raw, timestamp, input.signingSecret);
  const expectedBytes = Buffer.from(expected, "utf8");
  const givenBytes = Buffer.from(signature, "utf8");
  // `timingSafeEqual` throws on different lengths, and a length difference is itself a mismatch.
  if (expectedBytes.length !== givenBytes.length) {
    return { ok: false, refusal: "bad-signature" };
  }
  return timingSafeEqual(expectedBytes, givenBytes)
    ? { ok: true }
    : { ok: false, refusal: "bad-signature" };
};

/**
 * Which messages count as a delegation: the channels an operator watches, and optionally a phrase
 * the message must contain.
 *
 * A channel is matched by the identifier Slack puts on the event (`C0ENG`); a relay that rewrites
 * ids to names configures names instead, because this compares strings and does not ask Slack what a
 * channel is called. `text` is a case-insensitive substring, not a pattern: a Slack message is
 * prose, and a regex over one is a footgun an operator cannot debug from a skip reason.
 */
export const SlackFilter = Schema.Struct({
  channels: Schema.Array(Schema.String),
  text: Schema.optional(Schema.String),
});
export type SlackFilter = typeof SlackFilter.Type;

/** The action prefix a filtered message carries, so the seam's recorded reason says why. */
const FILTERED = "filtered";

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

/**
 * Where a message lives, as the event key carries it: `channel:root:message`.
 *
 * Three facts, two separators, and no escaping needed: a Slack channel id and a Slack `ts`
 * (`1699999999.000100`) are opaque tokens that never contain a colon. A message outside a thread is
 * its own root, which is how Slack addresses a reply to it.
 */
export const slackAddress = (input: {
  readonly channel: string;
  readonly messageTs: string;
  readonly threadTs?: string;
}): string =>
  `${input.channel}:${input.threadTs ?? input.messageTs}:${input.messageTs}`;

/** The inverse of `slackAddress`; `undefined` for a key that is not one. */
export const parseSlackAddress = (
  key: string,
):
  | {
      readonly channel: string;
      readonly rootTs: string;
      readonly messageTs: string;
    }
  | undefined => {
  const parts = key.split(":");
  if (parts.length !== 3) return undefined;
  const [channel, rootTs, messageTs] = parts;
  if (!channel || !rootTs || !messageTs) return undefined;
  return { channel, rootTs, messageTs };
};

/** The first line of a message, as the session's title: what an operator skims. */
const titleOf = (text: string): string => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "").trim();
};

/** Whether this message is a task, and if not, the reason the skip will record. */
const slackAction = (
  event: Record<string, unknown>,
  channel: string,
  text: string,
  filter: SlackFilter,
): string => {
  const subtype = stringField(event, "subtype");
  if (subtype !== undefined && subtype !== "thread_broadcast") {
    // `bot_message` is how a bot's own post arrives; `message_changed`/`message_deleted` are edits.
    return `${FILTERED}:subtype:${subtype}`;
  }
  if (stringField(event, "bot_id") !== undefined) return `${FILTERED}:bot`;
  if (!filter.channels.includes(channel)) return `${FILTERED}:channel`;
  const phrase = filter.text;
  if (phrase !== undefined && phrase !== "") {
    if (!text.toLowerCase().includes(phrase.toLowerCase())) {
      return `${FILTERED}:text`;
    }
  }
  return TRIGGER_ACTION;
};

/**
 * A Slack Events API payload, normalized.
 *
 * `undefined` is "this payload carries no event to judge": Slack's `url_verification` handshake, a
 * payload that is not an `event_callback`, or one with no `event`. Everything else becomes a
 * `TriggerEvent` whose `action` says what will happen to it:
 *
 * - a `message` that passes the filter is `create` — the only action the seam starts work on;
 * - a `message` the filter rejects keeps a `filtered:<why>` action, so the skip the seam records
 *   names the reason (`filtered:channel`, `filtered:text`, `filtered:bot`, `filtered:subtype:…`);
 * - any other event type keeps Slack's own name (`reaction_added`, `app_mention`), so the recorded
 *   reason reads as the event that arrived rather than a word invented here.
 *
 * Bot messages and message edits are refused by the filter, not by the seam: a bot replying in a
 * watched channel would otherwise start a session per reply, and an edit is a second delivery of a
 * message that already had its answer.
 */
export const slackEvent = (
  payload: unknown,
  filter: SlackFilter,
): TriggerEvent | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  if (stringField(body, "type") !== "event_callback") return undefined;
  const event = asRecord(body["event"]);
  if (event === undefined) return undefined;
  const eventId = stringField(body, "event_id");
  const type = stringField(event, "type");
  const channel = stringField(event, "channel");
  const ts = stringField(event, "ts");
  const text = stringField(event, "text") ?? "";
  const threadTs = stringField(event, "thread_ts");

  // A non-message event has no message address; it is identified by Slack's event id so the skip it
  // records is one row per delivery.
  if (type !== "message" || channel === undefined || ts === undefined) {
    const key =
      eventId ?? `${type ?? "unknown"}:${stringField(event, "event_ts") ?? ""}`;
    return {
      source: "slack",
      key,
      action: type ?? "unknown",
      title: "",
      body: text,
      labels: channel === undefined ? [] : [channel],
    };
  }

  const key = slackAddress({
    channel,
    messageTs: ts,
    ...(threadTs === undefined ? {} : { threadTs }),
  });
  return {
    source: "slack",
    key,
    action: slackAction(event, channel, text, filter),
    title: titleOf(text),
    body: text,
    labels: [channel],
  };
};

/**
 * The delivery id for a Slack payload: the message once.
 *
 * Slack sends no delivery id in the body; it re-sends a delivery it thinks failed flagged with an
 * `x-slack-retry-num` header. So the key is the message address, which a re-send cannot change: a
 * retry and the thread-broadcast twin of a threaded message are the same delivery. Slack's
 * `event_id` is deliberately *not* the key — it identifies the delivery attempt, not the message,
 * and the duplicate this must collapse is "the same message delivered twice", whichever attempt
 * carried it. Whether Slack really re-stamps `event_id` on a retry is not something this repo can
 * check (see `docs/testing-third-parties.md`); keying on the message makes it not matter.
 */
export const slackRequestId = (event: TriggerEvent): string =>
  `slack:${event.key}`;

/** A payload as the seam takes it: the normalized event, named by its derived delivery id. */
export const slackDelivery = (
  payload: unknown,
  filter: SlackFilter,
): TriggerDelivery | undefined => {
  const event = slackEvent(payload, filter);
  if (event === undefined) return undefined;
  return { requestId: slackRequestId(event), event };
};

/** The adapter's delivery function, bound to one filter. */
export const slackDeliveryFor =
  (filter: SlackFilter) =>
  (payload: unknown): TriggerDelivery | undefined =>
    slackDelivery(payload, filter);

/** Where the write-back posts, as whom, and where a reader finds the session. */
export type SlackConfig = {
  /** Slack's API root. Absent means `https://slack.com`, the public Web API. */
  readonly apiUrl?: string;
  /** The bot token the reply is posted with (`xoxb-…`). */
  readonly botToken: Redacted.Redacted<string>;
  /** Where a reader finds the session, so the reply links to it. */
  readonly sessionUrlBase?: string;
};

/** The environment a deployment configures the adapter with. */
export type SlackEnv = {
  readonly apiUrl: string | undefined;
  readonly botToken: string | undefined;
  readonly signingSecret: string | undefined;
  readonly sessionUrlBase: string | undefined;
  /** Comma-separated channel ids or names; empty means "watch nothing". */
  readonly channels: string | undefined;
  /** A phrase a message must contain, for deployments that use Slack as a queue with a keyword. */
  readonly text: string | undefined;
};

/** Everything one configured Slack app is: the client's config, its secret and its filter. */
export type SlackApp = {
  readonly config: SlackConfig;
  readonly signingSecret: Redacted.Redacted<string>;
  readonly filter: SlackFilter;
};

/**
 * A configured app from environment-shaped values, or `undefined` when the deployment has none.
 *
 * The bot token and the signing secret are required together: a half-configured app would accept
 * deliveries it cannot answer, or answer ones it never checked. An app with no channels watches
 * nothing, which is the same state as having none — a filter over an empty list cannot be a
 * delegation rule, so the honest reading is "this deployment does not run Slack".
 */
export const slackConfigFromEnv = (env: SlackEnv): SlackApp | undefined => {
  const botToken = env.botToken?.trim();
  const signingSecret = env.signingSecret?.trim();
  if (!botToken || !signingSecret) return undefined;
  const channels = (env.channels ?? "")
    .split(",")
    .map((channel) => channel.trim())
    .filter((channel) => channel !== "");
  if (channels.length === 0) return undefined;
  const apiUrl = env.apiUrl?.trim();
  const sessionUrlBase = env.sessionUrlBase?.trim();
  const text = env.text?.trim();
  return {
    config: {
      ...(apiUrl ? { apiUrl: apiUrl.replace(/\/+$/, "") } : {}),
      botToken: Redacted.make(botToken),
      ...(sessionUrlBase === undefined ? {} : { sessionUrlBase }),
    },
    signingSecret: Redacted.make(signingSecret),
    filter: {
      channels,
      ...(text === undefined || text === "" ? {} : { text }),
    },
  };
};

/** The reply's text: the session id, and a link when the deployment knows its own address. */
export const slackReply = (
  config: SlackConfig,
  sessionId: SessionId,
): string => {
  const link =
    config.sessionUrlBase === undefined
      ? ""
      : ` (${config.sessionUrlBase.replace(/\/+$/, "")}/${sessionId})`;
  return `Factory started session ${sessionId} for this message${link}.`;
};

/** Slack's Web API answers `200` with `{ok: false, error}` for a logical failure. */
const SlackAnswer = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});

/** One page of a thread, as `conversations.replies` answers it. */
const SlackReplies = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  messages: Schema.optional(
    Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
  ),
});

/**
 * The seam's write-back port, filled by Slack's Web API.
 *
 * `chat.postMessage` with the channel and the thread root is the reply: `{channel, thread_ts, text}`
 * with the bot token as `Bearer`, and Slack answers `{ok: true, ts}`. Anything else — an
 * unreachable API, a refused token, a body that cannot be encoded, or Slack's own
 * `{ok: false, error}` on an HTTP `200` — is a `write-back` `TriggerError`, which the seam answers
 * by giving the delivery's claim back.
 *
 * **It reads the thread before it replies.** The seam's retry contract is "any failed delivery gives
 * its claim back", so a write-back that posted again on the retry would answer a message twice
 * whenever the reply landed and its acknowledgement did not. A reply naming this session is the
 * record the retry looks for, exactly as on Jira (`Jira.ts`) and GitHub (`GitHub.ts`). The read is
 * Slack's default page of a thread (100 messages); a longer thread is the one shape this check
 * cannot see, which `docs/testing-third-parties.md` records.
 */
export const SlackWriteBack = (
  config: SlackConfig,
): Layer.Layer<TriggerWriteBack, never, HttpClient.HttpClient> =>
  Layer.effect(
    TriggerWriteBack,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const apiUrl = (config.apiUrl ?? "https://slack.com").replace(/\/+$/, "");
      const authorization = `Bearer ${Redacted.value(config.botToken)}`;
      const headers = { authorization };
      const fail = (message: string): TriggerError =>
        new TriggerError({ code: "write-back", message });

      /** Slack's own error name when it refused on an HTTP 200. */
      const slackFailure = (
        what: string,
        body: { readonly error?: string | undefined },
      ): TriggerError =>
        fail(
          `${what}: Slack answered ok=false${body.error === undefined ? "" : ` (${body.error})`}`,
        );

      return TriggerWriteBack.of({
        write: (input) =>
          Effect.gen(function* () {
            const address = parseSlackAddress(input.event.key);
            if (address === undefined) {
              return yield* fail(
                `the payload for ${input.event.key} names no channel and message to reply to`,
              );
            }

            const repliesUrl = `${apiUrl}/api/conversations.replies?channel=${encodeURIComponent(address.channel)}&ts=${encodeURIComponent(address.rootTs)}`;
            const replies = yield* http
              .execute(HttpClientRequest.get(repliesUrl, { headers }))
              .pipe(
                Effect.mapError(() =>
                  fail(`Slack could not be read for ${input.event.key}`),
                ),
              );
            if (replies.status < 200 || replies.status > 299) {
              return yield* fail(
                `Slack answered HTTP ${replies.status} reading ${input.event.key}'s thread`,
              );
            }
            const page = yield* HttpClientResponse.schemaBodyJson(SlackReplies)(
              replies,
            ).pipe(
              Effect.mapError(() =>
                fail(`Slack's thread for ${input.event.key} could not be read`),
              ),
            );
            if (!page.ok)
              return yield* slackFailure("reading the thread", page);
            const already = (page.messages ?? []).some((message) =>
              (message.text ?? "").includes(input.sessionId),
            );
            if (already) return;

            const request = yield* HttpClientRequest.post(
              `${apiUrl}/api/chat.postMessage`,
              { headers },
            ).pipe(
              HttpClientRequest.bodyJson({
                channel: address.channel,
                thread_ts: address.rootTs,
                text: slackReply(config, input.sessionId),
              }),
              Effect.mapError(() =>
                fail("the reply body could not be encoded"),
              ),
            );
            const response = yield* http
              .execute(request)
              .pipe(
                Effect.mapError(() =>
                  fail(`Slack could not be reached for ${input.event.key}`),
                ),
              );
            if (response.status < 200 || response.status > 299) {
              return yield* fail(
                `Slack answered HTTP ${response.status} for ${input.event.key}`,
              );
            }
            const answer = yield* HttpClientResponse.schemaBodyJson(
              SlackAnswer,
            )(response).pipe(
              Effect.mapError(() =>
                fail(`Slack's answer for ${input.event.key} could not be read`),
              ),
            );
            if (!answer.ok) {
              return yield* slackFailure("posting the reply", answer);
            }
          }),
      });
    }),
  );
