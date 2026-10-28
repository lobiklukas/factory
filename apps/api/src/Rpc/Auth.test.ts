/**
 * Control-plane identity over the wire (LOB-20).
 *
 * The app's own `SessionRpcLive` — the router `index.ts` mounts — is served through
 * `HttpRouter.toWebHandler` with a two-person token table (`amy`, `bob`), and called with the
 * `RpcClient` over NDJSON the CLI and the dashboard build, once per credential: amy's, bob's, a
 * wrong one, and none. So the refusal is the typed error a real client decodes, and every recorded
 * actor is read back from where it is kept — `sessions.actor`, the `factory.actor` document (through
 * `rebuildIndexes`, which refolds the column from it), the approval decision and its
 * `session_approvals` row, and the card's `task_events` — never from the call's own answer alone.
 *
 * Each write is sent with a body `actor` naming somebody else (`mallory`, or a run's session id),
 * so a handler that passed the body through records `mallory` and turns the case red.
 *
 * The database is this file's own, created on the server `DATABASE_URL` names and dropped in
 * `afterAll`, as `./Task.test.ts` does.
 */
import { execSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialError,
  CredentialProvider,
  rebuildIndexes,
  SessionServiceLive,
  TaskService,
  TaskServiceLive,
  TriggerService,
} from "@repo/core";
import { Unauthenticated } from "@repo/domain/Auth";
import { RpcApi, ServerRpc } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
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
  Option,
  Redacted,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { WebhookRateLimiterLive, WebhookRoutes } from "../Api/Webhook";
import { FauxServerFacts } from "../ServerInfo.test-fake";
import {
  bindRefusal,
  controlPlaneAuthLayer,
  DEFAULT_SHARED_ACTOR,
  isLoopbackHost,
  describeApiAuth,
  MIN_TOKEN_CHARS,
  tokenTableOf,
} from "./Auth";
import { sendingToken, testTokens } from "./Auth.test-fake";
import { ServerRpcHandlers } from "./Server";
import { SessionRpcLive } from "./Session";

const AMY_TOKEN = "amy-token-0123456789abcdef";
const BOB_TOKEN = "bob-token-0123456789abcdef";
/** Long enough to be a token, held by nobody. */
const WRONG_TOKEN = "nobodys-token-0123456789ab";
/** The name every body below declares, which nothing may record. */
const MALLORY = "mallory";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-auth-"));
const openRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-auth-open-"));
const run = randomBytes(4).toString("hex");

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_auth_${run}`;
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

/** The environment as it is now, naming the scratch database (see `./Task.test.ts`). */
const ScratchConfig = ConfigProvider.layer(ConfigProvider.fromEnv());

/** The scratch database itself, for reading back what was recorded. */
const scratch = ManagedRuntime.make(
  PostgresLive.pipe(Layer.provide(ScratchConfig)),
);
const query = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  scratch.runPromise(Effect.orDie(effect));

/**
 * A specifying run's `spec` tool call on the card, in-process: no RPC posts a spec on a run's behalf,
 * and `specifying`'s exit needs one (`spec_doc`, D9). Yields the revision the card is at after it.
 */
const declareSpec = (taskId: string, run: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const task = yield* tasks.declareSpec({
      taskId,
      actor: run,
      goal: "walk the card on",
      acceptance: ["it reaches planning"],
      gaps: [],
      openQuestions: [],
    });
    return task.revision;
  }).pipe(
    Effect.orDie,
    Effect.provide(
      TaskServiceLive.pipe(
        Layer.provide(PostgresLive),
        Layer.provide(ScratchConfig),
      ),
    ),
  );

/** The card's plan as a planning run's `plan` tool posts it (D10): the exit from planning needs one. */
const declarePlan = (taskId: string, run: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const task = yield* tasks.declarePlan({
      taskId,
      actor: run,
      summary: "walk the card on",
      steps: ["reach building"],
      surfaces: ["api"],
      risks: [],
    });
    return task.revision;
  }).pipe(
    Effect.orDie,
    Effect.provide(
      TaskServiceLive.pipe(
        Layer.provide(PostgresLive),
        Layer.provide(ScratchConfig),
      ),
    ),
  );

/** Nothing here opens a PR. */
const credentials = CredentialProvider.of({
  source: "static-token",
  tokenFor: (asked) =>
    Effect.fail(
      new CredentialError({
        repo: asked,
        code: "missing",
        message: "no forge in this file",
      }),
    ),
});

/**
 * The router `index.ts` mounts, with its own session layer rooted at `root`: amy's and bob's tokens
 * when `secure`, auth off otherwise.
 */
const serve = (secure: boolean, root: string) =>
  HttpRouter.toWebHandler(
    SessionRpcLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          controlPlaneAuthLayer(
            secure
              ? testTokens([
                  ["amy", AMY_TOKEN],
                  ["bob", BOB_TOKEN],
                ])
              : undefined,
          ),
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
          model: createFauxModelAccess().access,
          sessionRoot: root,
        }),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      Layer.provide(ScratchConfig),
    ),
    { disableLogger: true },
  );

const secured = serve(true, sessionRoot);

afterAll(async () => {
  await secured.dispose();
  await scratch.dispose();
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DROP DATABASE IF EXISTS ${sql(scratchName)} WITH (FORCE)`;
    }),
  );
  await admin.dispose();
  rmSync(sessionRoot, { recursive: true, force: true });
  rmSync(openRoot, { recursive: true, force: true });
});

