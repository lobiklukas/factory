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
 * The session service is the real one on the run's Postgres (`DATABASE_URL`). The forge is an
 * in-memory `HttpClient` handed to the router layer, so nothing here reaches GitHub: the handler
 * must pass *its* client and credential to the step, and the ledger below is the proof it did.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  CredentialError,
  CredentialProvider,
  SessionServiceLive,
} from "@repo/core";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, Redacted } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { afterAll, describe, expect, it } from "vitest";
import { SessionRpcLive } from "./Session";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-rpc-"));

/** A slug per run: the fake numbers PRs per repo, and a database may hold an earlier run's rows. */
const run = randomBytes(4).toString("hex");
const repo = RepoSlug.make(`acme/rpc-pr-${run}`);
/** The forge answers 500 for this one: a `PrError` the wire has to carry. */
const brokenForge = RepoSlug.make(`acme/rpc-pr-broken-${run}`);
/** The credential provider has no token for this one: a `CredentialError` on the wire. */
const noToken = RepoSlug.make(`acme/rpc-pr-no-token-${run}`);

/** Every request the forge was asked, so "one PR for two calls" is a count. */
const ledger: Array<{ readonly method: string; readonly path: string }> = [];

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
    ledger.push({ method: request.method, path: url.pathname });
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
        model: createModelAccess("faux"),
        sessionRoot,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
  { disableLogger: true },
);

afterAll(() => dispose());

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
          head: `factory/${created.id}`,
          base: "main",
        };
        const opened = yield* client.openPullRequest(asked);
        const repeated = yield* client.openPullRequest(asked);
        const snapshot = yield* client.getSession({ sessionId: created.id });
        return { opened, repeated, prUrl: snapshot.session.prUrl };
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
    expect(
      ledger.filter((entry) => entry.path === `/repos/${repo}/pulls`),
    ).toEqual([{ method: "POST", path: `/repos/${repo}/pulls` }]);
  }, 120_000);

  it("carries each of the step's failures across the wire with its own tag", async () => {
    const failures = await call((client) =>
      Effect.gen(function* () {
        const open = (sessionId: SessionId) =>
          client.openPullRequest({
            sessionId,
            title: "factory: refused",
            head: `factory/${sessionId}`,
            base: "main",
          });
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
