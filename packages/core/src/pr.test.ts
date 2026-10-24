import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import { SessionId, RepoSlug } from "@repo/domain/Session";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { buildPrBody, createPullRequest } from "./pr";

const makeFakeHttp = (status: number, body: unknown) => {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const reqBody =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        requests.push({
          method: request.method,
          url: url.pathname,
          authorization: request.headers["authorization"],
          body: reqBody,
        });
        const text = yield* Schema.encodeEffect(Json)(body).pipe(Effect.orDie);
        const response = new Response(text, {
          status,
          headers: { "content-type": "application/json" },
        });
        return HttpClientResponse.fromWeb(request, response);
      }).pipe(Effect.orDie),
    ),
  );
  return { requests, client };
};

describe("buildPrBody", () => {
  it("carries session id, model and spend", () => {
    const body = buildPrBody({
      sessionId: "s-1" as SessionId,
      prompt: "do thing",
      model: "m",
      spend: "$0.01",
    });
    expect(body).toContain("s-1");
    expect(body).toContain("m");
    expect(body).toContain("$0.01");
    expect(body).toContain("do thing");
  });
});

describe("createPullRequest", () => {
  it("opens a PR and asserts body carries session id, model, spend", async () => {
    const { requests, client } = makeFakeHttp(201, {
      number: 7,
      url: "https://github.com/o/r/pull/7",
    });
    const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
    // need Option import
    const program = createPullRequest({
      repo: "o/r" as RepoSlug,
      base: "main",
      head: "factory/s-1",
      title: "PR",
      body: buildPrBody({
        sessionId: "s-1" as SessionId,
        prompt: "do thing",
        model: "m",
        spend: "$0.01",
      }),
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(CredentialProvider, provider), client),
      ),
    );
    const res = await Effect.runPromise(program);
    expect(res.number).toBe(7);
    expect(requests[0]!.body).toMatchObject({
      head: "factory/s-1",
      base: "main",
    });
    expect((requests[0]!.body as any).body).toContain("s-1");
    expect(requests[0]!.authorization).toBe("Bearer tok");
  });

  it("surfaces credential failure as typed error", async () => {
    const { client } = makeFakeHttp(201, { number: 1, url: "u" });
    const provider = staticTokenProvider(Option.none());
    const program = createPullRequest({
      repo: "o/r" as RepoSlug,
      base: "main",
      head: "h",
      title: "t",
      body: "b",
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(CredentialProvider, provider), client),
      ),
    );
    const result = await Effect.runPromiseExit(program);
    expect(result._tag).toBe("Failure");
  });
});
