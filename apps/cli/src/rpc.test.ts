/**
 * The CLI sends the control-plane credential (LOB-20): every client it builds — `SessionClient` and
 * `BoardClient`, which every command uses — carries `FACTORY_API_TOKEN` as a bearer token, and sends
 * no `Authorization` header when the variable is unset or empty.
 *
 * The server is a loopback `node:http` server that records the header each request arrived with and answers
 * with an error, so the call fails after the request left; what is asserted is what was sent.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigProvider, Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { BoardClient, SessionClient } from "./rpc";

const seen: Array<string | null> = [];
const server = createServer((request, response) => {
  seen.push(request.headers.authorization ?? null);
  response.statusCode = 500;
  response.end("no");
});
await once(server.listen(0, "127.0.0.1"), "listening");
afterAll(() => {
  server.close();
});

const address = server.address() as AddressInfo;
const apiUrl = `http://127.0.0.1:${address.port}`;

/** One call through each client with `env` as the whole environment; the header each one sent. */
const sentWith = async (env: Record<string, string>) => {
  seen.length = 0;
  const config = ConfigProvider.layer(ConfigProvider.fromEnv({ env }));
  await Effect.runPromise(
    Effect.gen(function* () {
      const { client } = yield* SessionClient;
      yield* Effect.ignore(client.listSessions({}));
    }).pipe(
      Effect.provide(SessionClient.layer(apiUrl).pipe(Layer.provide(config))),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const { client } = yield* BoardClient;
      yield* Effect.ignore(client.listBoards({}));
    }).pipe(
      Effect.provide(BoardClient.layer(apiUrl).pipe(Layer.provide(config))),
    ),
  );
  return [...seen];
};

describe("the CLI's RPC clients (LOB-20)", () => {
  it("send FACTORY_API_TOKEN as a bearer token on every call", async () => {
    expect(
      await sentWith({ FACTORY_API_TOKEN: "cli-token-0123456789abcdef" }),
    ).toEqual([
      "Bearer cli-token-0123456789abcdef",
      "Bearer cli-token-0123456789abcdef",
    ]);
  });

  it("send no Authorization header when the variable is unset or empty", async () => {
    expect(await sentWith({})).toEqual([null, null]);
    expect(await sentWith({ FACTORY_API_TOKEN: "" })).toEqual([null, null]);
  });
});
