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
  TaskId,
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
import { afterAll, describe, expect, it, vi } from "vitest";
import { SessionRpcLive } from "./Session";
import {
  sendingToken,
  TEST_ACTOR,
  TEST_TOKEN,
  TestControlPlaneAuth,
} from "./Auth.test-fake";
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

/**
 * The control plane's router over this file's database, with or without a role table: the same
 * handlers `index.ts` mounts, so a deployment with no `ROLE_MODELS` (F4) is a router of its own.
 */
const routerWith = (roles: typeof roleModels | undefined) =>
  HttpRouter.toWebHandler(
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
      Layer.provideMerge(
        SessionServiceLive({
          model,
          ...(roles === undefined ? {} : { roleModels: roles }),
          sessionRoot,
        }),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      Layer.provide(ScratchConfig),
    ),
    { disableLogger: true },
  );

const { handler, dispose } = routerWith(roleModels);
/** The same control plane with no role table (`defineBoard` takes any role name, F4), built on first use. */
let open: ReturnType<typeof routerWith> | undefined;

afterAll(async () => {
  await dispose();
  await open?.dispose();
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

const protocolFor = (serve: typeof handler) =>
  RpcClient.layerProtocolHttp({
    url: "http://factory.test/rpc",
    transformClient: sendingToken(TEST_TOKEN),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, signal) =>
          HttpClientRequest.toWeb(request, { signal }).pipe(
            Effect.flatMap((web) => Effect.promise(() => serve(web))),
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

const callOn =
  (serve: typeof handler) =>
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
      ).pipe(Effect.provide(protocolFor(serve))),
    );

const call = callOn(handler);
/**
 * Built on first use, not at load: two routers over one database would run the migrations at once,
 * and the second finds `effect_sql_migrations` already created. By the time a case calls this, the
 * first router has migrated.
 */
const callOpen: typeof call = (body) => {
  open ??= routerWith(undefined);
  return callOn(open.handler)(body);
};

/** The failure a call answered, as the client decoded it. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

const DEFAULT = DefinitionId.make("default");

/** A run in a column with no role, or a role with no row, talks to the deployment's model. */
const deployment = { model: DEPLOYMENT_MODEL, source: "deployment" } as const;

/**
 * A column's effective autonomy under this deployment (C22), which gates nothing: D11's scopes, or
 * the read-only stage's for a read-only role.
 */
const unasked = {
  approvalRequired: [],
  write: "worktree",
  push: "branch",
} as const;
const readOnly = { ...unasked, write: "none" } as const;

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
    autonomy: unasked,
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
        checked: true,
      },
    ],
    exits: [{ to: "planning" }, { to: "canceled" }],
    autonomy: readOnly,
  },
  {
    name: "planning",
    kind: "working",
    role: "planner",
    model: deployment,
    skills: [],
    requires: [
      { key: "plan_doc", description: "a plan doc", checked: true },
      {
        key: "human_move",
        description: "a human move (B5's plan approval gate)",
        checked: false,
      },
    ],
    exits: [{ to: "building", humanGate: "plan approval" }, { to: "canceled" }],
    // The planner only reads (D10), as the specifier does.
    autonomy: readOnly,
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
        checked: true,
      },
      { key: "non_empty_diff", description: "a non-empty diff", checked: true },
      { key: "pr_link", description: "a PR link", checked: true },
    ],
    exits: [{ to: "review" }, { to: "canceled" }],
    autonomy: unasked,
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
        checked: true,
      },
      {
        key: "human_merge",
        description: "a human merge (B5's merge gate)",
        checked: true,
      },
    ],
    exits: [{ to: "done", humanGate: "merge" }, { to: "canceled" }],
    autonomy: unasked,
  },
  {
    name: "done",
    kind: "terminal",
    model: deployment,
    skills: [],
    requires: [],
    exits: [],
    autonomy: unasked,
  },
  {
    name: "canceled",
    kind: "terminal",
    model: deployment,
    skills: [],
    requires: [],
    exits: [],
    autonomy: unasked,
  },
];

