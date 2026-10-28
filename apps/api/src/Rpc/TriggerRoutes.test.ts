/**
 * The stored trigger routes over the wire (LOB-266): `addTriggerRoute`, `listTriggerRoutes` and
 * `removeTriggerRoute`, served by the app's own `SessionRpcLive` through `HttpRouter.toWebHandler` and
 * called with the `RpcClient` over NDJSON the CLI and the dashboard build, so every payload, answer
 * and refusal is encoded and decoded as a real client sees it.
 *
 * The database is this file's own, created on the server `DATABASE_URL` names and dropped in
 * `afterAll`, as `./Task.test.ts` does. What the seam does with a route is `TriggerService.test.ts`'s
 * (Postgres, per delivery); this file proves the surface that writes the rows.
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
  TEST_TOKEN,
  TestControlPlaneAuth,
} from "./Auth.test-fake";
import { FauxServerFacts } from "../ServerInfo.test-fake";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-routes-"));
const run = randomBytes(4).toString("hex");

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_routes_${run}`;
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
}

/**
 * The environment as it is *now*, with `DATABASE_URL` naming the scratch database. Not the default
 * provider: effect caches that one's snapshot of `process.env` the first time any config is read,
 * which `admin` did above with the configured URL — so a layer left on the default would quietly
 * connect to the configured database instead, and the row a case writes would land there.
 */
const ScratchConfig = ConfigProvider.layer(ConfigProvider.fromEnv());

