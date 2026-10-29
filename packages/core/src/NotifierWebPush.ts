/**
 * The Web Push sink (F21): a notification as a push message to one browser, which the dashboard's
 * service worker shows as a system notification whose click opens the card.
 *
 * Web Push is two RFCs and no SDK is needed for them. The payload is encrypted for the one browser
 * that subscribed (RFC 8291, `aes128gcm`: an ECDH agreement with the subscription's P-256 key and
 * its auth secret, one record), and the request proves the sender is the application server the
 * subscription was made for with a VAPID JWT (RFC 8292: ES256 over the push service's origin, signed
 * by the deployment's private key). Both are `node:crypto` and a few dozen lines, and the RFC's own
 * test vector is the oracle (`NotifierWebPush.test.ts`).
 *
 * The deployment's VAPID key pair is `NOTIFY_VAPID_PUBLIC_KEY` / `NOTIFY_VAPID_PRIVATE_KEY` (base64url,
 * `generateVapidKeys` makes one); the private key is `Redacted` and never reaches a log, a ledger
 * row or a span. Tests and drives post to a loopback fake push service, never to a browser vendor's.
 *
 * **Where a subscription may point.** The endpoint is a URL a person supplied and this process will
 * `POST` to, so it must be `https:` — every browser vendor's push service is — unless the deployment
 * opts into plain `http:` for a loopback fake (`NOTIFY_PUSH_ALLOW_INSECURE`). A subscription whose
 * endpoint, key or secret is malformed is refused before it is stored, and again before it is sent to.
 */
import {
  createECDH,
  createHash,
  createCipheriv,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { DateTime, Effect, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  type Notification,
  type NotificationSink,
  NotifyError,
} from "./Notifier";

/** The deployment's application-server key pair and the contact a push service may reach. */
export type VapidConfig = {
  /** The uncompressed P-256 public key, base64url: what a browser subscribes with. */
  readonly publicKey: string;
  /** The private scalar, base64url. */
  readonly privateKey: Redacted.Redacted<string>;
  /** `mailto:` or `https:` — who to contact about this sender. */
  readonly subject: string;
};

/** What a browser's `PushSubscription.toJSON()` holds: where to push, and the keys to encrypt with. */
export type PushSubscriptionKeys = {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
};

const b64u = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A fresh VAPID key pair, as `NOTIFY_VAPID_PUBLIC_KEY` and `NOTIFY_VAPID_PRIVATE_KEY` take them. */
export const generateVapidKeys = (): {
  readonly publicKey: string;
  readonly privateKey: string;
} => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()),
    privateKey: b64u(ecdh.getPrivateKey()),
  };
};

/** Why a VAPID configuration is unusable, or `undefined` when it is a P-256 key pair. */
export const vapidProblem = (vapid: VapidConfig): string | undefined => {
  const publicKey = BASE64URL.test(vapid.publicKey)
    ? Buffer.from(vapid.publicKey, "base64url")
    : undefined;
  if (publicKey?.length !== 65 || publicKey[0] !== 4) {
    return "NOTIFY_VAPID_PUBLIC_KEY is not an uncompressed P-256 public key in base64url (65 bytes)";
  }
  const privateText = Redacted.value(vapid.privateKey);
  if (
    !BASE64URL.test(privateText) ||
    Buffer.from(privateText, "base64url").length !== 32
  ) {
    return "NOTIFY_VAPID_PRIVATE_KEY is not a P-256 private key in base64url (32 bytes)";
  }
  if (!/^(mailto:[^\s]+@[^\s]+|https:\/\/[^\s]+)$/.test(vapid.subject)) {
    return "NOTIFY_VAPID_SUBJECT must be a mailto: or https: URL";
  }
  const derived = createECDH("prime256v1");
  derived.setPrivateKey(Buffer.from(privateText, "base64url"));
  if (!derived.getPublicKey().equals(publicKey)) {
    return "NOTIFY_VAPID_PUBLIC_KEY is not the public half of NOTIFY_VAPID_PRIVATE_KEY";
  }
  return undefined;
};

/**
 * Why a subscription cannot be pushed to, or `undefined` when it can: an `https:` endpoint (`http:`
 * only when `allowInsecure`), a 65-byte P-256 `p256dh` and a 16-byte `auth`, both base64url.
 */
export const subscriptionProblem = (
  subscription: PushSubscriptionKeys,
  allowInsecure: boolean,
): string | undefined => {
  let url: URL;
  try {
    url = new URL(subscription.endpoint);
  } catch {
    return "the push endpoint is not a URL";
  }
  if (
    url.protocol !== "https:" &&
    !(allowInsecure && url.protocol === "http:")
  ) {
    return "the push endpoint must be an https: URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "the push endpoint must not carry a login";
  }
  const p256dh = BASE64URL.test(subscription.p256dh)
    ? Buffer.from(subscription.p256dh, "base64url")
    : undefined;
  if (p256dh?.length !== 65 || p256dh[0] !== 4) {
    return "p256dh is not an uncompressed P-256 public key in base64url (65 bytes)";
  }
  const auth = BASE64URL.test(subscription.auth)
    ? Buffer.from(subscription.auth, "base64url")
    : undefined;
  if (auth?.length !== 16) {
    return "auth is not a 16-byte secret in base64url";
  }
  return undefined;
};

