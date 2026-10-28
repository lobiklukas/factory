/**
 * A board's configuration over the wire (LOB-270): `listDefinitions`, `getDefinition` and
 * `getBoardConfig`, served by the app's own `SessionRpcLive` — the router `index.ts` mounts — through
 * `HttpRouter.toWebHandler`, and called with the `RpcClient` over NDJSON the CLI and the dashboard
 * build. So every payload, answer and refusal is encoded and decoded as a real client sees it.
 *
 * The session layer is given a role table (`builder=faux/builder`) the way `index.ts` gives it
 * `ROLE_MODELS`, so "the role's resolved model" is checked against a deployment that has one: the
 * builder's column answers its row, every other column the deployment's model.
 *
 * The database is this file's own, created on the server `DATABASE_URL` names and dropped in
 * `afterAll`, as `./Session.test.ts` does — so it holds exactly the definitions the migrations seed,
 * plus the one newer version a case adds, and "every version" is a claim this file can make whole.
 */
import { execSync } from "node:child_process";
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
import {
  BoardInstanceId,
  type ColumnConfig,
  DefinitionId,
} from "@repo/domain/Task";
import {
  createFauxModelAccess,
  FAUX_MODEL_ID,
  resolveRoleModels,
} from "@repo/harness";
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
import { FauxServerFacts } from "../ServerInfo.test-fake";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-board-"));
const run = randomBytes(4).toString("hex");

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_board_${run}`;
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

/** Built as `index.ts` builds it: the builder's row names a faux model only this table publishes. */
const BUILDER_MODEL = "faux/builder";
const DEPLOYMENT_MODEL = `faux/${FAUX_MODEL_ID}`;
const model = createFauxModelAccess({
  fauxModels: [FAUX_MODEL_ID, "builder"],
}).access;
const roleModels = Effect.runSync(
  resolveRoleModels(model, new Map([["builder", BUILDER_MODEL]])),
);

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
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no forge in this file")),
        ),
        Layer.succeed(CredentialProvider, credentials),
        FauxServerFacts,
      ),
    ),
    Layer.provideMerge(SessionServiceLive({ model, roleModels, sessionRoot })),
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

const DEFAULT = DefinitionId.make("default");

/** A run in a column with no role, or a role with no row, talks to the deployment's model. */
const deployment = { model: DEPLOYMENT_MODEL, source: "deployment" } as const;

/**
 * The default pipeline at version 3, described — written out here rather than derived from the
 * code under test, so a change to the exits, a gate, a checked key or a model is a red diff here.
 */
const DEFAULT_V3: ReadonlyArray<ColumnConfig> = [
  {
    name: "intake",
    kind: "resting",
    model: deployment,
    skills: [],
    requires: [],
    exits: [{ to: "specifying" }, { to: "canceled" }],
  },
  {
    name: "specifying",
    kind: "working",
    role: "specifier",
    model: deployment,
    skills: ["specify"],
    requires: [
      {
        key: "spec_doc",
        description:
          "a spec doc, gaps declared (explicitly [] when there are none)",
        checked: false,
      },
    ],
    exits: [{ to: "planning" }, { to: "canceled" }],
  },
  {
    name: "planning",
    kind: "working",
    role: "planner",
    model: deployment,
    skills: [],
    requires: [
      { key: "plan_doc", description: "a plan doc", checked: false },
      {
        key: "human_move",
        description: "a human move (B5's plan approval gate)",
        checked: false,
      },
    ],
    exits: [{ to: "building", humanGate: "plan approval" }, { to: "canceled" }],
  },
  {
    name: "building",
    kind: "working",
    role: "builder",
    model: { model: BUILDER_MODEL, source: "role" },
    skills: ["implement"],
    requires: [
      {
        key: "run_completed",
        description: "a run that completed",
        checked: false,
      },
      { key: "non_empty_diff", description: "a non-empty diff", checked: true },
      { key: "pr_link", description: "a PR link", checked: true },
    ],
    exits: [{ to: "review" }, { to: "canceled" }],
  },
  {
    name: "review",
    kind: "working",
    role: "reviewer",
    model: deployment,
    skills: ["review"],
    requires: [
      {
        key: "verified",
        description:
          "a passing verification of every surface the card's change touched",
        checked: true,
      },
      {
        key: "review_verdict",
        description: "a review verdict",
        checked: false,
      },
      {
        key: "human_merge",
        description: "a human merge (B5's merge gate)",
        checked: false,
      },
    ],
    exits: [{ to: "done", humanGate: "merge" }, { to: "canceled" }],
  },
  {
    name: "done",
    kind: "terminal",
    model: deployment,
    skills: [],
    requires: [],
    exits: [],
  },
  {
    name: "canceled",
    kind: "terminal",
    model: deployment,
    skills: [],
    requires: [],
    exits: [],
  },
];

describe("a board's configuration over RPC (LOB-270)", () => {
  /**
   * The guard for the case below that writes a definition row: both the router's database and the
   * runtime that writes are this file's scratch database, never the configured one.
   */
  it("serves and writes the scratch database, not the configured one", async () => {
    const name = await scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{
          name: string;
        }>`SELECT current_database() AS name`;
        return rows[0]?.name;
      }),
    );
    expect(name).toBe(scratchName);
    // A board made over the wire is a row in the scratch database.
    const board = await call((client) =>
      client.createBoard({
        repo: RepoSlug.make(`acme/rpc-board-scratch-${run}`),
        definitionId: DEFAULT,
      }),
    );
    const found = await scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ id: string }>`
          SELECT id FROM board_instances WHERE id = ${board.id}
        `;
      }),
    );
    expect(found).toHaveLength(1);
  });

  /**
   * Mutation: answer the newest version only, or order versions newest first — the list is not
   * `1..newest`. Mutation: read the newest once at boot — the version added below never appears, and
   * `getDefinition` with no version keeps answering the seeded newest.
   */
  it("lists default v1 through the seeded newest, then a newer version once one is written, and reads the newest by default", async () => {
    // The oracle is the scratch database's rows: the migrations seed v1–v3 and any later version.
    const seeded = await scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ newest: number }>`
          SELECT max(version)::int AS newest FROM board_definitions WHERE id = 'default'
        `;
        return rows[0]?.newest ?? 0;
      }),
    );
    expect(seeded).toBeGreaterThanOrEqual(3);
    const upTo = (newest: number) =>
      Array.from({ length: newest }, (_, index) => index + 1);

    const before = await call((client) => client.listDefinitions({}));
    expect(before.map((definition) => definition.id)).toEqual(["default"]);
    expect(before[0]?.versions.map((version) => version.version)).toEqual(
      upTo(seeded),
    );
    for (const version of before[0]?.versions.slice(0, 3) ?? []) {
      expect(version.name).toBe("Default pipeline");
    }
    for (const version of before[0]?.versions ?? []) {
      expect(Number.isNaN(Date.parse(version.createdAt))).toBe(false);
    }

    // One version past the seeded newest, written as a migration writes one: a new row, never an
    // update (B2).
    const added = seeded + 1;
    await scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          INSERT INTO board_definitions (id, version, name, columns)
          SELECT id, ${added}, ${`Default pipeline, v${added}`}, columns
          FROM board_definitions WHERE id = 'default' AND version = ${seeded}
        `;
      }),
    );
    const after = await call((client) => client.listDefinitions({}));
    expect(after[0]?.versions.map((version) => version.version)).toEqual(
      upTo(added),
    );
    expect(after[0]?.versions.at(-1)?.name).toBe(`Default pipeline, v${added}`);

    const newest = await call((client) =>
      client.getDefinition({ definitionId: DEFAULT }),
    );
    expect(newest.version).toBe(added);
    expect(newest.name).toBe(`Default pipeline, v${added}`);
  });

  /**
   * The whole description, column by column. Mutation: resolve every column to the deployment's model
   * — `building` is not `faux/builder (role)`. Mutation: mark every declared key checked, or none —
   * the `checked` flags differ. Mutation: drop the gate from an exit — `planning`'s first exit loses
   * `plan approval`.
   */
  it("describes default v3: each column's exits and human gates, checked requirements and resolved model", async () => {
    const v3 = await call((client) =>
      client.getDefinition({ definitionId: DEFAULT, version: 3 }),
    );
    expect(v3.id).toBe("default");
    expect(v3.version).toBe(3);
    expect(v3.name).toBe("Default pipeline");
    expect(v3.columns).toEqual(DEFAULT_V3);
    expect(v3.initialColumn).toBe("intake");

    // Version 4 (LOB-267) carries the moves on its columns and names its initial column, and they
    // are exactly the table versions 1–3 resolve through: the same description, column by column.
    const v4 = await call((client) =>
      client.getDefinition({ definitionId: DEFAULT, version: 4 }),
    );
    expect(v4.version).toBe(4);
    expect(v4.initialColumn).toBe("intake");
    expect(v4.columns).toEqual(DEFAULT_V3);

    // Version 1 is its own row: no skills bound, and `review` does not declare `verified` yet.
    const v1 = await call((client) =>
      client.getDefinition({ definitionId: DEFAULT, version: 1 }),
    );
    expect(v1.version).toBe(1);
    expect(v1.columns.flatMap((column) => column.skills)).toEqual([]);
    expect(
      v1.columns
        .find((column) => column.name === "review")
        ?.requires.map((requirement) => requirement.key),
    ).toEqual(["review_verdict", "human_merge"]);
  });

  /** Mutation: fall back to the newest on a missing version — the call answers a definition. */
  it("refuses an unknown id and an unknown version as a typed DefinitionNotFound", async () => {
    const unknownId = await call((client) =>
      failureOf(
        client.getDefinition({
          definitionId: DefinitionId.make(`nosuch${run}`),
        }),
      ),
    );
    expect(unknownId).toMatchObject({
      _tag: "DefinitionNotFound",
      definitionId: `nosuch${run}`,
      message: `no board definition nosuch${run}`,
    });
    expect("version" in unknownId ? unknownId.version : undefined).toBe(
      undefined,
    );

    const unknownVersion = await call((client) =>
      failureOf(client.getDefinition({ definitionId: DEFAULT, version: 99 })),
    );
    expect(unknownVersion).toMatchObject({
      _tag: "DefinitionNotFound",
      definitionId: "default",
      version: 99,
      message: "board definition default has no version 99",
    });
  });

  /**
   * A board pinned to v3 describes v3, whatever is newer. Mutation: describe the definition's newest
   * version rather than the pinned one — the board pinned to 3 answers 4 after the case above.
   */
  it("answers a board's instance and its pinned version described, and an unknown board as BoardNotFound", async () => {
    const outcome = await call((client) =>
      Effect.gen(function* () {
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-board-config-${run}`),
          definitionId: DEFAULT,
          definitionVersion: 3,
        });
        const config = yield* client.getBoardConfig({ boardId: board.id });
        const listed = yield* client.listBoards({});
        return { board, config, listed };
      }),
    );
    // `warning` (LOB-263) is the repository's, answered beside the instance, not inside it.
    const { warning: _warning, ...instance } = outcome.board;
    expect(outcome.config.instance).toEqual(instance);
    expect(outcome.config.definition.version).toBe(3);
    expect(outcome.config.definition.columns).toEqual(DEFAULT_V3);
    expect(outcome.listed).toContainEqual(instance);

    const missing = BoardInstanceId.make(`brd_${"0".repeat(26)}`);
    const unknown = await call((client) =>
      failureOf(client.getBoardConfig({ boardId: missing })),
    );
    expect(unknown).toMatchObject({
      _tag: "BoardNotFound",
      boardId: missing,
    });
  });
  /**
   * LOB-263 over the wire: `createBoard` and `getBoard` answer the warning a repository with no local
   * checkout earns, the session's workspace says the same, and registering a path clears the board's.
   * The text is the server's, so a client prints it as it is. Mutation: leave `warning` off the
   * `CreatedBoard` or `BoardView` schema — the client's decode drops it and the first expectation fails.
   */
  it("carries the no-checkout warning on createBoard, getBoard and a session's workspace, and clears it once the repo has a path", async () => {
    const repo = RepoSlug.make(`acme/rpc-no-checkout-${run}`);
    const checkout = mkdtempSync(join(tmpdir(), "factory-api-rpc-checkout-"));
    try {
      execSync("git init -q -b main", { cwd: checkout });
      const outcome = await call((client) =>
        Effect.gen(function* () {
          const made = yield* client.createBoard({
            repo,
            definitionId: DEFAULT,
          });
          const before = yield* client.getBoard({ boardId: made.id });
          const session = yield* client.createSession({ repo });
          const opened = yield* client.getSession({ sessionId: session.id });
          const scratch = yield* client.createSession({});
          const scratchOpened = yield* client.getSession({
            sessionId: scratch.id,
          });
          yield* client.registerRepo({ repo, localPath: checkout });
          const after = yield* client.getBoard({ boardId: made.id });
          return { made, before, opened, scratchOpened, after };
        }),
      );
      const guidance = `factory repo add ${repo} --path <dir>`;
      expect(outcome.made.warning).toContain(guidance);
      expect(outcome.before.warning).toBe(outcome.made.warning);
      expect(outcome.opened.workspace.warning).toBe(outcome.made.warning);
      expect(outcome.scratchOpened.workspace.warning).toBeUndefined();
      expect(outcome.after.warning).toBeUndefined();
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