// The cases boot the RPC server over a scratch database, and several register git checkouts: past
// vitest's 5 s default on a loaded machine (DEFLAKE).
vi.setConfig({ testTimeout: 60_000 });

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
    expect(v4).not.toHaveProperty("caps");

    // Version 5 (LOB-71) is version 4 with B9's run caps over the wire, and no column WIP limit.
    const v5 = await call((client) =>
      client.getDefinition({ definitionId: DEFAULT, version: 5 }),
    );
    expect(v5.caps).toEqual({ board: 2, task: 1, repo: 2 });
    expect(v5.columns).toEqual(DEFAULT_V3);

    // Version 6 (D10) is version 5 with the `plan` skill bound to `planning`, and nothing else.
    const v6 = await call((client) =>
      client.getDefinition({ definitionId: DEFAULT, version: 6 }),
    );
    expect(v6.caps).toEqual(v5.caps);
    expect(v6.columns).toEqual(
      DEFAULT_V3.map((column) =>
        column.name === "planning" ? { ...column, skills: ["plan"] } : column,
      ),
    );

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
   * D9 over the wire: `getTaskExit` is the checklist a move's refusal is made of. A card in
   * `specifying` with no spec lists `spec_doc` unmet with the reason `moveTask`'s `RequirementUnmet`
   * carries; an unknown card is `TaskNotFound`. Mutation: judge a requirement the move does not (the
   * reasons part), or drop `reason` from the schema — the first expectation fails.
   */
  it("answers a card's exit checklist, the reason a refused move carries, and an unknown card as TaskNotFound", async () => {
    const outcome = await call((client) =>
      Effect.gen(function* () {
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-task-exit-${run}`),
          definitionId: DEFAULT,
        });
        const created = yield* client.createTask({
          boardId: board.id,
          title: "an exit",
          actor: "person:rpc",
        });
        const specifying = yield* client.moveTask({
          taskId: created.id,
          expectedRevision: created.revision,
          to: "specifying",
          actor: "person:rpc",
        });
        const exit = yield* client.getTaskExit({ taskId: created.id });
        const refused = yield* failureOf(
          client.moveTask({
            taskId: created.id,
            expectedRevision: specifying.revision,
            to: "planning",
            actor: "person:rpc",
          }),
        );
        return { exit, refused, specifying };
      }),
    );
    expect(outcome.exit).toMatchObject({
      column: "specifying",
      revision: outcome.specifying.revision,
      requirements: [{ key: "spec_doc", status: "unmet" }],
    });
    const reason = outcome.exit.requirements[0]?.reason ?? "";
    expect(reason).toContain("the card has no spec");
    expect(outcome.refused).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: "spec_doc",
    });
    expect(outcome.refused.message).toContain(reason);

    const missing = TaskId.make(`tsk_${"0".repeat(26)}`);
    const unknown = await call((client) =>
      failureOf(client.getTaskExit({ taskId: missing })),
    );
    expect(unknown).toMatchObject({ _tag: "TaskNotFound", taskId: missing });
  });

  /**
   * S-local-agent-handoff-mcp over the wire: `createTask` carries a handoff patch on the card, and
   * `getTaskHandoff` reads it back with its size and files; a card made without one is `null`, an
   * unknown card `TaskNotFound`, and a patch that adds a credential's shape is refused before it is
   * stored. Mutation: drop `handoff` from `CreateTaskInput`'s schema — the client's encode drops it
   * and the read answers `null`; drop the secret check — the token card is made.
   */
  it("keeps a card's handoff patch and reads it back, null for a plain card and TaskNotFound for an unknown one", async () => {
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "new file mode 100644",
      "index 0000000000000000000000000000000000000000..4b5fa63702dd96796042e92787f464e28f09f17d",
      "--- /dev/null",
      "+++ b/notes.md",
      "@@ -0,0 +1 @@",
      '+say "hi"',
      "",
    ].join("\n");
    // Built at run time, so this file holds no token-shaped literal for a scanner to find.
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const outcome = await call((client) =>
      Effect.gen(function* () {
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-task-handoff-${run}`),
          definitionId: DEFAULT,
        });
        const handed = yield* client.createTask({
          boardId: board.id,
          title: "a handoff",
          actor: "person:rpc",
          handoff: { patch, branch: "feature/local" },
        });
        const plain = yield* client.createTask({
          boardId: board.id,
          title: "no handoff",
          actor: "person:rpc",
        });
        const secret = yield* failureOf(
          client.createTask({
            boardId: board.id,
            title: "a token",
            actor: "person:rpc",
            handoff: { patch: patch.replace('say "hi"', `TOKEN=${token}`) },
          }),
        );
        return {
          handed,
          read: yield* client.getTaskHandoff({ taskId: handed.id }),
          plain: yield* client.getTaskHandoff({ taskId: plain.id }),
          secret,
        };
      }),
    );
    expect(outcome.read).toMatchObject({
      taskId: outcome.handed.id,
      patch,
      branch: "feature/local",
      bytes: new TextEncoder().encode(patch).length,
      files: ["notes.md"],
    });
    expect(outcome.plain).toBeNull();
    expect(outcome.secret).toMatchObject({
      _tag: "InvalidTaskInput",
      field: "handoff.patch",
    });
    expect(outcome.secret.message).toContain(
      "the handoff patch adds what looks like a credential at notes.md:1 (github-token)",
    );
    expect(outcome.secret.message).not.toContain(token);

    const missing = TaskId.make(`tsk_${"0".repeat(26)}`);
    const unknown = await call((client) =>
      failureOf(client.getTaskHandoff({ taskId: missing })),
    );
    expect(unknown).toMatchObject({ _tag: "TaskNotFound", taskId: missing });
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

