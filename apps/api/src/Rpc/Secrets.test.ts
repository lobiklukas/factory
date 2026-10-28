/**
 * A repository's secrets over the wire (S-agent-secrets): `setSecret`, `listSecrets` and
 * `deleteSecret`, served by the app's own `SessionRpcLive` through `HttpRouter.toWebHandler` and
 * called with the `RpcClient` over NDJSON the CLI builds. Every response body the server writes is
 * kept as text, so "no RPC returns a secret's value after it is saved" is asserted on the bytes a
 * client receives, not on a decoded shape that could drop a field.
 *
 * The database is this file's own, created on the server `DATABASE_URL` names and dropped in
 * `afterAll`, as `./Skills.test.ts` does. The store's key is this file's own, random, set before the
 * layer reads it. Every value is obviously fake.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialError,
  CredentialProvider,
  SessionServiceLive,
} from "@repo/core";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
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
import { SessionRpcLive } from "./Session";
import {
  sendingToken,
  TEST_ACTOR,
  TEST_TOKEN,
  TestControlPlaneAuth,
} from "./Auth.test-fake";
import { FauxServerFacts } from "../ServerInfo.test-fake";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-secrets-"));
const run = randomBytes(4).toString("hex");

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_secrets_${run}`;
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
  // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
  process.env["DATABASE_URL"] = configured.toString();
  // oxlint-disable-next-line effecttsgo/process-env -- as above: the store's key, this file's own.
  process.env["FACTORY_SECRETS_KEY"] = randomBytes(32).toString("base64");
}

/**
 * The environment as it is *now*, with `DATABASE_URL` naming the scratch database. Not the default
 * provider: effect caches that one's snapshot of `process.env` the first time any config is read,
 * which `admin` did above with the configured URL — so a layer left on the default would quietly
 * connect to the configured database instead, and the row a case writes would land there.
 */
const ScratchConfig = ConfigProvider.layer(ConfigProvider.fromEnv());

/** The scratch database itself, for reading back the rows a put wrote. */
const scratch = ManagedRuntime.make(
  PostgresLive.pipe(Layer.provide(ScratchConfig)),
);

/** The scratch database's `secrets` rows, as text: what is at rest. */
const storedRows = () =>
  scratch.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{ row: string }>`SELECT s::text AS row FROM secrets s`;
    }),
  );

const model = createFauxModelAccess({ fauxModels: [FAUX_MODEL_ID] }).access;

/** Nothing here opens a PR; a credential asked for anyway fails the case that asked. */
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
        TestControlPlaneAuth,
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
  await scratch.dispose();
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

const ClientProtocol = RpcClient.layerProtocolHttp({
  url: "http://factory.test/rpc",
  transformClient: sendingToken(TEST_TOKEN),
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

const call = <A, E>(
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
    ).pipe(Effect.provide(ClientProtocol)),
  );

/** The failure a call answered, as the client decoded it. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

const FAKE = `fake-rpc-secret-${run}`;

const registered = async (): Promise<RepoSlug> => {
  const repo = RepoSlug.make(`secrets-${randomBytes(4).toString("hex")}/rpc`);
  await call((client) => client.registerRepo({ repo }));
  return repo;
};

describe("secrets over RPC", () => {
  it("stores a value and never answers it: set, list and delete each answer a summary", async () => {
    const repo = await registered();
    const before = answered.length;
    const set = await call((client) =>
      client.setSecret({
        repo,
        name: "TEST_API_KEY",
        value: Redacted.make(FAKE),
      }),
    );
    const listed = await call((client) => client.listSecrets({ repo }));
    const all = await call((client) => client.listSecrets({}));
    const rows = await storedRows();
    const deleted = await call((client) =>
      client.deleteSecret({ repo, name: "TEST_API_KEY" }),
    );
    const after = await call((client) => client.listSecrets({ repo }));

    expect(set).toMatchObject({
      repo,
      name: "TEST_API_KEY",
      updatedBy: TEST_ACTOR,
    });
    expect(listed).toEqual([set]);
    expect(all).toContainEqual(set);
    expect(deleted).toEqual(set);
    expect(after).toEqual([]);
    // Not a byte of any answer is the value, and at rest it is ciphertext.
    const bodies = answered.slice(before);
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    for (const text of bodies) expect(text).not.toContain(FAKE);
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) expect(row).not.toContain(FAKE);
  });

  it("refuses a short value and an unregistered repo, typed, storing nothing", async () => {
    const repo = await registered();
    const short = await call((client) =>
      failureOf(
        client.setSecret({ repo, name: "SHORT", value: Redacted.make("short") }),
      ),
    );
    const unknown = await call((client) =>
      failureOf(
        client.setSecret({
          repo: RepoSlug.make(`nobody-${run}/rpc`),
          name: "TEST_API_KEY",
          value: Redacted.make(FAKE),
        }),
      ),
    );
    const missing = await call((client) =>
      failureOf(client.deleteSecret({ repo, name: "NOT_THERE" })),
    );
    expect(short._tag).toBe("InvalidSecret");
    expect(unknown._tag).toBe("RepoNotFound");
    expect(missing._tag).toBe("SecretNotFound");
    expect(await call((client) => client.listSecrets({ repo }))).toEqual([]);
  });
});
