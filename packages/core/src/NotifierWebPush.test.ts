/**
 * The Web Push sink (F21): RFC 8291's own test vector as the oracle for the encryption, a VAPID JWT
 * verified with the public key, and the sink over a real loopback HTTP exchange with a fake push
 * service whose "browser" holds the subscription's private key and decrypts what arrives. No browser
 * vendor's push service is called.
 */
import { createPublicKey, verify } from "node:crypto";
import { DateTime, Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";
import {
  encryptPayload,
  generateVapidKeys,
  pushPayload,
  subscriptionProblem,
  type VapidConfig,
  vapidAuthorization,
  vapidProblem,
  webPushSink,
} from "./NotifierWebPush";
import type { Notification } from "./Notifier";
import {
  decryptPayload,
  type FakePush,
  makeSubscription,
  startFakePush,
} from "./webpush.test-fake";

const notification: Notification = {
  eventId: "failed:ses_abc:9",
  kind: "failed",
  title: 'Run stopped by its budget on "Fix the login page"',
  body: "budget reached\nacme/widget",
  link: "http://dash.test/boards/brd_1?card=tsk_1&run=ses_abc",
};

const vapidOf = (subject = "mailto:ops@example.test"): VapidConfig => {
  const keys = generateVapidKeys();
  return {
    publicKey: keys.publicKey,
    privateKey: Redacted.make(keys.privateKey),
    subject,
  };
};

describe("the payload's encryption", () => {
  // RFC 8291 Appendix A, with the RFC's ephemeral key and salt fixed.
  it("reproduces the RFC's test vector byte for byte", () => {
    const body = encryptPayload(
      {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        ephemeralPrivate: Buffer.from(
          "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
          "base64url",
        ),
        salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
      },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("is read back by the subscription's own key, and by no other", () => {
    const mine = makeSubscription("https://push.example.test/a");
    const theirs = makeSubscription("https://push.example.test/b");
    const body = encryptPayload(mine, Buffer.from("hello, ünicode"));
    expect(decryptPayload(mine, body).toString("utf8")).toBe("hello, ünicode");
    expect(() => decryptPayload(theirs, body)).toThrow();
    // Two messages to one browser differ: a fresh ephemeral key and salt each time.
    expect(
      encryptPayload(mine, Buffer.from("x")).equals(
        encryptPayload(mine, Buffer.from("x")),
      ),
    ).toBe(false);
    // A flipped bit anywhere in the record is refused by the authentication tag.
    const tampered = Buffer.from(body);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 1;
    expect(() => decryptPayload(mine, tampered)).toThrow();
  });

  it("refuses a payload that does not fit in one record", () => {
    const sub = makeSubscription("https://push.example.test/a");
    expect(() => encryptPayload(sub, Buffer.alloc(4000))).toThrow(RangeError);
  });
});

describe("the VAPID authorization", () => {
  it("is an ES256 JWT over the push service's origin that the public key verifies", () => {
    const vapid = vapidOf();
    const now = DateTime.toDateUtc(
      DateTime.makeUnsafe("2026-10-29T10:00:00.000Z"),
    );
    const header = vapidAuthorization(
      vapid,
      "https://push.example.test/send/abc?x=1",
      now,
    );
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
      header,
    );
    expect(match).not.toBeNull();
    const [, head = "", claims = "", signature = "", key = ""] = match ?? [];
    expect(key).toBe(vapid.publicKey);
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(decoded).toEqual({
      aud: "https://push.example.test",
      exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
      sub: "mailto:ops@example.test",
    });
    const publicKey = Buffer.from(vapid.publicKey, "base64url");
    const verified = verify(
      "sha256",
      Buffer.from(`${head}.${claims}`),
      {
        key: createPublicKey({
          key: {
            kty: "EC",
            crv: "P-256",
            x: publicKey.subarray(1, 33).toString("base64url"),
            y: publicKey.subarray(33, 65).toString("base64url"),
          },
          format: "jwk",
        }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    );
    expect(verified).toBe(true);
    // The private key is not in what is sent.
    expect(header).not.toContain(Redacted.value(vapid.privateKey));
  });

  it("accepts every generated key pair, including a private key with a leading zero byte", () => {
    // One P-256 private key in 256 starts with a zero byte; 2000 pairs miss one with odds of about 0.04%.
    for (let i = 0; i < 2000; i++)
      expect(vapidProblem(vapidOf())).toBeUndefined();
  });

  it("is refused for a key pair that is not a pair, and for a subject that is not a contact", () => {
    const a = vapidOf();
    const b = vapidOf();
    expect(vapidProblem(a)).toBeUndefined();
    expect(vapidProblem({ ...a, privateKey: b.privateKey })).toContain(
      "public half",
    );
    expect(vapidProblem({ ...a, subject: "ops@example.test" })).toContain(
      "NOTIFY_VAPID_SUBJECT",
    );
    expect(vapidProblem({ ...a, publicKey: "short" })).toContain(
      "NOTIFY_VAPID_PUBLIC_KEY",
    );
    expect(vapidProblem({ ...a, privateKey: Redacted.make("!!") })).toContain(
      "NOTIFY_VAPID_PRIVATE_KEY",
    );
  });
});

describe("what a subscription may be", () => {
  const good = makeSubscription("https://fcm.example.test/send/abc");
  const keys = { p256dh: good.p256dh, auth: good.auth };

  it("is an https endpoint with a P-256 key and a 16-byte secret", () => {
    expect(
      subscriptionProblem({ endpoint: good.endpoint, ...keys }, false),
    ).toBeUndefined();
    expect(
      subscriptionProblem({ endpoint: "http://127.0.0.1:1/x", ...keys }, false),
    ).toContain("https");
    expect(
      subscriptionProblem({ endpoint: "http://127.0.0.1:1/x", ...keys }, true),
    ).toBeUndefined();
    expect(
      subscriptionProblem({ endpoint: "file:///etc/passwd", ...keys }, true),
    ).toContain("https");
    expect(
      subscriptionProblem({ endpoint: "not a url", ...keys }, true),
    ).toContain("not a URL");
    expect(
      subscriptionProblem(
        { endpoint: "https://u:p@push.example.test/x", ...keys },
        false,
      ),
    ).toContain("login");
    expect(
      subscriptionProblem(
        { endpoint: good.endpoint, p256dh: "AAAA", auth: good.auth },
        false,
      ),
    ).toContain("p256dh");
    expect(
      subscriptionProblem(
        { endpoint: good.endpoint, p256dh: good.p256dh, auth: "AAAA" },
        false,
      ),
    ).toContain("auth");
  });
});

describe("where a subscription may point", () => {
  const keys = makeSubscription("https://push.example.test/x");
  const problem = (endpoint: string, allowInsecure = false) =>
    subscriptionProblem(
      { endpoint, p256dh: keys.p256dh, auth: keys.auth },
      allowInsecure,
    );

  it("refuses loopback, private, link-local and local-name hosts, however they are written", () => {
    for (const endpoint of [
      "https://127.0.0.1/x",
      "https://127.1.2.3:8443/x",
      "https://localhost/x",
      "https://app.localhost/x",
      "https://10.1.2.3/x",
      "https://172.16.0.1/x",
      "https://172.31.255.255/x",
      "https://192.168.0.10/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/x",
      "https://0.0.0.0/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[fe80::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://db.internal/x",
      "https://printer.local/x",
      "https://2130706433/x",
    ]) {
      expect(problem(endpoint), endpoint).toContain("public host");
    }
  });

  it("accepts a public host, and an internal one only when the deployment opts in", () => {
    expect(problem("https://fcm.googleapis.com/fcm/send/abc")).toBeUndefined();
    expect(problem("https://172.32.0.1/x")).toBeUndefined();
    expect(problem("https://192.169.0.1/x")).toBeUndefined();
    expect(problem("https://127.0.0.1/x", true)).toBeUndefined();
    expect(problem("http://127.0.0.1:9/x", true)).toBeUndefined();
  });
});

describe("the sink over a push service", () => {
  let push: FakePush | undefined;
  afterEach(async () => {
    await push?.close();
    push = undefined;
  });

  const sinkFor = async (service: FakePush, vapid: VapidConfig) => {
    const subscription = makeSubscription(
      `${service.origin}/push/send/abc123secret`,
    );
    const sink = await Effect.runPromise(
      webPushSink({ vapid, subscription }).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    return { sink, subscription };
  };

  it("posts one encrypted, signed message that the browser reads whole", async () => {
    push = await startFakePush();
    const vapid = vapidOf();
    const { sink, subscription } = await sinkFor(push, vapid);
    await Effect.runPromise(sink.send(notification));
    expect(push.received).toHaveLength(1);
    const [received] = push.received;
    expect(received?.path).toBe("/push/send/abc123secret");
    expect(received?.headers["content-encoding"]).toBe("aes128gcm");
    expect(received?.headers["content-type"]).toBe("application/octet-stream");
    expect(received?.headers["ttl"]).toBe("86400");
    expect(received?.headers["authorization"]).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`),
    );
    expect(
      JSON.parse(
        decryptPayload(
          subscription,
          received?.body ?? Buffer.alloc(0),
        ).toString("utf8"),
      ),
    ).toEqual({
      title: notification.title,
      body: notification.body,
      link: notification.link,
      kind: "failed",
      eventId: notification.eventId,
    });
    expect(
      JSON.parse(Buffer.from(pushPayload(notification)).toString()),
    ).toMatchObject({ link: notification.link });
  });

  it("names the push service's host and nothing of the capability URL", async () => {
    push = await startFakePush();
    const { sink } = await sinkFor(push, vapidOf());
    expect(sink.label).toBe(
      `a Web Push subscription at ${new URL(push.origin).host}`,
    );
    expect(sink.id).toMatch(/^push:[0-9a-f]{16}$/);
    expect(sink.id + sink.label).not.toContain("abc123secret");
  });

  it("a gone subscription, a failing service and a rate limit are each a NotifyError that names the status, not the endpoint", async () => {
    push = await startFakePush();
    const { sink } = await sinkFor(push, vapidOf());
    const failure = async (status: number) => {
      if (push !== undefined) push.status = status;
      return await Effect.runPromise(Effect.flip(sink.send(notification)));
    };
    const gone = await failure(410);
    expect(gone.message).toContain("gone");
    expect(gone.message).toContain("410");
    expect(gone.message).not.toContain("abc123secret");
    expect(gone.gone).toBe(true);
    const missing = await failure(404);
    expect(missing.message).toContain("gone");
    expect(missing.gone).toBe(true);
    const broken = await failure(500);
    expect(broken.message).toContain("HTTP 500");
    expect(broken.rateLimited).toBeUndefined();
    expect(broken.gone).toBeUndefined();
    expect((await failure(429)).rateLimited).toBe(true);
  });

  it("never follows a redirect: a 307 to another address is a failed send and the target is not reached", async () => {
    push = await startFakePush();
    const internal = await startFakePush();
    try {
      push.redirectTo = `${internal.origin}/admin`;
      const { sink } = await sinkFor(push, vapidOf());
      const failure = await Effect.runPromise(
        Effect.flip(sink.send(notification)),
      );
      expect(failure.message).toContain("HTTP 307");
      expect(push.received).toHaveLength(1);
      expect(internal.received).toHaveLength(0);
    } finally {
      await internal.close();
    }
  });

  it("an unreachable service is a NotifyError", async () => {
    push = await startFakePush();
    const { sink } = await sinkFor(push, vapidOf());
    await push.close();
    const exit = await Effect.runPromiseExit(sink.send(notification));
    expect(String(exit)).toContain("could not be reached");
  });
});
