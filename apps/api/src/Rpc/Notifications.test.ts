/**
 * Notification settings over the wire (F21): `getNotificationSettings`, `setNotificationKind`,
 * `addNotificationSink`, `setNotificationSinkEnabled` and `removeNotificationSink`, served by the
 * app's own `SessionRpcLive` through `HttpRouter.toWebHandler` and called with the `RpcClient` over
 * NDJSON, as the dashboard's settings page calls them. Two credentials, two actors, so "a sink is its
 * actor's alone" is asserted across a real authentication boundary; every response body is kept as
 * text, so "no answer carries a push endpoint or key" is asserted on bytes, not on a decoded shape.
 *
 * The database is this file's own, created on the server `DATABASE_URL` names and dropped in
 * `afterAll` — the kind toggles are global, so they must not be the development database's. The
 * deployment's configuration (an SMTP server, a VAPID key pair) is this file's own, set before the
 * layer reads it, and points at nothing: no message is sent here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialError,
  CredentialProvider,
  generateVapidKeys,
  SessionServiceLive,
} from "@repo/core";
import { RpcApi } from "@repo/domain/Rpc";
import { createFauxModelAccess, FAUX_MODEL_ID } from "@repo/harness";
import {
  DatabaseConfig,
  DatabaseLive,
  PostgresLive,
} from "@repo/storage-postgres";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { controlPlaneAuthLayer } from "./Auth";
import { sendingToken, testTokens } from "./Auth.test-fake";
import { SessionRpcLive } from "./Session";
import { FauxServerFacts } from "../ServerInfo.test-fake";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-notify-"));
const run = randomBytes(4).toString("hex");
const ALICE_TOKEN = `alice-token-${run}-0123456789`;
const BOB_TOKEN = `bob-token-${run}-0123456789`;

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_notify_${run}`;
const keys = generateVapidKeys();
{
  const configured = new URL(
    Redacted.value((await admin.runPromise(DatabaseConfig)).url),
  );
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`CREATE DATABASE ${sql(scratchName)}`;
    }),
  );
  configured.pathname = `/${scratchName}`;
  /* oxlint-disable effecttsgo/process-env -- a test harness sets up its own process. */
  process.env["DATABASE_URL"] = configured.toString();
  process.env["NOTIFY_SMTP_URL"] = "smtp://127.0.0.1:1";
  process.env["NOTIFY_SMTP_FROM"] = "factory@example.test";
  process.env["NOTIFY_VAPID_PUBLIC_KEY"] = keys.publicKey;
  process.env["NOTIFY_VAPID_PRIVATE_KEY"] = keys.privateKey;
  /* oxlint-enable effecttsgo/process-env */
}

/** See `./Secrets.test.ts`: the default provider caches the first `process.env` it reads. */
const ScratchConfig = ConfigProvider.layer(ConfigProvider.fromEnv());

const model = createFauxModelAccess({ fauxModels: [FAUX_MODEL_ID] }).access;
const credentials = CredentialProvider.of({
  source: "static-token",
  tokenFor: (asked) =>
    Effect.fail(
      new CredentialError({
        repo: asked,
        code: "missing",
        message: "no token in this file",
      }),
    ),
});

const { handler, dispose } = HttpRouter.toWebHandler(
  SessionRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        controlPlaneAuthLayer(
          testTokens([
            ["alice", ALICE_TOKEN],
            ["bob", BOB_TOKEN],
          ]),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no forge in this file")),
        ),
        Layer.succeed(CredentialProvider, credentials),
        FauxServerFacts,
      ),
    ),
    Layer.provideMerge(SessionServiceLive({ model, sessionRoot })),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    Layer.provide(ScratchConfig),
  ),
  { disableLogger: true },
);