/**
 * Authoring a definition version over the wire (D4): `defineBoard` against the scratch database's
 * real skill table (the seeded `implement`, and one put over `putSkill` here) and the session layer's
 * role table (`builder` only), so the library the handler checks against is the one a run would
 * resolve from, and every refusal arrives as the typed `InvalidDefinition` a client decodes.
 */
describe("authoring a definition over RPC (D4)", () => {
  const AUTHORED = DefinitionId.make(`authored${run}`);

  const columns = (skills: ReadonlyArray<string>, role = "builder") => [
    {
      name: "todo",
      kind: "resting" as const,
      skills: [],
      requires: [],
      transitions: [{ to: "doing" }],
    },
    {
      name: "doing",
      kind: "working" as const,
      role,
      skills,
      requires: [{ key: "pr_link", description: "a PR link" }],
      transitions: [{ to: "done", gate: "sign-off" }],
      autonomy: { approvalRequired: ["git push"], push: "none" as const },
    },
    {
      name: "done",
      kind: "terminal" as const,
      skills: [],
      requires: [],
      transitions: [],
    },
  ];

  const versionsOf = (id: string) =>
    scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ version: number }>`
          SELECT version FROM board_definitions WHERE id = ${id} ORDER BY version
        `;
        return rows.map((row) => row.version);
      }),
    );

  /**
   * Mutation: describe the input rather than the written row, or resolve the model against no role
   * table — `doing` is not `faux/builder (role)`. Mutation: ignore `dryRun` — the dry run writes v1.
   */
  it("validates a dry run without writing, then writes v1, described, which createBoard pins", async () => {
    const payload = {
      id: AUTHORED,
      name: "Authored over RPC",
      columns: columns(["implement"]),
      initialColumn: "todo",
    };
    const dry = await call((client) =>
      client.defineBoard({ ...payload, dryRun: true }),
    );
    expect(dry.outcome).toBe("validated");
    expect(dry.definition.version).toBe(1);
    expect(await versionsOf(AUTHORED)).toEqual([]);

    // A body actor on an authenticated control plane changes nothing: the author is the credential's (F7).
    const defined = await call((client) =>
      client.defineBoard({ ...payload, actor: "person:someone-else" }),
    );
    expect(defined.outcome).toBe("created");
    expect(defined.definition).toEqual({
      id: AUTHORED,
      version: 1,
      name: "Authored over RPC",
      initialColumn: "todo",
      author: TEST_ACTOR,
      columns: [
        {
          name: "todo",
          kind: "resting",
          model: deployment,
          skills: [],
          requires: [],
          exits: [{ to: "doing" }],
          autonomy: unasked,
        },
        {
          name: "doing",
          kind: "working",
          role: "builder",
          model: { model: BUILDER_MODEL, source: "role" },
          skills: ["implement"],
          requires: [
            { key: "pr_link", description: "a PR link", checked: true },
          ],
          exits: [{ to: "done", humanGate: "sign-off" }],
          // The column's own autonomy (C22), carried over the RPC and described as a run meets it.
          autonomy: {
            approvalRequired: [{ command: "git push", source: "column" }],
            write: "worktree",
            push: "none",
          },
        },
        {
          name: "done",
          kind: "terminal",
          model: deployment,
          skills: [],
          requires: [],
          exits: [],
          autonomy: unasked,
        },
      ],
    });
    expect(await versionsOf(AUTHORED)).toEqual([1]);

    const again = await call((client) => client.defineBoard(payload));
    expect([again.outcome, again.definition.version]).toEqual(["unchanged", 1]);
    expect(await versionsOf(AUTHORED)).toEqual([1]);

    const outcome = await call((client) =>
      Effect.gen(function* () {
        const listed = yield* client.listDefinitions({});
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`factory-test/authored-${run}`),
          definitionId: AUTHORED,
        });
        return { listed, board };
      }),
    );
    expect(
      outcome.listed
        .find((definition) => definition.id === AUTHORED)
        ?.versions.map((version) => version.version),
    ).toEqual([1]);
    expect(outcome.board.definitionVersion).toBe(1);
  });

  /**
   * The author over the wire (F7): `getDefinition` and `listDefinitions` carry the credential's actor
   * for a version someone wrote, and nothing for a seeded one; an `unchanged` answer and a dry run
   * write no row. Mutation: take the actor from the body, or skip `attributed` — the author is
   * `person:someone-else`, or absent.
   */
  it("attributes a version to the caller's credential, and names no author for a seeded one", async () => {
    const id = DefinitionId.make(`authorship${run}`);
    const payload = {
      id,
      name: "Authorship",
      columns: columns(["implement"]),
      initialColumn: "todo",
    };
    await call((client) =>
      client.defineBoard({ ...payload, actor: "person:someone-else" }),
    );
    const again = await call((client) =>
      client.defineBoard({ ...payload, actor: "person:someone-else" }),
    );
    expect(again.outcome).toBe("unchanged");
    const dry = await call((client) =>
      client.defineBoard({ ...payload, name: "next", dryRun: true }),
    );
    expect(dry.definition.author).toBeUndefined();
    expect(await versionsOf(id)).toEqual([1]);

    const read = await call((client) =>
      Effect.gen(function* () {
        return {
          written: yield* client.getDefinition({ definitionId: id }),
          seeded: yield* client.getDefinition({
            definitionId: DEFAULT,
            version: 1,
          }),
          listed: yield* client.listDefinitions({}),
        };
      }),
    );
    expect(read.written.author).toBe(TEST_ACTOR);
    expect("author" in read.seeded).toBe(false);
    const versions = (definitionId: string) =>
      read.listed.find((definition) => definition.id === definitionId)
        ?.versions ?? [];
    expect(versions(id).map((version) => version.author)).toEqual([TEST_ACTOR]);
    expect(versions(DEFAULT).every((v) => v.author === undefined)).toBe(true);
  });

  /**
   * `getDefinitionSource` (F8): the file `defineBoard` takes, round-tripping — sent back whole it is
   * `unchanged`, with one field edited it is a new version differing in that field only, and it
   * carries neither the version nor the author. A seeded legacy version has its moves and initial
   * column spelled out. Mutation: describe the version rather than materialize it — the columns have
   * `exits` and no `transitions`.
   */
  it("answers the file defineBoard accepts for a version, and a round trip is unchanged", async () => {
    const id = DefinitionId.make(`source${run}`);
    const payload = {
      id,
      name: "Source",
      // `done` carries no `transitions` key, as an author may write a terminal column: the file must
      // not add one, or it is a different version to `defineBoard`'s comparison.
      columns: columns(["implement"]).map(({ transitions, ...column }) =>
        column.kind === "terminal" ? column : { ...column, transitions },
      ),
      initialColumn: "todo",
      caps: { board: 3 },
    };
    await call((client) => client.defineBoard(payload));
    const source = await call((client) =>
      client.getDefinitionSource({ definitionId: id, version: 1 }),
    );
    expect(source).toEqual(payload);
    expect(Object.keys(source).toSorted()).toEqual([
      "caps",
      "columns",
      "id",
      "initialColumn",
      "name",
    ]);

    const back = await call((client) =>
      client.defineBoard({ ...source, dryRun: true }),
    );
    expect([back.outcome, back.definition.version]).toEqual(["unchanged", 1]);
    const edited = await call((client) =>
      client.defineBoard({ ...source, name: "Source, edited" }),
    );
    expect([edited.outcome, edited.definition.version]).toEqual(["created", 2]);
    const v2 = await call((client) =>
      client.getDefinitionSource({ definitionId: id, version: 2 }),
    );
    expect({ ...v2, name: source.name }).toEqual(source);
    expect(v2.name).toBe("Source, edited");

    const legacy = await call((client) =>
      client.getDefinitionSource({
        definitionId: DEFAULT,
        version: 1,
      }),
    );
    expect(legacy.initialColumn).toBe("intake");
    expect(
      legacy.columns.every((column) => column.transitions !== undefined),
    ).toBe(true);
    expect(
      legacy.columns.find((column) => column.name === "intake")?.transitions,
    ).toEqual([{ to: "specifying" }, { to: "canceled" }]);

    const missing = await call((client) =>
      failureOf(client.getDefinitionSource({ definitionId: id, version: 9 })),
    );
    expect(missing).toMatchObject({ _tag: "DefinitionNotFound", version: 9 });
  });

  /**
   * Mutation: check skills against a fixed list, or read the library once when the handler is built
   * — the skill put here is still unknown. Mutation: hand the rules no role table — `buidler` passes.
   */
  it("refuses a skill the library lacks until it is put, and a role the role table lacks, writing nothing", async () => {
    const skill = `authoring-${run}`;
    const id = DefinitionId.make(`refused${run}`);
    const unknownSkill = await call((client) =>
      failureOf(
        client.defineBoard({
          id,
          name: "Refused",
          columns: columns(["implement", skill]),
          initialColumn: "todo",
        }),
      ),
    );
    expect(unknownSkill).toMatchObject({
      _tag: "InvalidDefinition",
      definitionId: id,
      field: "columns[1].skills[1]",
      problems: [
        {
          field: "columns[1].skills[1]",
          message: `column "doing" binds skill "${skill}", which the skill library does not hold: put it first (factory skill put)`,
        },
      ],
    });

    const unknownRole = await call((client) =>
      failureOf(
        client.defineBoard({
          id,
          name: "Refused",
          columns: columns(["implement"], "buidler"),
          initialColumn: "todo",
        }),
      ),
    );
    expect(unknownRole).toMatchObject({
      _tag: "InvalidDefinition",
      field: "columns[1].role",
    });
    expect(await versionsOf(id)).toEqual([]);

    const defined = await call((client) =>
      Effect.gen(function* () {
        yield* client.putSkill({
          name: skill,
          description: "a skill put for this case",
          body: "Do the thing.",
        });
        return yield* client.defineBoard({
          id,
          name: "Refused, then fixed",
          columns: columns(["implement", skill]),
          initialColumn: "todo",
        });
      }),
    );
    expect([defined.outcome, defined.definition.version]).toEqual([
      "created",
      1,
    ]);
    expect(await versionsOf(id)).toEqual([1]);
  });
});