/** What `encryptPayload` draws at random, fixed by a test to reproduce the RFC's vector. */
export type PushEntropy = {
  readonly ephemeralPrivate?: Buffer;
  readonly salt?: Buffer;
};

const RECORD_SIZE = 4096;

const hkdf = (
  salt: Buffer,
  ikm: Buffer,
  info: Buffer,
  length: number,
): Buffer => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * The request body of RFC 8291's `aes128gcm`: the header (salt, record size, the sender's ephemeral
 * public key) and one encrypted record holding `plaintext` and its `0x02` delimiter. The payload
 * must fit in one record, which a notification — clipped long before — always does.
 */
export const encryptPayload = (
  subscription: { readonly p256dh: string; readonly auth: string },
  plaintext: Uint8Array,
  entropy: PushEntropy = {},
): Buffer => {
  if (plaintext.length > RECORD_SIZE - 86 - 16 - 1) {
    throw new RangeError("a push payload must fit in one record");
  }
  const uaPublic = Buffer.from(subscription.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.auth, "base64url");
  const ephemeral = createECDH("prime256v1");
  if (entropy.ephemeralPrivate === undefined) ephemeral.generateKeys();
  else ephemeral.setPrivateKey(entropy.ephemeralPrivate);
  const asPublic = ephemeral.getPublicKey();
  const salt = entropy.salt ?? randomBytes(16);
  const shared = ephemeral.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(
    salt,
    ikm,
    Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
    16,
  );
  const nonce = hkdf(
    salt,
    ikm,
    Buffer.from("Content-Encoding: nonce\0", "utf8"),
    12,
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
};

const VAPID_LIFETIME_S = 12 * 60 * 60;

/** The `Authorization` header that proves this deployment is the sender (RFC 8292, `vapid` scheme). */
export const vapidAuthorization = (
  vapid: VapidConfig,
  endpoint: string,
  now: Date,
): string => {
  const publicKey = Buffer.from(vapid.publicKey, "base64url");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: Redacted.value(vapid.privateKey),
      x: b64u(publicKey.subarray(1, 33)),
      y: b64u(publicKey.subarray(33, 65)),
    },
    format: "jwk",
  });
  const header = b64u(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + VAPID_LIFETIME_S,
        sub: vapid.subject,
      }),
    ),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
};

/** The JSON the service worker reads: what to show, and where a click goes. */
export const pushPayload = (notification: Notification): Uint8Array =>
  Buffer.from(
    JSON.stringify({
      title: notification.title,
      body: notification.body,
      link: notification.link,
      kind: notification.kind,
      eventId: notification.eventId,
    }),
    "utf8",
  );

/** A short, stable, one-way name: the ledger key must not carry the endpoint, which is a capability. */
const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** How long a push service keeps a message for an offline browser. */
const PUSH_TTL_S = 24 * 60 * 60;

/**
 * One browser's subscription as a sink. A `404` or `410` is the push service saying the
 * subscription is gone; any other non-`2xx` is a failed send, and `429` is a rate limit. The label
 * names the push service's host and nothing of the capability URL.
 */
export const webPushSink = (options: {
  readonly vapid: VapidConfig;
  readonly subscription: PushSubscriptionKeys;
}): Effect.Effect<NotificationSink, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const { vapid, subscription } = options;
    const id = `push:${fingerprint(subscription.endpoint)}`;
    const host = new URL(subscription.endpoint).host;
    const fail = (message: string, rateLimited = false) =>
      new NotifyError({
        sink: id,
        message,
        ...(rateLimited ? { rateLimited: true } : {}),
      });
    return {
      id,
      label: `a Web Push subscription at ${host}`,
      send: (notification) =>
        Effect.gen(function* () {
          const body = yield* Effect.try({
            try: () => encryptPayload(subscription, pushPayload(notification)),
            catch: () =>
              fail(
                `${notification.eventId}: the payload could not be encrypted`,
              ),
          });
          const now = yield* DateTime.nowAsDate;
          const request = HttpClientRequest.post(subscription.endpoint, {
            headers: {
              authorization: vapidAuthorization(
                vapid,
                subscription.endpoint,
                now,
              ),
              "content-encoding": "aes128gcm",
              ttl: String(PUSH_TTL_S),
              urgency: "normal",
            },
          }).pipe(
            HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
          );
          const response = yield* http
            .execute(request)
            .pipe(
              Effect.mapError(() =>
                fail(
                  `${notification.eventId}: the push service could not be reached`,
                ),
              ),
            );
          if (response.status >= 200 && response.status <= 299) return;
          if (response.status === 404 || response.status === 410) {
            return yield* fail(
              `${notification.eventId}: the push service says the subscription is gone (HTTP ${response.status})`,
            );
          }
          return yield* fail(
            `${notification.eventId}: the push service answered HTTP ${response.status}`,
            response.status === 429,
          );
        }),
    };
  });