/** The CLI's client over `handler`, sending `token` when there is one. */
const protocolFor = (
  handler: (typeof secured)["handler"],
  token: string | undefined,
) =>
  RpcClient.layerProtocolHttp({
    url: "http://factory.test/rpc",
    ...(token === undefined ? {} : { transformClient: sendingToken(token) }),
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

const callWith =
  (handler: (typeof secured)["handler"], token: string | undefined) =>
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
      ).pipe(Effect.provide(protocolFor(handler, token))),
    );

const asAmy = callWith(secured.handler, AMY_TOKEN);
const asBob = callWith(secured.handler, BOB_TOKEN);
const asNobody = callWith(secured.handler, undefined);
const asStranger = callWith(secured.handler, WRONG_TOKEN);

/** The failure a call answered, as the client decoded it. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error as unknown));

/** A checkout a session's worktree can be cut from, so a replay has a repo to run in. */
const checkout = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "factory-api-rpc-auth-repo-"));
  const git = (command: string) =>
    execSync(command, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  git("git init -b main");
  git("git -c user.email=t@t.com -c user.name=t commit --allow-empty -m base");
  return dir;
};

const actorOf = (sessionId: SessionId) =>
  query(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ actor: string | null }>`
        SELECT actor FROM sessions WHERE id = ${sessionId}
      `;
      return rows[0]?.actor;
    }),
  );

