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
import { SqlClient } from "effect/sql/SqlClient";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionId } from "@repo/domain/Session";
import {
  TRIGGER_ACTION,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
} from "@repo/domain/Trigger";
import { pullRequestReport, SessionWriteBack } from "./SessionWriteBack";
import { deliveryIdOfSession, TriggerWriteBack } from "./TriggerService";

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

/** Every Slack delivery's request id starts here; the rest is the message's address. */
const SLACK_ID_PREFIX = "slack:";

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
 * The answer to Slack's `url_verification` handshake, or `undefined` for any other payload.
 *
 * Slack sends `{type: "url_verification", challenge}` — signed like every delivery — when an operator
 * enters the Request URL, and expects the challenge echoed back before it will deliver events at all.
 * It is answered from the signing secret alone: the handshake happens before an app is installed, so
 * before there is a bot token or a channel list to wait for.
 */
export const slackUrlVerification = (
  payload: unknown,
): { readonly challenge: string } | undefined => {
  const body = asRecord(payload);
  if (stringField(body, "type") !== "url_verification") return undefined;
  const challenge = stringField(body, "challenge");
  return challenge === undefined ? undefined : { challenge };
};

/**
 * A Slack Events API payload, normalized.
 *
 * `undefined` is "this payload carries no event to judge": Slack's `url_verification` handshake, a
 * payload that is not an `event_callback`, or one with no `event`. Everything else becomes a
 * `TriggerEvent` whose `action` says what will happen to it:
 *
 * - a `message` or an `app_mention` that passes the filter is `create` — the only action the seam
 *   starts work on. An `@factory` mention is the same ask as a message in a watched channel, and
 *   Slack delivers a mention in a watched channel as both events with one `ts`, which is one message
 *   address and so one delivery (`slackRequestId`);
 * - one the filter rejects keeps a `filtered:<why>` action, so the skip the seam records names the
 *   reason (`filtered:channel`, `filtered:text`, `filtered:bot`, `filtered:subtype:…`);
 * - any other event type keeps Slack's own name (`reaction_added`, …), so the recorded reason reads
 *   as the event that arrived rather than a word invented here.
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
  if (
    (type !== "message" && type !== "app_mention") ||
    channel === undefined ||
    ts === undefined
  ) {
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
  `${SLACK_ID_PREFIX}${event.key}`;

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
 * The filter an environment names: the comma-separated channels and the optional phrase. Separate
 * from `slackConfigFromEnv` because the route needs a filter whether or not the bot token that lets
 * the app reply is configured: a deployment with no token still starts sessions, it just posts
 * nothing back.
 */
export const slackFilterFromEnv = (
  env: Pick<SlackEnv, "channels" | "text">,
): SlackFilter => {
  const channels = (env.channels ?? "")
    .split(",")
    .map((channel) => channel.trim())
    .filter((channel) => channel !== "");
  const text = env.text?.trim();
  return {
    channels,
    ...(text === undefined || text === "" ? {} : { text }),
  };
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
  const filter = slackFilterFromEnv(env);
  if (filter.channels.length === 0) return undefined;
  const apiUrl = env.apiUrl?.trim();
  const sessionUrlBase = env.sessionUrlBase?.trim();
  return {
    config: {
      ...(apiUrl ? { apiUrl: apiUrl.replace(/\/+$/, "") } : {}),
      botToken: Redacted.make(botToken),
      ...(sessionUrlBase ? { sessionUrlBase } : {}),
    },
    signingSecret: Redacted.make(signingSecret),
    filter,
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

const writeBackError = (message: string): TriggerError =>
  new TriggerError({ code: "write-back", message });

/**
 * One reply in a message's thread, posted once.
 *
 * `chat.postMessage` with the channel and the thread root is the reply: `{channel, thread_ts, text}`
 * with the bot token as `Bearer`, and Slack answers `{ok: true, ts}`. Anything else — an
 * unreachable API, a refused token, a body that cannot be encoded, or Slack's own
 * `{ok: false, error}` on an HTTP `200` — is a `write-back` `TriggerError`.
 *
 * **It reads the thread before it replies.** A caller that retries (the seam gives a failed
 * delivery's claim back; the PR step's report is repeated by the caller's retry of the step) would
 * otherwise answer a message twice whenever the reply landed and its acknowledgement did not. A
 * reply that already carries `marker` — the session id for the session's link, the PR's URL for the
 * PR's — is the record the retry looks for, exactly as on Jira (`Jira.ts`) and GitHub
 * (`GitHub.ts`). The read is Slack's default page of a thread (100 messages); a longer thread is the
 * one shape this check cannot see, which `docs/testing-third-parties.md` records.
 */
const threadReplier = (config: SlackConfig) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const apiUrl = (config.apiUrl ?? "https://slack.com").replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${Redacted.value(config.botToken)}`,
    };

    /** Slack's own error name when it refused on an HTTP 200. */
    const slackFailure = (
      what: string,
      body: { readonly error?: string | undefined },
    ): TriggerError =>
      writeBackError(
        `${what}: Slack answered ok=false${body.error === undefined ? "" : ` (${body.error})`}`,
      );

    return (input: {
      /** The message's address, for the errors: what the reply was for. */
      readonly key: string;
      readonly address: NonNullable<ReturnType<typeof parseSlackAddress>>;
      readonly marker: string;
      readonly text: string;
    }): Effect.Effect<void, TriggerError> =>
      Effect.gen(function* () {
        const { address, key } = input;
        const repliesUrl = `${apiUrl}/api/conversations.replies?channel=${encodeURIComponent(address.channel)}&ts=${encodeURIComponent(address.rootTs)}`;
        const replies = yield* http
          .execute(HttpClientRequest.get(repliesUrl, { headers }))
          .pipe(
            Effect.mapError(() =>
              writeBackError(`Slack could not be read for ${key}`),
            ),
          );
        if (replies.status < 200 || replies.status > 299) {
          return yield* writeBackError(
            `Slack answered HTTP ${replies.status} reading ${key}'s thread`,
          );
        }
        const page = yield* HttpClientResponse.schemaBodyJson(SlackReplies)(
          replies,
        ).pipe(
          Effect.mapError(() =>
            writeBackError(`Slack's thread for ${key} could not be read`),
          ),
        );
        if (!page.ok) return yield* slackFailure("reading the thread", page);
        const already = (page.messages ?? []).some((message) =>
          (message.text ?? "").includes(input.marker),
        );
        if (already) return;

        const request = yield* HttpClientRequest.post(
          `${apiUrl}/api/chat.postMessage`,
          { headers },
        ).pipe(
          HttpClientRequest.bodyJson({
            channel: address.channel,
            thread_ts: address.rootTs,
            text: input.text,
          }),
          Effect.mapError(() =>
            writeBackError("the reply body could not be encoded"),
          ),
        );
        const response = yield* http
          .execute(request)
          .pipe(
            Effect.mapError(() =>
              writeBackError(`Slack could not be reached for ${key}`),
            ),
          );
        if (response.status < 200 || response.status > 299) {
          return yield* writeBackError(
            `Slack answered HTTP ${response.status} for ${key}`,
          );
        }
        const answer = yield* HttpClientResponse.schemaBodyJson(SlackAnswer)(
          response,
        ).pipe(
          Effect.mapError(() =>
            writeBackError(`Slack's answer for ${key} could not be read`),
          ),
        );
        if (!answer.ok) return yield* slackFailure("posting the reply", answer);
      });
  });

