/**
 * The PR step over the wire (LOB-213).
 *
 * `SessionService.openPullRequest` had no caller but tests and in-process scripts: `SessionRpc` had
 * no member for it and this app no handler, so a client that asked answered `Unknown request tag`.
 * These cases serve the app's own `SessionRpcLive` — the router `index.ts` mounts — through
 * `HttpRouter.toWebHandler`, and call it with the same `RpcClient` over NDJSON the CLI and the
 * dashboard build. So the payload, the success union and every error tag are encoded and decoded
 * exactly as a real client sees them; only the socket is missing.
 *
 * The session service is the real one on Postgres, in a database this file creates on the server
 * `DATABASE_URL` names and drops in `afterAll` — as `packages/core/src/SessionService.test.ts` does —
 * so a run leaves no session rows in a developer's dashboard, and its session root is removed too.
 * The forge is an in-memory `HttpClient` handed to the router layer, so nothing here reaches GitHub:
 * the handler must pass *its* client and credential to the step, and the ledger below is the proof it
 * did.
 */
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialError,
  CredentialProvider,
  SessionServiceLive,
} from "@repo/core";
import { RpcApi, SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import {
  DatabaseConfig,
  DatabaseLive,
  PostgresLive,
} from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
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

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-"));
const run = randomBytes(4).toString("hex");

/**
 * The run's own database: created over the configured server's connection, and `DATABASE_URL`
 * pointed at it before the router's layer resolves its config, so every row this file writes is in
 * a database `afterAll` drops.
 */
const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_rpc_${run}`;
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

/** A slug per run: the fake numbers PRs per repo. */
const repo = RepoSlug.make(`acme/rpc-pr-${run}`);
/** The session the raw-payload case opens a PR for: its own repo, so its ledger is its own. */
const rawRepo = RepoSlug.make(`acme/rpc-pr-raw-${run}`);
/** The forge answers 500 for this one: a `PrError` the wire has to carry. */
const brokenForge = RepoSlug.make(`acme/rpc-pr-broken-${run}`);
/** The credential provider has no token for this one: a `CredentialError` on the wire. */
const noToken = RepoSlug.make(`acme/rpc-pr-no-token-${run}`);

/**
 * Every request the forge was asked, so "one PR for two calls" is a count, with the body a create
 * sent, so "the session's own branch was published" is a field.
 */
const ledger: Array<{
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}> = [];

const json =
  (request: Parameters<typeof HttpClientResponse.fromWeb>[0]) =>
  (status: number, body: unknown) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

/**
 * GitHub's two PR routes, as `pr.ts` calls them: a create answers 201 with the page link, the
 * duplicate lookup answers what exists. Anything else is a 404, so a wrong URL fails here.
 */
const forge = HttpClient.make((request, url) =>
  Effect.sync(() => {
    ledger.push({
      method: request.method,
      path: url.pathname,
      ...(request.body._tag === "Uint8Array"
        ? { body: JSON.parse(new TextDecoder().decode(request.body.body)) }
        : {}),
    });
    const answer = json(request);
    const route = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (route === null) return answer(404, { message: "Not Found" });
    const slug = `${route[1]}/${route[2]}`;
    if (slug === brokenForge) return answer(500, { message: "forge down" });
    if (request.method === "GET") return answer(200, []);
    const number = ledger.filter(
      (entry) => entry.method === "POST" && entry.path === url.pathname,
    ).length;
    return answer(201, {
      number,
      url: `https://api.github.com/repos/${slug}/pulls/${number}`,
      html_url: `https://github.com/${slug}/pull/${number}`,
    });
  }),
);

/**
 * The spec a specifier run on this file's cards declares, and the decomposition its faux answers:
 * two proposals under one title, which the validator refuses (LOB-201). Neither script reaches the
 * PR cases above — a scratch session is never offered the `spec` tool and never decomposes.
 */
const WIRE_SPEC = {
  goal: "Carry a refused decomposition across the wire",
  acceptance: ["ProposalsRefused arrives tagged, with its faults"],
  gaps: [],
  openQuestions: [],
};
const DUPLICATE_TITLES = JSON.stringify({
  proposals: [
    { title: "Same", goal: "g", change: "c", acceptance: ["a"] },
    { title: "same", goal: "g", change: "c", acceptance: ["b"] },
  ],
});

