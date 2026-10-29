/**
 * MCP tools through the real service (S-agent-mcp-tools): which registered servers an open offers,
 * decided by `mcpFor` from the repository's allowlist and the repo's secrets, and where the open
 * connects to them — before the owners' gate (`mcpListingFor`), so a server that never answers holds
 * no other session.
 *
 * - A repo that allows three registered servers, and holds the secret of one, one it cannot read
 *   (stored under another key) and not the third: the open offers the first's tool alone, the fake
 *   sees the first's bearer token, and the other two never see a request. The token a tool result
 *   echoes is masked in the transcript.
 * - A repo that allows a server which accepts the connection and never answers: while its open
 *   waits on the server, another session opens and is interrupted; once the server is gone, the
 *   waiting open goes on without that server's tools.
 *
 * The MCP servers are loopback fakes (`@repo/harness`'s `mcpFake`, and a TCP listener that never
 * answers), never a real one. The model is the faux, calling the tracker's tool after its `bash`.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RepoSlug,
  type SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import { SecretName } from "@repo/domain/Secret";
import {
  createFauxModelAccess,
  DEFAULT_AUTONOMY,
  mcpToolName,
  readPolicyRecord,
} from "@repo/harness";
import { startFakeMcpServer, type FakeMcpServer } from "@repo/harness/mcpFake";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSecretService, SecretService } from "./SecretService";
import { SessionService, SessionServiceLive } from "./SessionService";

const RUN = randomBytes(4).toString("hex");
const scratch = mkdtempSync(join(tmpdir(), "factory-core-mcp-"));

/** Obviously fake, and unique to this run. */
const TOKEN = `fake-mcp-token-${randomBytes(8).toString("hex")}`;
const STORE_KEY = randomBytes(32);
/** Another deployment's key: a value stored under it is one this store cannot read. */
const OTHER_KEY = randomBytes(32);

const READ = "get_issue";
const READ_NAME = mcpToolName("tracker", READ);

let fake: FakeMcpServer;
/** A server that takes the connection and never answers; its sockets, so a case can let go of them. */
let hole: ReturnType<typeof createNetServer>;
const holeSockets: Socket[] = [];
let holePort = 0;
let runtime: ManagedRuntime.ManagedRuntime<
  SessionService | SecretService | SqlClient,
  unknown
>;
const slugs: RepoSlug[] = [];

const readTool = (answer: (id: string) => string) => ({
  name: READ,
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  answer: (args: Readonly<Record<string, unknown>>) =>
    answer(String(args["id"])),
});

beforeAll(async () => {
  fake = await startFakeMcpServer({
    servers: {
      // A server that echoes the token it was given, as a careless one might.
      tracker: [readTool((id) => `issue ${id} (asked with ${TOKEN})`)],
      missing: [readTool((id) => `missing ${id}`)],
      garbled: [readTool((id) => `garbled ${id}`)],
    },
  });
  hole = createNetServer((socket) => {
    holeSockets.push(socket);
  });
  hole.listen(0, "127.0.0.1");
  await once(hole, "listening");
  const address = hole.address();
  if (address === null || typeof address === "string")
    throw new Error("the silent server did not bind a TCP port");
  holePort = address.port;
  runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: createFauxModelAccess({
        fauxCommand: "echo faux-ok",
        fauxMcpCalls: [{ tool: READ_NAME, arguments: { id: "ISS-7" } }],
      }).access,
      sessionRoot: join(scratch, "sessions"),
      autonomy: {
        ...DEFAULT_AUTONOMY,
        mcpServers: [
          {
            name: "tracker",
            url: `${fake.url}/tracker`,
            secret: SecretName.make("TRACKER_MCP_TOKEN"),
          },
          {
            name: "missing",
            url: `${fake.url}/missing`,
            secret: SecretName.make("MISSING_MCP_TOKEN"),
          },
          {
            name: "garbled",
            url: `${fake.url}/garbled`,
            secret: SecretName.make("GARBLED_MCP_TOKEN"),
          },
          { name: "silent", url: `http://127.0.0.1:${holePort}/mcp` },
        ],
      },
    }).pipe(
      Layer.provideMerge(
        Layer.effect(
          SecretService,
          Effect.map(makeSecretService(STORE_KEY), SecretService.of),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
});

afterAll(async () => {
  for (const socket of holeSockets) socket.destroy();
  hole.close();
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      for (const repo of slugs) {
        yield* sql`DELETE FROM log_checkpoints WHERE log_id IN (SELECT id FROM sessions WHERE repo = ${repo})`;
        yield* sql`DELETE FROM sessions WHERE repo = ${repo}`;
        yield* sql`DELETE FROM repos WHERE slug = ${repo}`;
      }
    }),
  );
  await runtime.dispose();
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
}, 60_000);

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** A checkout with `.factory/config` allowing `mcp`, registered under a fresh slug. */
const register = (name: string, mcp: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const root = join(scratch, "repos", name);
    mkdirSync(root, { recursive: true });
    const git = (command: string) =>
      execSync(command, { cwd: root, stdio: "ignore" });
    git("git init -q -b main");
    git("git config user.email mcp@localhost");
    git("git config user.name mcp");
    const config = join(root, ".factory/config");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ policy: { mcp } }));
    git("git add -A");
    git("git commit -q -m base");
    const repo = RepoSlug.make(`mcp-${RUN}/${name}`);
    slugs.push(repo);
    yield* sessions.registerRepo({
      repo,
      url: `https://example.invalid/${name}.git`,
      defaultBaseRef: "main",
      localPath: root,
    });
    return repo;
  });