/**
 * The seam's write-back port, filled by Slack's Web API: the session's link, in the thread of the
 * message that started it. A failed reply fails the delivery, which gives the claim back so the
 * sender's retry runs the work (`threadReplier` makes that retry post nothing twice).
 */
export const SlackWriteBack = (
  config: SlackConfig,
): Layer.Layer<TriggerWriteBack, never, HttpClient.HttpClient> =>
  Layer.effect(
    TriggerWriteBack,
    Effect.gen(function* () {
      const reply = yield* threadReplier(config);
      return TriggerWriteBack.of({
        write: (input) => {
          const address = parseSlackAddress(input.event.key);
          if (address === undefined) {
            return Effect.fail(
              writeBackError(
                `the payload for ${input.event.key} names no channel and message to reply to`,
              ),
            );
          }
          return reply({
            key: input.event.key,
            address,
            marker: input.sessionId,
            text: slackReply(config, input.sessionId),
          });
        },
      });
    }),
  );

/** The PR's reply: its number and link, in the thread of the message that asked for the work. */
export const slackPullRequestReply = (pr: {
  readonly number: number;
  readonly url: string;
}): string =>
  `Factory opened pull request #${pr.number} for this message: ${pr.url}`;

/**
 * The session layer's write-back, filled by Slack: when the PR step opens a pull request for a
 * session a Slack message started, the PR's link is posted in that message's thread (LOB-259).
 *
 * The message is found the way the Linear write-back finds its issue: the session's own request id
 * is `trigger:slack:<channel>:<root>:<message>`, written by the seam when the delivery opened it, so
 * the binding needs no table of its own. A session no Slack message opened is not reported, and
 * neither is a step that opened no PR (a refusal says nothing a thread was promised).
 *
 * It cannot fail the step (`SessionWriteBack`): a Slack that is down is logged, and the caller's
 * retry of the step — which answers `already-open` and reports again — finds the reply missing and
 * posts it, because `threadReplier` posts a reply only once per PR link.
 *
 * Its output type reads `never`, as `LinearSessionWriteBack`'s does: a `Context.Reference` key
 * carries no identifier type.
 */
export const SlackSessionWriteBack = (
  config: SlackConfig,
): Layer.Layer<never, never, HttpClient.HttpClient | SqlClient> =>
  Layer.effect(
    SessionWriteBack,
    Effect.gen(function* () {
      const reply = yield* threadReplier(config);
      const sql = yield* SqlClient;
      return {
        pullRequest: (input) =>
          Effect.gen(function* () {
            const report = pullRequestReport(input.result);
            if (report._tag !== "opened") return;
            const rows = yield* sql<{ readonly requestId: string | null }>`
              SELECT request_id FROM sessions WHERE id = ${input.sessionId}
            `;
            const delivery = deliveryIdOfSession(rows[0]?.requestId);
            if (
              delivery === undefined ||
              !delivery.startsWith(SLACK_ID_PREFIX)
            ) {
              return;
            }
            const key = delivery.slice(SLACK_ID_PREFIX.length);
            const address = parseSlackAddress(key);
            if (address === undefined) return;
            yield* reply({
              key,
              address,
              marker: report.pr.url,
              text: slackPullRequestReply(report.pr),
            });
          }).pipe(
            Effect.catchTags({
              TriggerError: (error) =>
                Effect.logError(
                  `slack: could not post ${input.sessionId}'s pull request in its thread: ${error.message}`,
                ),
              SqlError: (error) =>
                Effect.logError(
                  `slack: could not read ${input.sessionId}'s request id: ${error.message}`,
                ),
            }),
          ),
      };
    }),
  );