describe("tokenTableOf: what a deployment may configure (LOB-20)", () => {
  const none = {
    token: Option.none(),
    tokens: Option.none(),
    authOff: false,
  } as const;
  const table = (config: {
    readonly token?: string;
    readonly actor?: string;
    readonly tokens?: string;
  }) =>
    Effect.runSync(
      Effect.result(
        tokenTableOf({
          token: Option.map(
            Option.fromUndefinedOr(config.token),
            Redacted.make,
          ),
          actor: config.actor ?? DEFAULT_SHARED_ACTOR,
          authOff: false,
          tokens: Option.map(
            Option.fromUndefinedOr(config.tokens),
            Redacted.make,
          ),
        }),
      ),
    );
  const refusal = (config: Parameters<typeof table>[0]) => {
    const result = table(config);
    if (result._tag !== "Failure") throw new Error("the table was accepted");
    return result.failure.message;
  };
  const actors = (config: Parameters<typeof table>[0]) => {
    const result = table(config);
    if (result._tag !== "Success") throw new Error(String(result.failure));
    return result.success === undefined
      ? undefined
      : [...result.success.actors.values()];
  };

  it("is auth off with nothing set, or only empty values", () => {
    expect(
      Effect.runSync(tokenTableOf({ ...none, actor: DEFAULT_SHARED_ACTOR })),
    ).toBeUndefined();
    expect(actors({ token: "  ", tokens: "" })).toBeUndefined();
    expect(describeApiAuth(undefined)).toContain("OFF");
  });

  it("authenticates the shared token as operator, or as FACTORY_API_ACTOR", () => {
    expect(actors({ token: AMY_TOKEN })).toEqual(["operator"]);
    expect(actors({ token: AMY_TOKEN, actor: "lukas" })).toEqual(["lukas"]);
  });

  it("adds one credential per FACTORY_API_TOKENS entry, beside the shared one", () => {
    expect(
      actors({
        token: AMY_TOKEN,
        tokens: `bob=${BOB_TOKEN}, ci = ${WRONG_TOKEN}`,
      }),
    ).toEqual(["operator", "bob", "ci"]);
    const described = describeApiAuth(
      testTokens([
        ["amy", AMY_TOKEN],
        ["bob", BOB_TOKEN],
      ]),
    );
    expect(described).toContain("amy, bob");
    expect(described).not.toContain(AMY_TOKEN);
  });

  it("refuses a table it cannot trust, naming the entry and never the token", () => {
    const short = "x".repeat(MIN_TOKEN_CHARS - 1);
    const cases = [
      refusal({ token: short }),
      refusal({ tokens: `amy=${AMY_TOKEN}x y` }),
      refusal({ tokens: `amy=${AMY_TOKEN},${BOB_TOKEN}` }),
      refusal({ tokens: `amy=${AMY_TOKEN},bob=${AMY_TOKEN}` }),
      refusal({ token: AMY_TOKEN, actor: "ses_0123456789abcdefghjkmnpqrs" }),
      refusal({ tokens: `trigger:linear=${AMY_TOKEN}` }),
      refusal({ token: AMY_TOKEN, actor: " padded " }),
      // Written the wrong way round: the "actor" is the secret, and must not be echoed either.
      refusal({ tokens: `bob=${BOB_TOKEN},${AMY_TOKEN}=amy` }),
    ];
    expect(cases[0]).toContain("FACTORY_API_TOKEN (as FACTORY_API_ACTOR)");
    expect(cases[0]).toContain(`at least ${MIN_TOKEN_CHARS}`);
    expect(cases[1]).toContain("FACTORY_API_TOKENS entry 1");
    expect(cases[1]).toContain("no whitespace");
    expect(cases[2]).toContain("entry 2 is not actor=token");
    expect(cases[3]).toContain(
      "FACTORY_API_TOKENS entry 2 repeats the token of FACTORY_API_TOKENS entry 1",
    );
    expect(cases[4]).toContain("run's actor");
    expect(cases[5]).toContain("FACTORY_API_TOKENS entry 1");
    expect(cases[5]).toContain("trigger's actor");
    expect(cases[6]).toContain("not a valid actor");
    expect(cases[7]).toContain("FACTORY_API_TOKENS entry 2");
    expect(cases[7]).toContain(`at least ${MIN_TOKEN_CHARS}`);
    for (const message of cases) {
      expect(message).not.toContain(AMY_TOKEN);
      expect(message).not.toContain(BOB_TOKEN);
      expect(message).not.toContain("amy-token");
    }
  });
});