const credentials = CredentialProvider.of({
  source: "static-token",
  tokenFor: (asked) =>
    asked === noToken
      ? Effect.fail(
          new CredentialError({
            repo: asked,
            code: "missing",
            message: `no token for ${asked}`,
          }),
        )
      : Effect.succeed(Redacted.make("rpc-test-token")),
});

const { handler, dispose } = HttpRouter.toWebHandler(
  SessionRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, forge),
        Layer.succeed(CredentialProvider, credentials),
      ),
    ),
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess({
          fauxSpec: [WIRE_SPEC],
          fauxDecomposition: DUPLICATE_TITLES,
        }).access,
        sessionRoot,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
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

/** The client the CLI builds, whose HTTP client is the router's web handler instead of a socket. */
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
    client: RpcClient.FromGroup<typeof SessionRpc, RpcClientError>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(SessionRpc);
        return yield* body(client);
      }),
    ).pipe(Effect.provide(ClientProtocol)),
  );

/** The failure a call answered, as the client decoded it: its tag and its fields. */
const failureOf = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => ({ ...error, _tag: error._tag })),
  );

describe("openPullRequest over RPC (LOB-213)", () => {
  it("opens the session's PR once, and a repeat answers it tagged already-open", async () => {
    const result = await call((client) =>
      Effect.gen(function* () {
        const created = yield* client.createSession({
          repo,
          baseRef: "main",
          title: "open a PR over RPC",
        });
        const asked = {
          sessionId: created.id,
          title: "factory: open a PR over RPC",
        };
        const opened = yield* client.openPullRequest(asked);
        const repeated = yield* client.openPullRequest(asked);
        const snapshot = yield* client.getSession({ sessionId: created.id });
        return {
          opened,
          repeated,
          prUrl: snapshot.session.prUrl,
          head: `factory/${created.id}`,
        };
      }),
    );

    const url = `https://github.com/${repo}/pull/1`;
    expect(result.opened).toEqual({ number: 1, url, outcome: "opened" });
    expect(result.repeated).toEqual({
      number: 1,
      url,
      outcome: "already-open",
    });
    // Written by the RPC caller, read back through the index the session list reads.
    expect(result.prUrl).toBe(url);
    // One request for two calls: the handler's forge was asked, and the repeat asked nothing.
    const asked = ledger.filter(
      (entry) => entry.path === `/repos/${repo}/pulls`,
    );
    expect(asked.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `/repos/${repo}/pulls` },
    ]);
    // The server chose the branches: the session's own, onto the base it was cut from.
    expect(asked[0]?.body).toMatchObject({ head: result.head, base: "main" });
  }, 120_000);

  it("ignores a head and base a raw client sends: the branches are the session's (LOB-213)", async () => {
    const created = await call((client) =>
      client.createSession({
        repo: rawRepo,
        baseRef: "main",
        title: "a raw payload",
      }),
    );
    // Not the typed client, which would not send the keys: the NDJSON line a hostile client could
    // write, with refs git would read as options and a branch that is not this session's.
    const line = JSON.stringify({
      _tag: "Request",
      id: "1",
      tag: "openPullRequest",
      payload: {
        sessionId: created.id,
        title: "factory: a raw payload",
        head: "main",
        base: `--output=${join(sessionRoot, "planted")}`,
      },
      headers: [],
    });
    const response = await handler(
      new Request("http://factory.test/rpc", {
        method: "POST",
        headers: { "content-type": "application/ndjson" },
        body: `${line}\n`,
      }),
    );
    const answer = await response.text();

    expect(response.status).toBe(200);
    expect(answer).toContain('"outcome":"opened"');
    const asked = ledger.filter(
      (entry) =>
        entry.method === "POST" && entry.path === `/repos/${rawRepo}/pulls`,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toMatchObject({
      head: `factory/${created.id}`,
      base: "main",
    });
  }, 120_000);

  it("carries each of the step's failures across the wire with its own tag", async () => {
    const failures = await call((client) =>
      Effect.gen(function* () {
        const open = (sessionId: SessionId) =>
          client.openPullRequest({ sessionId, title: "factory: refused" });
        // A session bound to no repo has no PR to open: the service's own refusal.
        const created = yield* client.createSession({ title: "no repo" });
        const unbound = yield* failureOf(open(created.id));
        const broken = yield* client.createSession({
          repo: brokenForge,
          baseRef: "main",
          title: "the forge fails",
        });
        const forgeDown = yield* failureOf(open(broken.id));
        const tokenless = yield* client.createSession({
          repo: noToken,
          baseRef: "main",
          title: "no credential",
        });
        const missing = yield* failureOf(open(tokenless.id));
        return { unbound, forgeDown, missing };
      }),
    );

    expect(failures.unbound).toMatchObject({
      _tag: "SessionError",
      code: "invalid_input",
    });
    expect(failures.forgeDown).toMatchObject({
      _tag: "PrError",
      operation: "createPullRequest",
    });
    expect(failures.missing).toMatchObject({
      _tag: "CredentialError",
      repo: noToken,
      code: "missing",
    });
  }, 120_000);
});