/**
 * The editor's pickers over the wire (D6): `getDefinitionVocabulary` answers the keys and roles the
 * `defineBoard` handler's rules accept — this file's role table (`builder`), the harness's roles,
 * and every role a held definition declares, read when asked rather than when the handler is built.
 */
describe("the definition vocabulary over RPC (D6)", () => {
  /**
   * Mutation: answer the role table alone — `specifier` and `planner` go missing. Mutation: read the
   * declared roles once — the row written here is not offered. Mutation: offer an unknown key.
   */
  it("offers every known key and the roles defineBoard accepts, a newly declared role included", async () => {
    const before = await call((client) => client.getDefinitionVocabulary({}));
    expect(before.requirements.map((option) => option.key)).toEqual([
      "human_merge",
      "human_move",
      "non_empty_diff",
      "plan_doc",
      "pr_link",
      "review_verdict",
      "run_completed",
      "spec_doc",
      "verified",
    ]);
    expect(
      before.requirements.find((option) => option.key === "human_move"),
    ).toMatchObject({ checked: false, humanGate: true });
    expect(
      before.requirements.find((option) => option.key === "pr_link"),
    ).toMatchObject({ checked: true, humanGate: false });
    expect(before.roles).toEqual(
      expect.arrayContaining(["builder", "planner", "reviewer", "specifier"]),
    );
    const role = `triager${run}`;
    expect(before.roles).not.toContain(role);

    await scratch.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const columns = JSON.stringify([
          { name: "triage", kind: "working", role, skills: [], requires: [] },
        ]);
        yield* sql`
          INSERT INTO board_definitions (id, version, name, columns)
          VALUES (${`vocab${run}`}, 1, 'Declares a role', ${columns}::jsonb)
        `;
      }),
    );
    const after = await call((client) => client.getDefinitionVocabulary({}));
    expect(after.roles).toContain(role);
    expect(after.roles).toEqual([...after.roles].toSorted());

    // A role the vocabulary offers is one defineBoard takes under this role table.
    const defined = await call((client) =>
      client.defineBoard({
        id: DefinitionId.make(`vocabuse${run}`),
        name: "Uses an offered role",
        initialColumn: "todo",
        columns: [
          {
            name: "todo",
            kind: "working",
            role,
            skills: [],
            requires: [],
            transitions: [{ to: "done" }],
          },
          {
            name: "done",
            kind: "terminal",
            skills: [],
            requires: [],
            transitions: [],
          },
        ],
      }),
    );
    expect(defined.outcome).toBe("created");
  });

  /**
   * Whether a typed role name is on offer (F4) is the role table's emptiness, as `defineBoard`'s
   * rules read it. Mutation: always say closed — a deployment with no table cannot name a new role in
   * the browser; always say open — a typed typo the server refuses is offered. The same role is then
   * sent to both control planes, so the flag is proven to be the rule and not a copy of it.
   */
  it("says roles are open exactly when the deployment has no role table, and defineBoard agrees", async () => {
    const closed = await call((client) => client.getDefinitionVocabulary({}));
    const opened = await callOpen((client) =>
      client.getDefinitionVocabulary({}),
    );
    expect(closed.rolesOpen).toBe(false);
    expect(opened.rolesOpen).toBe(true);
    // Without a table the harness's roles are still listed.
    expect(opened.roles).toEqual(
      expect.arrayContaining(["planner", "reviewer", "specifier"]),
    );

    const novel = `brand-new-${run}`;
    const input = (id: string) => ({
      id: DefinitionId.make(id),
      name: "Names a role of its own",
      initialColumn: "todo",
      columns: [
        {
          name: "todo",
          kind: "working" as const,
          role: novel,
          skills: [],
          requires: [],
          transitions: [{ to: "done" }],
        },
        {
          name: "done",
          kind: "terminal" as const,
          skills: [],
          requires: [],
          transitions: [],
        },
      ],
    });
    const refused = await call((client) =>
      failureOf(client.defineBoard(input(`closedrole${run}`))),
    );
    expect(refused).toMatchObject({ _tag: "InvalidDefinition" });
    const accepted = await callOpen((client) =>
      client.defineBoard(input(`openrole${run}`)),
    );
    expect(accepted.outcome).toBe("created");
    expect(accepted.definition.columns[0]?.role).toBe(novel);
  });
});

