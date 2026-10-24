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

/**
 * A fake that answers per request rather than with one canned response, so a case can drive the
 * duplicate path: the create is refused and the lookup that follows it answers the existing PR.
 *
 * `answers` returns the status and body for a request; the record keeps the full URL so a case can
 * check which API root the client called, not only which path.
 */
const makeRoutedFake = (
  answers: (
    request: { readonly method: string; readonly path: string },
  ) => { readonly status: number; readonly body: unknown },
) => {
  const requests: Array<{
    method: string;
    path: string;
    href: string;
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
        const answer = answers({ method: request.method, path: url.pathname });
        requests.push({
          method: request.method,
          path: url.pathname,
          href: url.href,
          body: reqBody,
        });
        const text = yield* Schema.encodeEffect(Json)(answer.body).pipe(
          Effect.orDie,
        );
        const response = new Response(text, {
          status: answer.status,
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

  it("adopts the PR GitHub already opened when it refuses a duplicate", async () => {
    const existing = {
      number: 12,
      url: "https://github.com/o/r/pull/12",
    };
    const { requests, client } = makeRoutedFake(({ method }) =>
      method === "POST"
        ? {
            status: 422,
            body: {
              message: "Validation Failed",
              errors: [
                { message: "A pull request already exists for o:factory/s-1." },
              ],
            },
          }
        : { status: 200, body: [existing] },
    );
    const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
    const opened = await Effect.runPromise(
      createPullRequest({
        repo: "o/r" as RepoSlug,
        base: "main",
        head: "factory/s-1",
        title: "PR",
        body: "b",
        apiUrl: "http://127.0.0.1:9411",
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(CredentialProvider, provider), client),
        ),
      ),
    );
    expect(opened).toEqual(existing);
    // The lookup is what makes the refused create an answer: it asks for this head, on this base.
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requests[1]!.path).toBe("/repos/o/r/pulls");
    expect(requests[1]!.href).toContain("head=o%3Afactory%2Fs-1");
    expect(requests[1]!.href).toContain("base=main");
    // And it is the configured root, not api.github.com: the fake never sees github.com.
    expect(requests[0]!.href.startsWith("http://127.0.0.1:9411/")).toBe(true);
  });

  it("reports a duplicate that names no existing PR as a typed failure", async () => {
    const { requests, client } = makeRoutedFake(({ method }) =>
      method === "POST"
        ? { status: 422, body: { message: "Validation Failed" } }
        : { status: 200, body: [] },
    );
    const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
    const result = await Effect.runPromiseExit(
      createPullRequest({
        repo: "o/r" as RepoSlug,
        base: "main",
        head: "factory/s-1",
        title: "PR",
        body: "b",
        apiUrl: "http://127.0.0.1:9411",
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(CredentialProvider, provider), client),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("unreachable");
    const error = result.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail"
        ? [reason.error as { operation: string; message: string }]
        : [],
    )[0];
    expect(error?.operation).toBe("createPullRequest");
    expect(error?.message).toBe("GitHub answered HTTP 422");
    expect(requests).toHaveLength(2);
  });

  it("calls GITHUB_API_URL when the caller names no root", async () => {
    const previous = process.env["GITHUB_API_URL"];
    process.env["GITHUB_API_URL"] = "http://127.0.0.1:9411";
    try {
      const { requests, client } = makeRoutedFake(() => ({
        status: 201,
        body: { number: 3, url: "http://127.0.0.1:9411/o/r/pull/3" },
      }));
      const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
      await Effect.runPromise(
        createPullRequest({
          repo: "o/r" as RepoSlug,
          base: "main",
          head: "factory/s-1",
          title: "PR",
          body: "b",
        }).pipe(
          Effect.provide(
            Layer.merge(Layer.succeed(CredentialProvider, provider), client),
          ),
        ),
      );
      expect(requests[0]!.href.startsWith("http://127.0.0.1:9411/")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["GITHUB_API_URL"];
      else process.env["GITHUB_API_URL"] = previous;
    }
  });
});