/** `call`, over the whole API group: the decomposition case needs a board and a card first. */
const callApi = <A, E>(
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

describe("proposeDecomposition over RPC (LOB-201)", () => {
  it("carries a session without a spec, and a refused proposal set, across the wire with their own tags", async () => {
    const outcome = await callApi((client) =>
      Effect.gen(function* () {
        const scratch = yield* client.createSession({ title: "no spec" });
        const noSpec = yield* failureOf(
          client.proposeDecomposition({ sessionId: scratch.id }),
        );
        const board = yield* client.createBoard({
          repo: RepoSlug.make(`acme/rpc-decompose-${run}`),
          definitionId: DefinitionId.make("default"),
        });
        const created = yield* client.createTask({
          boardId: board.id,
          title: "a card to decompose",
          actor: "person:rpc",
        });
        const card = yield* client.moveTask({
          taskId: created.id,
          expectedRevision: created.revision,
          to: "specifying",
          actor: "person:rpc",
        });
        const specifier = yield* client.createSession({
          title: card.title,
          taskId: card.id,
          taskColumn: card.column,
        });
        yield* client.sendMessage({
          sessionId: specifier.id,
          content: "specify it",
        });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const snapshot = yield* client.getSession({
            sessionId: specifier.id,
          });
          const specced = snapshot.entries.some(
            (entry) => entry.toolName === "spec" && entry.isError !== true,
          );
          if (specced && !snapshot.live.busy) break;
          yield* Effect.sleep(50);
        }
        const refused = yield* failureOf(
          client.proposeDecomposition({ sessionId: specifier.id }),
        );
        const after = yield* client.getSession({ sessionId: specifier.id });
        return { noSpec, refused, after };
      }),
    );

    expect(outcome.noSpec).toMatchObject({
      _tag: "SessionError",
      code: "invalid_input",
    });
    expect(outcome.refused).toMatchObject({
      _tag: "ProposalsRefused",
      faults: [{ index: 1, reason: "duplicate_title" }],
    });
    // Refused is not stored: the session the client reads back holds no proposals.
    expect(outcome.after.proposedIssues).toBeUndefined();
  }, 120_000);
});