describe("upgrading a board over RPC (D5)", () => {
  /**
   * `upgradeBoard` over the wire: the pin moves and the answer names it, a stale expected version is
   * the typed `StaleBoardVersion`, and a refused migration arrives as `CardMigrationRefused` with each
   * card it names. Mutation: drop either error from the RPC's error schema — the client decodes a
   * defect, not the tag.
   */
  it("moves the pin, and answers a stale version and a refused migration as typed refusals", async () => {
    const outcome = await call((client) =>
      Effect.gen(function* () {
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-board-upgrade-${run}`),
          definitionId: DEFAULT,
          definitionVersion: 2,
        });
        const old = yield* client.createTask({
          boardId: board.id,
          title: "made on v2",
          actor: "person:lukas",
        });
        const upgraded = yield* client.upgradeBoard({
          boardId: board.id,
          toVersion: 3,
          expectedVersion: 2,
          actor: "person:lukas",
        });
        const stale = yield* failureOf(
          client.upgradeBoard({
            boardId: board.id,
            toVersion: 3,
            expectedVersion: 2,
            migrateCards: { intake: "intake" },
            actor: "person:lukas",
          }),
        );
        const refused = yield* failureOf(
          client.upgradeBoard({
            boardId: board.id,
            toVersion: 3,
            expectedVersion: 3,
            migrateCards: { review: "review" },
            actor: "person:lukas",
          }),
        );
        const fresh = yield* client.createTask({
          boardId: board.id,
          title: "made on v3",
          actor: "person:lukas",
        });
        return { old, upgraded, stale, refused, fresh };
      }),
    );
    expect(outcome.upgraded).toMatchObject({
      instance: { definitionVersion: 3 },
      fromVersion: 2,
      repinned: [],
      unmigrated: 1,
    });
    expect(outcome.stale).toMatchObject({
      _tag: "StaleBoardVersion",
      expected: 2,
      actual: 3,
    });
    expect(outcome.refused).toMatchObject({
      _tag: "CardMigrationRefused",
      cards: [
        { taskId: outcome.old.id, column: "intake", reason: "unmapped_column" },
      ],
    });
    expect(outcome.old.definitionVersion).toBe(2);
    expect(outcome.fresh.definitionVersion).toBe(3);
  });
});