afterAll(async () => {
  await dispose();
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DROP DATABASE IF EXISTS ${sql(scratchName)} WITH (FORCE)`;
    }),
  );
  await admin.dispose();
  rmSync(sessionRoot, { recursive: true, force: true });
});

/** Every response body the server wrote, as text. */
const answered: string[] = [];

const protocolFor = (token: string) =>
  RpcClient.layerProtocolHttp({
    url: "http://factory.test/rpc",
    transformClient: sendingToken(token),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, signal) =>
          HttpClientRequest.toWeb(request, { signal }).pipe(
            Effect.flatMap((web) =>
              Effect.promise(async () => {
                const response = await handler(web);
                answered.push(await response.clone().text());
                return response;
              }),
            ),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, response),
            ),
            Effect.orDie,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerNdjson),
  );

const as =
  (token: string) =>
  <A, E>(
    body: (
      client: RpcClient.FromGroup<typeof RpcApi, RpcClientError>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(RpcApi);
          return yield* body(client);
        }),
      ).pipe(Effect.provide(protocolFor(token))),
    );
const alice = as(ALICE_TOKEN);
const bob = as(BOB_TOKEN);

const email = (address: string) => ({ type: "email" as const, address });

describe("the settings", () => {
  it("start as NOTIFY_TYPES says, with the caller's own sinks and what the deployment can send", async () => {
    const settings = await alice((client) =>
      client.getNotificationSettings({}),
    );
    expect(settings.actor).toBe("alice");
    expect(settings.kinds).toEqual([
      { kind: "question", enabled: true, stored: false },
      { kind: "approval", enabled: true, stored: false },
      { kind: "gate", enabled: true, stored: false },
      { kind: "failed", enabled: true, stored: false },
    ]);
    expect(settings.sinks).toEqual([]);
    expect(settings.channels).toEqual({
      email: true,
      webPush: { configured: true, publicKey: keys.publicKey },
      shared: [],
    });
  });

  it("a toggle is stored, answers the settings as they now stand, and is the deployment's for everyone", async () => {
    const off = await alice((client) =>
      client.setNotificationKind({ kind: "gate", enabled: false }),
    );
    expect(off.kinds.find((k) => k.kind === "gate")).toEqual({
      kind: "gate",
      enabled: false,
      stored: true,
    });
    const seenByBob = await bob((client) => client.getNotificationSettings({}));
    expect(seenByBob.kinds.find((k) => k.kind === "gate")?.enabled).toBe(false);
    expect(seenByBob.kinds.find((k) => k.kind === "question")?.stored).toBe(
      false,
    );
    const on = await bob((client) =>
      client.setNotificationKind({ kind: "gate", enabled: true }),
    );
    expect(on.kinds.find((k) => k.kind === "gate")).toEqual({
      kind: "gate",
      enabled: true,
      stored: true,
    });
  });
});

describe("a person's sinks", () => {
  it("are added, listed, paused and removed by their owner — and by nobody else", async () => {
    const added = await alice((client) =>
      client.addNotificationSink({ destination: email("alice@example.test") }),
    );
    expect(added).toMatchObject({
      type: "email",
      label: "alice@example.test",
      enabled: true,
    });
    const mine = await alice((client) => client.getNotificationSettings({}));
    const theirs = await bob((client) => client.getNotificationSettings({}));
    expect(mine.sinks).toEqual([added]);
    expect(theirs.sinks).toEqual([]);

    const pause = await bob((client) =>
      Effect.flip(
        client.setNotificationSinkEnabled({ id: added.id, enabled: false }),
      ),
    );
    const remove = await bob((client) =>
      Effect.flip(client.removeNotificationSink({ id: added.id })),
    );
    expect(pause).toMatchObject({
      _tag: "NotificationSinkNotFound",
      id: added.id,
    });
    expect(remove).toMatchObject({
      _tag: "NotificationSinkNotFound",
      id: added.id,
    });

    const paused = await alice((client) =>
      client.setNotificationSinkEnabled({ id: added.id, enabled: false }),
    );
    expect(paused.enabled).toBe(false);
    const removed = await alice((client) =>
      client.removeNotificationSink({ id: added.id }),
    );
    expect(removed.id).toBe(added.id);
    expect(
      (await alice((client) => client.getNotificationSettings({}))).sinks,
    ).toEqual([]);
  });

  it("belong to the credential's actor, whatever a body says", async () => {
    const added = await alice((client) =>
      client.addNotificationSink({
        destination: email("pretend@example.test"),
        actor: "bob",
      }),
    );
    const bobs = await bob((client) =>
      client.getNotificationSettings({ actor: "alice" }),
    );
    expect(bobs.actor).toBe("bob");
    expect(bobs.sinks).toEqual([]);
    expect(
      (await alice((client) => client.getNotificationSettings({}))).sinks,
    ).toContainEqual(added);
    await alice((client) => client.removeNotificationSink({ id: added.id }));
  });

  it("refuse what cannot be sent to, typed, storing nothing", async () => {
    const badAddress = await alice((client) =>
      Effect.flip(
        client.addNotificationSink({ destination: email("not an address") }),
      ),
    );
    const subscription = {
      type: "web_push" as const,
      endpoint: "http://push.example.test/x",
      p256dh: "AAAA",
      auth: "AAAA",
    };
    const badPush = await alice((client) =>
      Effect.flip(client.addNotificationSink({ destination: subscription })),
    );
    expect(badAddress._tag).toBe("InvalidNotificationSink");
    expect(badPush._tag).toBe("InvalidNotificationSink");
    expect(badPush.message).toContain("https");
    expect(
      (await alice((client) => client.getNotificationSettings({}))).sinks,
    ).toEqual([]);
  });

  it("keep a push subscription's endpoint and keys out of every answer", async () => {
    const endpoint = `https://push.example.test/send/endpoint-secret-${run}`;
    // A real subscription's keys: the RPC checks they are P-256 and a 16-byte secret.
    const browserKey = createECDH("prime256v1");
    browserKey.generateKeys();
    const p256dh = browserKey.getPublicKey().toString("base64url");
    const auth = randomBytes(16).toString("base64url");
    const before = answered.length;
    const added = await alice((client) =>
      client.addNotificationSink({
        destination: { type: "web_push", endpoint, p256dh, auth },
      }),
    );
    const listed = await alice((client) => client.getNotificationSettings({}));
    expect(added).toMatchObject({
      type: "web_push",
      label: "push.example.test",
    });
    expect(listed.sinks).toContainEqual(added);
    for (const text of answered.slice(before)) {
      expect(text).not.toContain(`endpoint-secret-${run}`);
      expect(text).not.toContain(p256dh);
      expect(text).not.toContain(auth);
    }
    await alice((client) => client.removeNotificationSink({ id: added.id }));
  });
});
