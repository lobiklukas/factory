/**
 * The factory's skills over the wire (D7): `listSkills`, `getSkill` and `putSkill`, served by the
 * app's own `SessionRpcLive` through `HttpRouter.toWebHandler` and called with the `RpcClient` over
 * NDJSON the CLI builds, so every payload, answer and refusal is encoded and decoded as a real client
 * sees it.
 *
 * The database is this file's own, created on the server `DATABASE_URL` names and dropped in
 * `afterAll`, as `./Task.test.ts` does: freshly migrated, so it holds exactly the seeded skills at
 * version 1 and the shipped default definition, and a put here cannot reach another suite's run.
 * What a version does to a run is core's (`SessionService.test.ts`, `SkillService.test.ts`); this
 * file proves the surface that reads and writes them.
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
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
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

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-skills-"));
const run = randomBytes(4).toString("hex");

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_skills_${run}`;
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

/** The scratch database itself, for reading back the rows a put wrote. */
const scratch = ManagedRuntime.make(
  PostgresLive.pipe(Layer.provide(ScratchConfig)),
);

/** Every row the table holds for `name`, oldest first. */
const rowsOf = (name: string) =>
  scratch.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{ version: number; body: string; author: string }>`
        SELECT version, body, author FROM skills WHERE name = ${name} ORDER BY version
      `;
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

describe("skills over RPC", () => {
  it("lists every skill once, at its newest version, with the default definition's columns that bind it", async () => {
    const listed = await call((client) => client.listSkills({}));
    const byName = new Map(listed.map((skill) => [skill.name, skill]));
    expect(listed.map((skill) => skill.name)).toEqual(
      [...byName.keys()].sort(),
    );
    for (const seeded of [
      "decompose",
      "docs",
      "implement",
      "plan-freshness",
      "review",
      "specify",
    ]) {
      expect(byName.get(seeded)?.version).toBe(1);
    }
    // The columns are the definition's own, read the way `getDefinition` answers them.
    const definition = await call((client) =>
      client.getDefinition({
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
      }),
    );
    for (const skill of listed) {
      expect(skill.columns).toEqual(
        definition.columns
          .filter((column) => column.skills.includes(skill.name))
          .map((column) => column.name),
      );
    }
    expect(byName.get("specify")?.columns).toEqual(["specifying"]);
    expect(byName.get("decompose")?.columns).toEqual([]);
  }, 60_000);

  it("puts version N+1 attributed to the caller, never overwriting, and reads either version back", async () => {
    const before = await call((client) => client.getSkill({ name: "specify" }));
    const put = await call((client) =>
      client.putSkill({
        name: "specify",
        description: before.description,
        body: "# Specify\n\nAsk about the risks first.\n",
        // A body actor on an authenticated control plane changes nothing (LOB-20).
        actor: "person:someone-else",
      }),
    );
    expect(put).toMatchObject({
      name: "specify",
      version: before.version + 1,
      newest: before.version + 1,
      author: TEST_ACTOR,
      body: "# Specify\n\nAsk about the risks first.\n",
    });
    // The old version is still the row it was.
    const old = await call((client) =>
      client.getSkill({ name: "specify", version: before.version }),
    );
    expect(old).toMatchObject({
      version: before.version,
      newest: put.version,
      body: before.body,
    });
    expect((await rowsOf("specify")).map((row) => row.body)).toEqual([
      before.body,
      put.body,
    ]);
    // The list moved to the new version, and still names the column the put reaches.
    const listed = await call((client) => client.listSkills({}));
    expect(listed.find((skill) => skill.name === "specify")).toMatchObject({
      version: put.version,
      columns: ["specifying"],
    });
  }, 60_000);

  it("refuses an unknown name or version, a blank body and a malformed name, writing nothing", async () => {
    const missing = await call((client) =>
      failureOf(client.getSkill({ name: `nope-${run}` })),
    );
    expect(missing).toMatchObject({ _tag: "SkillNotFound" });
    const noVersion = await call((client) =>
      failureOf(client.getSkill({ name: "review", version: 99 })),
    );
    expect(noVersion).toMatchObject({
      _tag: "SkillNotFound",
      version: 99,
      message: 'skill "review" has no version 99',
    });

    const name = `blank-${run}`;
    const blank = await call((client) =>
      failureOf(client.putSkill({ name, description: "", body: " \n" })),
    );
    expect(blank).toMatchObject({ _tag: "InvalidSkill", name });
    expect(await rowsOf(name)).toEqual([]);

    // The name's shape is the payload schema's, so the call fails before it is sent.
    await expect(
      call((client) =>
        failureOf(
          client.putSkill({ name: "Specify", description: "", body: "# x" }),
        ),
      ),
    ).rejects.toThrow(/validation failed|Expected/);
    expect(await rowsOf("Specify")).toEqual([]);
  }, 60_000);
});
