/**
 * A hand-written fake of the one GitHub endpoint the App token flow calls (LOB-55):
 * `POST /app/installations/{id}/access_tokens`. It sits behind an Effect `HttpClient`, so the
 * provider under test runs unchanged and no request ever leaves the process.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const Json = Schema.fromJsonString(Schema.Unknown);

export type RecordedRequest = {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

export type FakeGitHub = {
  readonly requests: Array<RecordedRequest>;
  readonly client: Layer.Layer<HttpClient.HttpClient>;
};

/**
 * `mint` answers each token request in turn. `status` other than 201 answers with that code and no
 * token, the way GitHub rejects a bad JWT or an unknown installation.
 */
export const makeFakeGitHub = (
  mint: (n: number) => { status: number; token?: string; expiresAt?: string },
): FakeGitHub => {
  const requests: Array<RecordedRequest> = [];
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        requests.push({
          method: request.method,
          url: url.pathname,
          authorization: request.headers["authorization"],
          body,
        });
        const answer = mint(requests.length);
        const payload =
          answer.token === undefined
            ? { message: "rejected" }
            : { token: answer.token, expires_at: answer.expiresAt };
        const text = yield* Schema.encodeEffect(Json)(payload).pipe(
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