describe("bindRefusal: an open control plane stays on loopback (LOB-20)", () => {
  const table = testTokens([["amy", AMY_TOKEN]]);

  it("lets an open control plane listen on loopback, and beyond it only with FACTORY_API_AUTH=off", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.2",
      "localhost",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
      expect(bindRefusal(undefined, host, false), host).toBeUndefined();
    }
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "factory.internal"]) {
      expect(isLoopbackHost(host), host).toBe(false);
      expect(bindRefusal(undefined, host, false), host).toMatchObject({
        _tag: "ApiAuthRequired",
      });
      expect(bindRefusal(undefined, host, true), host).toBeUndefined();
    }
    expect(bindRefusal(undefined, "0.0.0.0", false)?.message).toContain(
      "FACTORY_API_TOKEN",
    );
  });

  it("lets a token table listen anywhere, and refuses FACTORY_API_AUTH=off beside it", () => {
    expect(bindRefusal(table, "0.0.0.0", false)).toBeUndefined();
    expect(bindRefusal(table, "127.0.0.1", false)).toBeUndefined();
    expect(bindRefusal(table, "0.0.0.0", true)?.message).toContain(
      "contradicts",
    );
  });
});

describe("a call without a credential the control plane knows (LOB-20)", () => {
  it("refuses a unary call with no credential, or a wrong one, as Unauthenticated", async () => {
    const missing = await asNobody((client) =>
      failureOf(client.listSessions({})),
    );
    const invalid = await asStranger((client) =>
      failureOf(client.listSessions({})),
    );
    // Every group carries the middleware, not only the session one.
    const board = await asNobody((client) => failureOf(client.listBoards({})));
    const server = await asStranger((client) =>
      failureOf(client.getServerInfo({})),
    );
    // The two groups whose handlers a missing middleware would not break the build of either:
    // TriggerRoutesRpc never reads `Caller`, and a route decides which repo a delivery starts on.
    const route = await asNobody((client) =>
      failureOf(
        client.addTriggerRoute({
          label: `auth-${run}`,
          repo: RepoSlug.make(`acme/auth-${run}`),
          prompt: "nobody's",
        }),
      ),
    );
    const routes = await asStranger((client) =>
      failureOf(client.listTriggerRoutes({})),
    );
    // The recorded deliveries carry a source's reason text and the ids of the work it started.
    const deliveries = await asNobody((client) =>
      failureOf(client.listTriggerDeliveries({})),
    );
    const approval = await asNobody((client) =>
      failureOf(
        client.decideApproval({
          sessionId: "ses_0123456789abcdefghjkmnpqrs" as SessionId,
          requestId: "req-1",
          decision: "approved",
          actor: MALLORY,
        }),
      ),
    );

    expect(missing).toBeInstanceOf(Unauthenticated);
    expect(missing).toMatchObject({
      _tag: "Unauthenticated",
      reason: "missing",
    });
    expect(invalid).toMatchObject({
      _tag: "Unauthenticated",
      reason: "invalid",
    });
    expect(board).toMatchObject({ _tag: "Unauthenticated", reason: "missing" });
    expect(server).toMatchObject({
      _tag: "Unauthenticated",
      reason: "invalid",
    });
    expect(route).toMatchObject({ _tag: "Unauthenticated", reason: "missing" });
    expect(routes).toMatchObject({
      _tag: "Unauthenticated",
      reason: "invalid",
    });
    expect(deliveries).toMatchObject({
      _tag: "Unauthenticated",
      reason: "missing",
    });
    expect(approval).toMatchObject({
      _tag: "Unauthenticated",
      reason: "missing",
    });
    expect(JSON.stringify(invalid)).not.toContain(WRONG_TOKEN);
  }, 60_000);

  it("refuses the watchSession stream the same way, and serves it to a credential", async () => {
    const created = await asAmy((client) =>
      client.createSession({ title: "watched" }),
    );
    const watch = (
      client: RpcClient.FromGroup<typeof RpcApi, RpcClientError>,
    ) =>
      client
        .watchSession({ sessionId: created.id })
        .pipe(Stream.take(1), Stream.runCollect);

    const missing = await asNobody((client) => failureOf(watch(client)));
    const invalid = await asStranger((client) => failureOf(watch(client)));
    const served = await asAmy(watch);

    expect(missing).toMatchObject({
      _tag: "Unauthenticated",
      reason: "missing",
    });
    expect(invalid).toMatchObject({
      _tag: "Unauthenticated",
      reason: "invalid",
    });
    expect([...served]).toHaveLength(1);
  }, 60_000);

  it("refuses a malformed Authorization header as invalid, over raw NDJSON", async () => {
    const line = JSON.stringify({
      _tag: "Request",
      id: "1",
      tag: "listSessions",
      payload: {},
      headers: [],
    });
    const response = await secured.handler(
      new Request("http://factory.test/rpc", {
        method: "POST",
        headers: {
          "content-type": "application/ndjson",
          authorization: `Basic ${AMY_TOKEN}`,
        },
        body: `${line}\n`,
      }),
    );
    const answer = await response.text();

    expect(answer).toContain('"_tag":"Unauthenticated"');
    expect(answer).toContain('"reason":"invalid"');
  });
});