/** The policy record the log holds, read without owning it. */
const recorded = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      readPolicyRecord,
      (storage) => Effect.promise(() => storage.dispose()),
    );
  });

const mcpResults = (snapshot: SessionSnapshot) =>
  snapshot.entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === READ_NAME,
  );

const ALLOW_READ = { tools: [READ] };

describe("the MCP servers an open offers", () => {
  /**
   * Mutation: offer a server whose secret is missing (drop `mcpFor`'s `continue`) — the fake sees
   * a request on `/missing` and the record lists its tool. Mutation: drop `mcp.secrets` from the
   * masked values — the echoed token is in the transcript.
   */
  it("offers the server whose secret the repo holds, and neither one whose secret it lacks nor one it cannot read", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const secrets = yield* SecretService;
        const repo = yield* register("granted", {
          tracker: ALLOW_READ,
          missing: ALLOW_READ,
          garbled: ALLOW_READ,
        });
        yield* secrets.set({
          repo,
          name: SecretName.make("TRACKER_MCP_TOKEN"),
          value: Redacted.make(TOKEN),
        });
        // Stored by a deployment with another key: present, but unreadable here.
        const other = yield* makeSecretService(OTHER_KEY);
        yield* other.set({
          repo,
          name: SecretName.make("GARBLED_MCP_TOKEN"),
          value: Redacted.make(`garbled-${TOKEN}`),
        });
        const created = yield* sessions.create({ repo });
        yield* sessions.send({ sessionId: created.id, content: "look" });
        yield* waitUntil(
          Effect.map(
            sessions.get(created.id),
            (snapshot) =>
              !snapshot.live.busy && mcpResults(snapshot).length > 0,
          ),
          "the MCP call's result",
        );
        return {
          snapshot: yield* sessions.get(created.id),
          record: yield* recorded(created.id),
        };
      }),
    );

    expect(outcome.record?.effective.mcpTools).toEqual([
      { name: READ_NAME, server: "tracker", tool: READ, gated: false },
    ]);
    expect(outcome.record?.repo.mcp).toEqual({
      tracker: { tools: [READ], approvalRequired: [] },
      missing: { tools: [READ], approvalRequired: [] },
      garbled: { tools: [READ], approvalRequired: [] },
    });
    // The tracker got its token; the other two were never contacted.
    expect(fake.calls.filter((call) => call.path === "/tracker")).toEqual([
      {
        path: "/tracker",
        tool: READ,
        arguments: { id: "ISS-7" },
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(
      fake.requests.filter(
        (request) => request.path === "/missing" || request.path === "/garbled",
      ),
    ).toEqual([]);
    // The answer reached the transcript, with the echoed token masked.
    const result = mcpResults(outcome.snapshot)[0];
    expect(result?.kind === "toolResult" && result.text).toContain(
      "issue ISS-7",
    );
    expect(JSON.stringify(outcome.snapshot.entries)).not.toContain(TOKEN);
  }, 120_000);

  /**
   * Mutation: connect under the owners' gate (as before) — the second session's open waits behind
   * the silent server and the race below times out.
   */
  it("holds no other session's open or interrupt while a server never answers", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const repo = yield* register("silent", { silent: ALLOW_READ });
        const waiting = yield* Effect.forkChild(sessions.create({ repo }));
        // The silent open is in its handshake: the server has its connection.
        yield* waitUntil(
          Effect.sync(() => holeSockets.length > 0),
          "the silent server's connection",
        );
        const other = yield* sessions.create({}).pipe(
          Effect.flatMap((summary) =>
            Effect.as(sessions.interrupt(summary.id), summary),
          ),
          Effect.timeout("10 seconds"),
        );
        const stillWaiting = waiting.pollUnsafe() === undefined;
        // The server goes away: the waiting open goes on without its tools.
        for (const socket of holeSockets) socket.destroy();
        const created = yield* Fiber.join(waiting);
        return {
          other,
          stillWaiting,
          record: yield* recorded(created.id),
        };
      }),
    );

    expect(outcome.other.id).toBeDefined();
    expect(outcome.stillWaiting).toBe(true);
    expect(outcome.record?.effective.mcpTools).toEqual([]);
  }, 120_000);
});
