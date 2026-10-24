import { Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import { CredentialError, CredentialProvider } from "./credentials";

/** A PR could not be created. Typed, so callers handle it instead of dumping stderr. */
export class PrError extends Schema.TaggedError<PrError>()("PrError", {
  operation: Schema.String,
  ref: Schema.String,
  message: Schema.String,
}) {}

export const PullRequest = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
});
export type PullRequest = typeof PullRequest.Type;

/**
 * Which of the PR step's two paths answered (LOB-212).
 *
 * `"opened"` is the GitHub call; `"already-open"` is the retry that read the `factory.pr` document
 * its log already held and never reached the network. The link is the same either way, which is
 * exactly why the tag has to be here: before it, a first open and a replay were indistinguishable
 * from the answer.
 */
export const PullRequestOutcome = Schema.Literals(["opened", "already-open"]);
export type PullRequestOutcome = typeof PullRequestOutcome.Type;

/**
 * The PR step's answer: the link plus the path that produced it.
 *
 * A superset of `PullRequest`, not a replacement — a client that reads only `{number, url}` keeps
 * decoding this answer with `PullRequest` and is unaffected, which is why the tag lives on the
 * step's result rather than on the forge's own shape.
 */
export const OpenedPullRequest = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
  outcome: PullRequestOutcome,
});
export type OpenedPullRequest = typeof OpenedPullRequest.Type;

export type PrBodyInput = {
  readonly sessionId: SessionId;
  readonly prompt: string;
  /** The model that did the work. Absent when the session spent nothing on a model. */
  readonly model?: string;
  readonly spend?: string;
};

/** The body a factory PR carries: session id, prompt, model and spend. */
export const buildPrBody = (input: PrBodyInput): string => {
  const lines = [
    "## Factory session",
    "",
    `- Session: ${input.sessionId}`,
    ...(input.model === undefined ? [] : [`- Model: ${input.model}`]),
    ...(input.spend ? [`- Spend: ${input.spend}`] : []),
    "",
    "## Prompt",
    "",
    input.prompt,
  ];
  return lines.join("\n");
};

export type CreatePullRequestInput = {
  readonly repo: RepoSlug;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
};

export const createPullRequest = (
  input: CreatePullRequestInput,
): Effect.Effect<
  PullRequest,
  PrError | CredentialError,
  CredentialProvider | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const provider = yield* CredentialProvider;
    const http = yield* HttpClient.HttpClient;
    const token = yield* provider.tokenFor(input.repo);
    const [owner, repo] = input.repo.split("/");
    const ref = `${input.repo}:${input.head}->${input.base}`;
    const request = yield* HttpClientRequest.post(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        headers: {
          authorization: `Bearer ${Redacted.value(token)}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    ).pipe(
      HttpClientRequest.bodyJson({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      }),
      Effect.mapError(
        () =>
          new PrError({
            operation: "createPullRequest",
            ref,
            message: "the request body could not be encoded",
          }),
      ),
    );
    const response = yield* http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PullRequest)),
      Effect.mapError((error) => {
        const status =
          error._tag === "HttpClientError" &&
          error.reason._tag === "StatusCodeError"
            ? error.reason.response.status
            : undefined;
        return new PrError({
          operation: "createPullRequest",
          ref,
          message:
            status === undefined
              ? "GitHub's response could not be read"
              : `GitHub answered HTTP ${status}`,
        });
      }),
    );
    return response;
  });

export const PrClientLive = FetchHttpClient.layer;