describe("the actor every write records is the credential's, not the body's (LOB-20)", () => {
  it("records amy for createSession, fork and replay — in sessions.actor and factory.actor — and listSpend groups by her", async () => {
    const repo = RepoSlug.make(`acme/rpc-auth-${run}`);
    const dir = checkout();
    try {
      const made = await asAmy((client) =>
        Effect.gen(function* () {
          yield* client.registerRepo({ repo, localPath: dir });
          const created = yield* client.createSession({
            repo,
            baseRef: "main",
            title: "amy's",
            actor: MALLORY,
          });
          yield* client.sendMessage({ sessionId: created.id, content: "go" });
          return created;
        }),
      );
      // Bob forks and replays amy's session: each new session is his, whatever his body says and
      // whoever owned the source.
      const derived = await asBob((client) =>
        Effect.gen(function* () {
          const fork = yield* client.forkSession({ sessionId: made.id });
          const replay = yield* client.replaySession({ sessionId: made.id });
          const bobs = yield* client.createSession({
            repo,
            baseRef: "main",
            title: "bob's",
            actor: "amy",
          });
          const spend = yield* client.listSpend({});
          return { fork, replay, bobs, spend };
        }),
      );

      expect(await actorOf(made.id)).toBe("amy");
      expect(await actorOf(derived.fork.id)).toBe("bob");
      expect(await actorOf(derived.replay.id)).toBe("bob");
      expect(await actorOf(derived.bobs.id)).toBe("bob");
      const ours = derived.spend.rows.filter((row) => row.repo === repo);
      expect(
        ours
          .map((row) => [row.actor, row.sessions])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["amy", 1],
        ["bob", 3],
      ]);

      // The log holds the actor too: forget the column and refold it from `factory.actor`.
      const ids = [
        made.id,
        derived.fork.id,
        derived.replay.id,
        derived.bobs.id,
      ];
      await query(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`UPDATE sessions SET actor = NULL WHERE id IN ${sql.in(ids)}`;
          yield* rebuildIndexes;
        }),
      );
      expect(await Promise.all(ids.map(actorOf))).toEqual([
        "amy",
        "bob",
        "bob",
        "bob",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("records amy as the approval's decider, in the answer and in session_approvals", async () => {
    const decided = await asAmy((client) =>
      Effect.gen(function* () {
        const created = yield* client.createSession({ title: "gated" });
        yield* client.requestApproval({
          sessionId: created.id,
          requestId: "req-1",
          action: "npm publish",
        });
        const decision = yield* client.decideApproval({
          sessionId: created.id,
          requestId: "req-1",
          decision: "approved",
          actor: MALLORY,
        });
        // The same decision again is the same decision: amy's, not a conflict with mallory's.
        const repeated = yield* client.decideApproval({
          sessionId: created.id,
          requestId: "req-1",
          decision: "approved",
          actor: "someone else",
        });
        return { sessionId: created.id, decision, repeated };
      }),
    );
    const rows = await query(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ actor: string | null }>`
          SELECT actor FROM session_approvals WHERE session_id = ${decided.sessionId}
        `;
      }),
    );

    expect(decided.decision.actor).toBe("amy");
    expect(decided.repeated.actor).toBe("amy");
    expect(rows.map((row) => row.actor)).toEqual(["amy"]);
  }, 60_000);

  it("records amy on every board write — create, move, block, unblock, update, comment — and on the run board start opens", async () => {
    const outcome = await asAmy((client) =>
      Effect.gen(function* () {
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-auth-board-${run}`),
          definitionId: DefinitionId.make("default"),
        });
        const created = yield* client.createTask({
          boardId: board.id,
          title: "a card",
          actor: MALLORY,
        });
        // `board start`: a run opened against the card, through createSession.
        const started = yield* client.createSession({
          title: created.title,
          taskId: created.id,
          taskColumn: created.column,
          actor: MALLORY,
        });
        const specifying = yield* client.moveTask({
          taskId: created.id,
          expectedRevision: created.revision,
          to: "specifying",
          actor: MALLORY,
        });
        const blocked = yield* client.blockTask({
          taskId: created.id,
          expectedRevision: specifying.revision,
          reason: "dependency",
          actor: MALLORY,
        });
        const unblocked = yield* client.unblockTask({
          taskId: created.id,
          expectedRevision: blocked.revision,
          actor: MALLORY,
        });
        const updated = yield* client.updateTask({
          taskId: created.id,
          expectedRevision: unblocked.revision,
          title: "a better card",
          priority: "urgent",
          actor: MALLORY,
        });
        yield* client.commentTask({
          taskId: created.id,
          expectedRevision: updated.revision,
          body: "looks right",
          actor: MALLORY,
        });
        // The run's own spec (its actor is the run, as the tool records it): the exit from
        // specifying needs one.
        const specRevision = yield* declareSpec(created.id, started.id);
        yield* client.moveTask({
          taskId: created.id,
          expectedRevision: specRevision,
          to: "planning",
          actor: MALLORY,
        });
        // The run's own plan, as its tool records it: the exit from planning needs one (D10).
        const planRevision = yield* declarePlan(created.id, started.id);
        // A body naming a run cannot make amy one: the plan-approval gate is hers to cross (B5).
        const building = yield* client.moveTask({
          taskId: created.id,
          expectedRevision: planRevision,
          to: "building",
          actor: started.id,
        });
        const thread = yield* client.listTaskComments({ taskId: created.id });
        return { taskId: created.id, started, building, thread };
      }),
    );
    const events = await query(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ kind: string; actor: string }>`
          SELECT kind, actor FROM task_events WHERE task_id = ${outcome.taskId} ORDER BY id
        `;
      }),
    );

    expect(outcome.building.column).toBe("building");
    expect(events.map((event) => event.kind)).toEqual([
      "created",
      "moved",
      "blocked",
      "unblocked",
      "retitled",
      "priorityChanged",
      "commented",
      "specified",
      "moved",
      "planned",
      "moved",
    ]);
    // Every write the credential made is amy's; the spec and the plan are the run's own, as its
    // tools record them.
    const runs = new Set(["specified", "planned"]);
    expect(
      events.filter((event) => !runs.has(event.kind)).map((e) => e.actor),
    ).toEqual(Array(events.length - 2).fill("amy"));
    expect(events.find((event) => event.kind === "specified")?.actor).toBe(
      outcome.started.id,
    );
    expect(events.find((event) => event.kind === "planned")?.actor).toBe(
      outcome.started.id,
    );
    expect(outcome.thread.map((comment) => comment.actor)).toEqual(["amy"]);
    expect(await actorOf(outcome.started.id)).toBe("amy");
  }, 60_000);
});

describe("a control plane with no token configured (LOB-20)", () => {
  it("serves an unauthenticated call and keeps the actor its caller declared, as before", async () => {
    // Built only now, so its migrations never race the secured router's on the shared database.
    const open = serve(false, openRoot);
    const outcome = await callWith(
      open.handler,
      undefined,
    )((client) =>
      Effect.gen(function* () {
        const created = yield* client.createSession({
          title: "open",
          actor: "declared",
        });
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-auth-open-${run}`),
          definitionId: DefinitionId.make("default"),
        });
        const card = yield* client.createTask({
          boardId: board.id,
          title: "an open card",
          actor: "declared",
        });
        return { created, card };
      }),
    ).finally(() => open.dispose());

    expect(await actorOf(outcome.created.id)).toBe("declared");
    const events = await query(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ actor: string }>`
          SELECT actor FROM task_events WHERE task_id = ${outcome.card.id}
        `;
      }),
    );
    expect(events.map((event) => event.actor)).toEqual(["declared"]);
  }, 60_000);
});