describe("the repo registry over RPC (LOB-253)", () => {
  it("registers, lists and reads a repo, and carries each refusal with its own tag", async () => {
    const checkout = join(sessionRoot, "registry-checkout");
    mkdirSync(join(checkout, ".factory"), { recursive: true });
    execSync("git init -q -b main", { cwd: checkout, stdio: "ignore" });
    writeFileSync(join(checkout, ".factory", "config"), "{}");
    const plain = join(sessionRoot, "registry-plain");
    mkdirSync(plain, { recursive: true });
    const registeredSlug = RepoSlug.make(`acme/rpc-registry-${run}`);
    const unknown = RepoSlug.make(`acme/rpc-registry-unknown-${run}`);
    const auto = RepoSlug.make(`acme/rpc-registry-auto-${run}`);

    const outcome = await call((client) =>
      Effect.gen(function* () {
        const registered = yield* client.registerRepo({
          repo: registeredSlug,
          defaultBaseRef: "main",
          url: "https://example.invalid/registry.git",
          localPath: checkout,
        });
        const rebased = yield* client.registerRepo({
          repo: registeredSlug,
          defaultBaseRef: "trunk",
        });
        yield* client.createSession({ repo: auto, title: "names a new repo" });
        const listed = yield* client.listRepos({});
        const got = yield* client.getRepo({ repo: registeredSlug });
        const missing = yield* failureOf(client.getRepo({ repo: unknown }));
        // The error itself, not `failureOf`'s spread: an error's `message` is not enumerable.
        const notGit = yield* Effect.flip(
          client.registerRepo({ repo: unknown, localPath: plain }),
        );
        const stillMissing = yield* failureOf(
          client.getRepo({ repo: unknown }),
        );
        return {
          registered,
          rebased,
          listed,
          got,
          missing,
          notGit,
          stillMissing,
        };
      }),
    );

    expect(outcome.registered).toMatchObject({
      repo: registeredSlug,
      localPath: checkout,
      defaultBaseRef: "main",
      localPathIsGit: true,
      hasFactoryConfig: true,
      // The work tree sessions are cut from crosses the wire, as git names it.
      workTree: realpathSync(checkout),
    });
    // The second registration named only the base ref: the checkout and URL are kept.
    expect(outcome.rebased).toMatchObject({
      defaultBaseRef: "trunk",
      localPath: checkout,
      url: "https://example.invalid/registry.git",
    });
    expect(outcome.got).toEqual(outcome.rebased);
    const listed = new Map(
      outcome.listed.repos.map((repo) => [repo.repo, repo]),
    );
    expect(listed.get(registeredSlug)).toEqual(outcome.got);
    // The row `createSession` wrote: no URL, no checkout, and so neither checkout fact.
    expect(listed.get(auto)).toMatchObject({
      url: "",
      defaultBaseRef: "main",
      localPathIsGit: false,
      hasFactoryConfig: false,
    });
    expect(listed.get(auto)?.localPath).toBeUndefined();
    expect(listed.has(unknown)).toBe(false);
    expect(outcome.missing).toMatchObject({
      _tag: "RepoNotFound",
      repo: unknown,
    });
    expect(outcome.notGit).toMatchObject({
      _tag: "SessionError",
      code: "invalid_input",
    });
    expect(outcome.notGit.message).toContain(plain);
    // Refused is not written: the slug is still unknown.
    expect(outcome.stillMissing).toMatchObject({ _tag: "RepoNotFound" });
  }, 120_000);
});

describe("createTask over RPC (LOB-255)", () => {
  it("gives a card with no repo its board's, and carries a card naming another repo across the wire as BoardRepoMismatch", async () => {
    const boardRepo = RepoSlug.make(`acme/rpc-card-${run}`);
    const other = RepoSlug.make(`acme/rpc-card-other-${run}`);
    const outcome = await callApi((client) =>
      Effect.gen(function* () {
        const board = yield* client.createBoard({
          repo: boardRepo,
          definitionId: DefinitionId.make("default"),
        });
        const card = yield* client.createTask({
          boardId: board.id,
          title: "no repo named",
          actor: "person:rpc",
        });
        const refused = yield* failureOf(
          client.createTask({
            boardId: board.id,
            title: "another repo named",
            repo: other,
            actor: "person:rpc",
          }),
        );
        const cards = yield* client.listTasks({ boardId: board.id });
        return { board, card, refused, cards };
      }),
    );

    expect(outcome.card.repo).toBe(boardRepo);
    expect(outcome.refused).toMatchObject({
      _tag: "BoardRepoMismatch",
      boardId: outcome.board.id,
      boardRepo,
      repo: other,
    });
    // Refused is not written: the board holds the one card.
    expect(outcome.cards.map((card) => card.id)).toEqual([outcome.card.id]);
  });
});
