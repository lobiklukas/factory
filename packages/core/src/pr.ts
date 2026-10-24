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
 *
 * `"opened"` means *this invocation made the call*, not *this invocation created the PR*: since
 * LOB-179 the call adopts the PR a killed attempt left behind when GitHub refuses the duplicate, and
 * that is still the call path. The tag separates "went to GitHub" from "the log answered", which is
 * the distinction a caller can act on; whether the PR existed before the call is the log's business.
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
  /**
   * The API root to call. Absent means the deployment's `GITHUB_API_URL`, which is the key the App
   * token flow already reads (LOB-51), so one variable points both GitHub clients at the same
   * forge — and a loopback fake can answer for the PR client without a key (LOB-179).
   */
  readonly apiUrl?: string;
};

/** GitHub's own API root: what an unconfigured deployment calls. */
const DEFAULT_API_URL = "https://api.github.com";

/**
 * Where the GitHub clients send their requests: `GITHUB_API_URL` when set, `https://api.github.com`
 * when not. Read per call rather than at module load so a test or a verify script can point the same
 * process at a loopback endpoint, and an empty value is an unset one (as `GITHUB_TOKEN` is). The PR
 * step (here) and the issue write-back (`GitHub.ts`) both read it, so one variable points both at
 * the same forge.
 */
export const githubApiUrl = (): string => {
  // oxlint-disable-next-line effecttsgo/process-env -- the deployment seam; a `Config` here would add a requirement to every caller of the step.
  const configured = process.env["GITHUB_API_URL"];
  return configured === undefined || configured === ""
    ? DEFAULT_API_URL
    : configured;
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
    const apiUrl = input.apiUrl ?? githubApiUrl();
    const request = yield* HttpClientRequest.post(
      `${apiUrl}/repos/${owner}/${repo}/pulls`,
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
      Effect.mapError(
        () =>
          new PrError({
            operation: "createPullRequest",
            ref,
            message: "GitHub could not be reached",
          }),
      ),
    );
    // A duplicate is not a failure to report: GitHub refuses a second PR for one head and base, so
    // the answer to "open this PR" is the PR that already exists. Adopting it is what closes the
    // window a kill between the call and its acknowledgement opens — the first attempt's commit
    // never landed, so nothing local remembers the PR, and the retry finds it here (LOB-179).
    if (response.status === 422) {
      const existing = yield* findPullRequest({
        http,
        apiUrl,
        repo: input.repo,
        head: input.head,
        base: input.base,
        ref,
        authorization: `Bearer ${Redacted.value(token)}`,
      });
      if (existing !== undefined) return existing;
    }
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
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
  });

/**
 * The PR that already exists for one head and base, if GitHub has one.
 *
 * GitHub keys a PR by its head branch as the *repo's owner* spells it (`owner:branch`), which is
 * why the query names the owner rather than the bare branch. An empty list is no answer, not a
 * failure: the caller reports the status GitHub gave when the create was refused.
 */
const findPullRequest = (input: {
  readonly http: HttpClient.HttpClient;
  readonly apiUrl: string;
  readonly repo: RepoSlug;
  readonly head: string;
  readonly base: string;
  readonly ref: string;
  /** The same bearer the create sent: the lookup reads a repo the token already reaches. */
  readonly authorization: string;
}): Effect.Effect<PullRequest | undefined, PrError> =>
  Effect.gen(function* () {
    const [owner, repo] = input.repo.split("/");
    const query = new URLSearchParams({
      head: `${owner}:${input.head}`,
      base: input.base,
      state: "open",
    });
    const request = HttpClientRequest.get(
      `${input.apiUrl}/repos/${owner}/${repo}/pulls?${query.toString()}`,
      {
        headers: {
          authorization: input.authorization,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    return yield* input.http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(Schema.Array(PullRequest)),
      ),
      Effect.map((found) => found[0]),
      Effect.mapError(
        () =>
          new PrError({
            operation: "findPullRequest",
            ref: input.ref,
            message: "the existing pull request could not be read",
          }),
      ),
    );
  });

export const PrClientLive = FetchHttpClient.layer;