/**
 * The webhook routes sit beside `/rpc` on the same router and are not behind the middleware: a
 * signed delivery needs its route's signature, never a control-plane credential (LOB-81 keeps its
 * own check). Served here with auth on, the way `index.ts` merges the two.
 */
describe("webhooks keep their own signatures (LOB-20)", () => {
  it("accepts a signed delivery with no control-plane credential while the RPC refuses one", async () => {
    const secret = "generic-secret-for-lob-20";
    // oxlint-disable-next-line effecttsgo/process-env -- the route reads its secret per request.
    const saved = process.env["TRIGGER_SECRET"];
    // oxlint-disable-next-line effecttsgo/process-env -- the route reads its secret per request.
    process.env["TRIGGER_SECRET"] = secret;
    const delivered: Array<string> = [];
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(
        RpcServer.layerHttp({
          group: ServerRpc,
          path: "/rpc",
          protocol: "http",
        }).pipe(
          Layer.provide(ServerRpcHandlers),
          Layer.provide(
            Layer.mergeAll(
              controlPlaneAuthLayer(testTokens([["amy", AMY_TOKEN]])),
              FauxServerFacts,
              Layer.succeed(CredentialProvider, credentials),
            ),
          ),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        WebhookRoutes.pipe(
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.succeed(
                TriggerService,
                TriggerService.of({
                  rules: Effect.succeed([]),
                  deliver: (delivery) =>
                    Effect.sync(() => {
                      delivered.push(delivery.event.source);
                      return {
                        status: "skipped",
                        replayed: false,
                        reason: "fake",
                      } as const;
                    }),
                }),
              ),
              WebhookRateLimiterLive,
            ),
          ),
        ),
      ),
      { disableLogger: true },
    );
    try {
      const body = JSON.stringify({ requestId: `lob-20-${run}`, label: "x" });
      const webhook = await handler(
        new Request("http://factory.test/webhooks/generic", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-trigger-signature": createHmac("sha256", secret)
              .update(body)
              .digest("hex"),
          },
          body,
        }),
      );
      const rpc = await handler(
        new Request("http://factory.test/rpc", {
          method: "POST",
          headers: { "content-type": "application/ndjson" },
          body: `${JSON.stringify({ _tag: "Request", id: "1", tag: "getServerInfo", payload: {}, headers: [] })}\n`,
        }),
      );

      expect(webhook.status).toBe(200);
      expect(delivered).toEqual(["generic"]);
      expect(await rpc.text()).toContain('"_tag":"Unauthenticated"');
    } finally {
      await dispose();
      // oxlint-disable-next-line effecttsgo/process-env -- restoring what the case changed.
      if (saved === undefined) delete process.env["TRIGGER_SECRET"];
      // oxlint-disable-next-line effecttsgo/process-env -- restoring what the case changed.
      else process.env["TRIGGER_SECRET"] = saved;
    }
  });
});