/** The scratch database itself, for the one row a case writes as a migration would. */
const scratch = ManagedRuntime.make(
  PostgresLive.pipe(Layer.provide(ScratchConfig)),
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

const ClientProtocol = RpcClient.layerProtocolHttp({
  url: "http://factory.test/rpc",
  transformClient: sendingToken(TEST_TOKEN),
}).pipe(
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, _url, signal) =>
        HttpClientRequest.toWeb(request, { signal }).pipe(
          Effect.flatMap((web) => Effect.promise(() => handler(web))),
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

const repo = RepoSlug.make("acme/routed");
const label = `route-${run}`;

describe("trigger routes over RPC", () => {
  it("adds, lists in the seam's order and removes a route, and says so when a route is already gone", async () => {
    await call((client) => client.registerRepo({ repo }));

    const teamOnly = await call((client) =>
      client.addTriggerRoute({ team: `T${run}`, repo, prompt: "team" }),
    );
    const labelled = await call((client) =>
      client.addTriggerRoute({
        label,
        repo,
        baseRef: "develop",
        prompt: "label {{key}}",
        startsWorkFor: ["push"],
      }),
    );
    expect(labelled).toMatchObject({
      label,
      repo,
      baseRef: "develop",
      prompt: "label {{key}}",
      startsWorkFor: ["push"],
    });
    expect(labelled.id).toMatch(/^trr_[0-9a-z]{26}$/);
    // A route names what it names and nothing else: no `team` key it was never given.
    expect(labelled).not.toHaveProperty("team");

    const { routes } = await call((client) => client.listTriggerRoutes({}));
    // The label route is more specific than the team-only one, so it is consulted first, though it
    // was added second.
    expect(routes.map((route) => route.id)).toEqual([labelled.id, teamOnly.id]);

    const removed = await call((client) =>
      client.removeTriggerRoute({ id: labelled.id }),
    );
    expect(removed.id).toBe(labelled.id);
    expect(
      (await call((client) => client.listTriggerRoutes({}))).routes.map(
        (route) => route.id,
      ),
    ).toEqual([teamOnly.id]);

    const again = await call((client) =>
      failureOf(client.removeTriggerRoute({ id: labelled.id })),
    );
    expect(again).toMatchObject({ _tag: "TriggerRouteNotFound" });
    await call((client) => client.removeTriggerRoute({ id: teamOnly.id }));
  }, 60_000);

  it("refuses a route to a repo nobody registered, naming it, and stores nothing", async () => {
    const never = RepoSlug.make(`acme/never-${run}`);
    const failure = await call((client) =>
      failureOf(client.addTriggerRoute({ label, repo: never, prompt: "x" })),
    );
    expect(failure).toMatchObject({
      _tag: "TriggerRouteError",
      code: "invalid_input",
    });
    expect((failure as { message: string }).message).toContain(never);
    expect(
      (await call((client) => client.listTriggerRoutes({}))).routes,
    ).toEqual([]);
  }, 60_000);

  it("refuses a route that names neither a label nor a team before it is sent", async () => {
    // The payload schema checks it, on the client that encodes the call and the server that decodes
    // it, so it surfaces as a thrown validation failure and never as the registry's typed `storage`
    // error a database check would raise.
    await expect(
      call((client) =>
        failureOf(client.addTriggerRoute({ repo, prompt: "x" } as never)),
      ),
    ).rejects.toThrow(/validation failed/);
    expect(
      (await call((client) => client.listTriggerRoutes({}))).routes,
    ).toEqual([]);
  }, 60_000);

  it("lists the recorded deliveries newest first over the wire: outcome, reason verbatim, the session or card, filters and a cursor", async () => {
    const id = (name: string) => `t4-${run}-${name}`;
    const session = "ses_00000000000000000000000d01";
    const card = "tsk_00000000000000000000000d01";
    // The rows the seam writes, with instants a walk can order by (written in SQL: a bound
    // parameter rounds to the millisecond).
    await scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO webhook_deliveries
            (request_id, status, source, skip_reason, session_id, received_at)
          VALUES (${id("processed")}, 'processed', 'linear', 'rule "x" mapped it', ${session},
            timestamptz '2098-01-01 00:00:03+00')`;
        yield* sql`INSERT INTO webhook_deliveries
            (request_id, status, source, skip_reason, task_id, received_at)
          VALUES (${id("card")}, 'processed', 'generic', 'filed card', ${card},
            timestamptz '2098-01-01 00:00:02+00')`;
        yield* sql`INSERT INTO webhook_deliveries
            (request_id, status, source, skip_reason, received_at)
          VALUES (${id("skipped")}, 'skipped', 'linear', 'repo acme/nope is not registered',
            timestamptz '2098-01-01 00:00:01+00')`;
      }),
    );

    const first = await call((client) =>
      client.listTriggerDeliveries({ limit: 2 }),
    );
    expect(first.deliveries.map((row) => row.deliveryId)).toEqual([
      id("processed"),
      id("card"),
    ]);
    expect(first.deliveries[0]).toEqual({
      deliveryId: id("processed"),
      source: "linear",
      receivedAt: "2098-01-01T00:00:03.000Z",
      status: "processed",
      reason: 'rule "x" mapped it',
      sessionId: session,
    });
    expect(first.deliveries[1]).toMatchObject({ taskId: card });
    expect(first.nextCursor).toBeDefined();

    const next = await call((client) =>
      client.listTriggerDeliveries({
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      }),
    );
    expect(next.deliveries[0]).toMatchObject({
      deliveryId: id("skipped"),
      status: "skipped",
      reason: "repo acme/nope is not registered",
    });
    expect(next.deliveries[0]).not.toHaveProperty("sessionId");

    const skippedLinear = await call((client) =>
      client.listTriggerDeliveries({ status: "skipped", source: "linear" }),
    );
    expect(skippedLinear.deliveries.map((row) => row.deliveryId)).toEqual([
      id("skipped"),
    ]);

    const bad = await call((client) =>
      failureOf(client.listTriggerDeliveries({ cursor: "nope" })),
    );
    expect(bad).toMatchObject({
      _tag: "TriggerDeliveryError",
      code: "invalid_input",
    });
    // A source this build does not know is refused before it is sent, as a route with no key is.
    await expect(
      call((client) =>
        failureOf(client.listTriggerDeliveries({ source: "fax" } as never)),
      ),
    ).rejects.toThrow(/validation failed/);
  }, 60_000);
});
