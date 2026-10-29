/**
 * A person's own notification sinks (F21): what the settings service accepts and refuses before it
 * writes, that a sink is its actor's alone, and what the notifier reads back from the table — only
 * the enabled rows, each as the sink its type names, keyed by owner.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Every actor is random, and the
 * rows are deleted after; the per-kind toggles are not touched here (the routing cases and the RPC
 * suite's scratch database own those).
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import type { Notification } from "./Notifier";
import type { Mail } from "./NotifierEmail";
import { generateVapidKeys } from "./NotifierWebPush";
import {
  makeNotifySettings,
  MAX_SINKS_PER_ACTOR,
  type NotifyChannels,
  personalSinkOf,
  storedPeople,
} from "./NotifySettings";
import { makeSubscription } from "./webpush.test-fake";

const runtime = ManagedRuntime.make(
  Layer.mergeAll(DatabaseLive, FetchHttpClient.layer),
);

const actors: string[] = [];
const actor = (name: string) => {
  const made = `person:${name}-${randomBytes(4).toString("hex")}`;
  actors.push(made);
  return made;
};

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      if (actors.length > 0) {
        yield* sql`DELETE FROM notification_sinks WHERE actor IN ${sql.in(actors)}`;
      }
    }),
  );
  await runtime.dispose();
});

const sent: Mail[] = [];
const keys = generateVapidKeys();
const mail = {
  from: "factory@example.test",
  transport: (m: Mail) =>
    Effect.sync(() => {
      sent.push(m);
    }),
};
const vapid = {
  publicKey: keys.publicKey,
  privateKey: Redacted.make(keys.privateKey),
  subject: "mailto:ops@example.test",
};
const channels: NotifyChannels = {
  email: mail,
  vapid,
  allowInsecurePush: false,
};

const settings = (over: NotifyChannels = channels) =>
  makeNotifySettings({
    defaultKinds: new Set(["question"]),
    shared: ["a Slack incoming webhook"],
    channels: over,
  });

const email = (address: string) => ({ type: "email" as const, address });
const push = (endpoint: string) => {
  const { p256dh, auth } = makeSubscription(endpoint);
  return { type: "web_push" as const, endpoint, p256dh, auth };
};

describe("adding a sink", () => {
  it("stores an address for its actor, lists it back, and lists it for nobody else", async () => {
    const amy = actor("amy");
    const bob = actor("bob");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        const added = yield* service.addSink(amy, email(" Amy@Example.test "));
        return {
          added,
          amys: yield* service.get(amy),
          bobs: yield* service.get(bob),
        };
      }),
    );
    expect(result.added).toMatchObject({
      type: "email",
      label: "Amy@Example.test",
      enabled: true,
    });
    expect(result.added.id).toMatch(/^nsk_[0-9a-f]{20}$/);
    expect(result.amys.sinks).toEqual([result.added]);
    expect(result.bobs.sinks).toEqual([]);
    expect(result.amys.channels).toEqual({
      email: true,
      webPush: { configured: true, publicKey: keys.publicKey },
      shared: ["a Slack incoming webhook"],
    });
  });

  it("stores a push subscription and answers only the push service's host, never the endpoint or keys", async () => {
    const amy = actor("amy");
    const subscription = push(
      "https://push.example.test/send/very-secret-token",
    );
    const summary = await runtime.runPromise(
      Effect.flatMap(settings(), (service) =>
        service.addSink(amy, subscription),
      ),
    );
    expect(summary).toMatchObject({
      type: "web_push",
      label: "push.example.test",
    });
    const wire = JSON.stringify(summary);
    expect(wire).not.toContain("very-secret-token");
    expect(wire).not.toContain(subscription.p256dh);
    expect(wire).not.toContain(subscription.auth);
  });

  it("refuses a malformed address, an http endpoint and bad keys, writing nothing", async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        const failures = yield* Effect.forEach(
          [
            email("not an address"),
            email("amy@example.test\r\nBcc: x@y.test"),
            push("http://push.example.test/x"),
            { ...push("https://push.example.test/x"), p256dh: "AAAA" },
            { ...push("https://push.example.test/x"), auth: "AAAA" },
          ],
          (destination) => Effect.flip(service.addSink(amy, destination)),
        );
        return { failures, after: yield* service.get(amy) };
      }),
    );
    expect(result.failures.map((failure) => failure._tag)).toEqual(
      Array.from({ length: 5 }, () => "InvalidNotificationSink"),
    );
    for (const failure of result.failures) {
      expect(failure.message).toContain("nothing was stored");
    }
    expect(result.after.sinks).toEqual([]);
  });

  it("accepts an http push endpoint only when the deployment opts in", async () => {
    const amy = actor("amy");
    const added = await runtime.runPromise(
      Effect.flatMap(
        settings({ ...channels, allowInsecurePush: true }),
        (service) => service.addSink(amy, push("http://127.0.0.1:9/push")),
      ),
    );
    expect(added.label).toBe("127.0.0.1:9");
  });

  it("refuses a type this control plane cannot send", async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const noMail = yield* settings({
          vapid,
          allowInsecurePush: false,
        });
        const noPush = yield* settings({
          email: mail,
          allowInsecurePush: false,
        });
        return {
          mail: yield* Effect.flip(
            noMail.addSink(amy, email("amy@example.test")),
          ),
          push: yield* Effect.flip(
            noPush.addSink(amy, push("https://push.example.test/x")),
          ),
          offered: (yield* noMail.get(amy)).channels.email,
        };
      }),
    );
    expect(result.mail).toMatchObject({
      _tag: "NotificationChannelUnavailable",
      channel: "email",
    });
    expect(result.push).toMatchObject({
      _tag: "NotificationChannelUnavailable",
      channel: "web_push",
    });
    expect(result.offered).toBe(false);
  });

  it("is idempotent: the same address again, in any case, is the same sink turned back on", async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        const first = yield* service.addSink(amy, email("amy@example.test"));
        yield* service.setSinkEnabled(amy, first.id, false);
        const again = yield* service.addSink(amy, email("AMY@example.test"));
        return { first, again, all: (yield* service.get(amy)).sinks };
      }),
    );
    expect(result.again.id).toBe(result.first.id);
    expect(result.again.enabled).toBe(true);
    expect(result.all).toHaveLength(1);
  });

  it(`keeps a person to ${MAX_SINKS_PER_ACTOR} sinks`, async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        for (let n = 0; n < MAX_SINKS_PER_ACTOR; n += 1) {
          yield* service.addSink(amy, email(`amy${n}@example.test`));
        }
        return yield* Effect.flip(
          service.addSink(amy, email("one-more@example.test")),
        );
      }),
    );
    expect(result._tag).toBe("InvalidNotificationSink");
    expect(result.message).toContain("remove one first");
  });
});

describe("a sink is its actor's alone", () => {
  it("another person cannot pause or remove it, and is told what a missing id says", async () => {
    const amy = actor("amy");
    const mallory = actor("mallory");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        const sink = yield* service.addSink(amy, email("amy@example.test"));
        const pause = yield* Effect.flip(
          service.setSinkEnabled(mallory, sink.id, false),
        );
        const remove = yield* Effect.flip(service.removeSink(mallory, sink.id));
        const missing = yield* Effect.flip(
          service.removeSink(mallory, "nsk_missing"),
        );
        return {
          sink,
          pause,
          remove,
          missing,
          kept: (yield* service.get(amy)).sinks,
        };
      }),
    );
    expect(result.pause._tag).toBe("NotificationSinkNotFound");
    expect(result.remove._tag).toBe("NotificationSinkNotFound");
    expect(result.remove.message).toBe(
      result.missing.message.replace("nsk_missing", result.sink.id),
    );
    expect(result.kept).toEqual([result.sink]);
  });

  it("pauses, resumes and removes its own", async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        const sink = yield* service.addSink(amy, email("amy@example.test"));
        const paused = yield* service.setSinkEnabled(amy, sink.id, false);
        const resumed = yield* service.setSinkEnabled(amy, sink.id, true);
        const removed = yield* service.removeSink(amy, sink.id);
        return {
          paused,
          resumed,
          removed,
          left: (yield* service.get(amy)).sinks,
        };
      }),
    );
    expect([result.paused.enabled, result.resumed.enabled]).toEqual([
      false,
      true,
    ]);
    expect(result.removed.id).toBe(result.paused.id);
    expect(result.left).toEqual([]);
  });
});

const notification: Notification = {
  eventId: "approval:ses_x:req-1",
  kind: "approval",
  title: "Approval needed",
  body: "bash: ls",
  link: "http://dash.test/x",
};

describe("what the notifier reads back", () => {
  it("is each enabled sink as the sink its type names, by owner, and not a paused one", async () => {
    const amy = actor("amy");
    const bob = actor("bob");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        const build = yield* personalSinkOf(channels);
        yield* service.addSink(amy, email("amy@example.test"));
        yield* service.addSink(amy, push("https://push.example.test/amy"));
        const paused = yield* service.addSink(bob, email("bob@example.test"));
        yield* service.setSinkEnabled(bob, paused.id, false);
        const everyone = yield* storedPeople(build);
        return { amy: everyone.get(amy), bob: everyone.get(bob) };
      }),
    );
    expect(result.amy?.map((sink) => sink.id.split(":")[0])).toEqual([
      "email",
      "push",
    ]);
    expect(result.bob).toBeUndefined();
    // The email sink sends through the deployment's transport, to the stored address.
    await runtime.runPromise(
      result.amy?.[0]?.send(notification) ?? Effect.void,
    );
    expect(sent.at(-1)).toMatchObject({
      from: "factory@example.test",
      to: "amy@example.test",
      subject: "Approval needed",
    });
  });

  it("leaves out a row this deployment can no longer send to, without failing the read", async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* settings();
        yield* service.addSink(amy, email("amy@example.test"));
        yield* service.addSink(amy, push("https://push.example.test/amy"));
        // The same rows, read by a deployment whose SMTP server and VAPID key are gone.
        const build = yield* personalSinkOf({ allowInsecurePush: false });
        return (yield* storedPeople(build)).get(amy);
      }),
    );
    expect(result).toBeUndefined();
  });

  it("refuses to build a stored push sink whose endpoint is no longer an allowed one", async () => {
    const amy = actor("amy");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        // Stored while the deployment allowed http, read after it stopped.
        const open = yield* settings({ ...channels, allowInsecurePush: true });
        yield* open.addSink(amy, push("http://127.0.0.1:9/push"));
        const build = yield* personalSinkOf(channels);
        const rows = yield* sql<{
          readonly type: string;
          readonly config: string;
        }>`
          SELECT type, config::text AS config FROM notification_sinks WHERE actor = ${amy}
        `;
        const [row] = rows;
        if (row === undefined)
          return yield* Effect.die("the case stored no row");
        return yield* build(row);
      }),
    );
    expect(Option.isNone(result)).toBe(true);
  });
});
