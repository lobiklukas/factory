/**
 * The reviewer's GitHub half (LOB-36): who a review is posted as, and how it is posted.
 *
 * **A review must not come from the PR author's identity.** The worker's credential
 * (`CredentialProvider`, LOB-10/LOB-55) opened the PR, so a review posted with it reads as the author
 * reviewing their own change — which GitHub shows, and a branch rule that counts reviews would count.
 * The reviewer therefore has its own credential, configured on its own variables:
 *
 * - `GITHUB_REVIEWER_TOKEN`, a static token (the local-development shape, as `GITHUB_TOKEN` is), or
 * - `GITHUB_REVIEWER_APP_ID` with `GITHUB_REVIEWER_APP_PRIVATE_KEY` and
 *   `GITHUB_REVIEWER_APP_INSTALLATION_ID`, a second GitHub App, minted exactly as the worker's is.
 *
 * It never falls back to the worker's: a deployment with no reviewer credential posts no review (each
 * post fails, naming the variables), and one whose reviewer credential *is* the worker's — the same
 * token, or the same App — is refused at selection, so the process does not boot into posting as the
 * author. Two different tokens can still belong to one account, which only GitHub can tell; that is
 * the operator's to get right, and `docs/testing-third-parties.md` records it.
 *
 * **One comment per head, never an approval.** `githubReviewPoster` reads the PR first: a head that
 * moved since the run began answers `stale` and posts nothing (the new head has its own run, opened by
 * `synchronize`). Then it reads the PR's reviews for the run's marker, so a retry after a lost
 * acknowledgement finds its own comment instead of posting a second. Only then does it post, as a
 * `COMMENT` review pinned to the reviewed commit (`commit_id`). It never posts `APPROVE` or
 * `REQUEST_CHANGES`: the board's human merge gate is the decision (B5), and an approval is the one
 * thing a push could leave standing — a comment states what it reviewed and leaves nothing to dismiss.
 */
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { ReviewPosted, ReviewTarget } from "@repo/harness";
import { CredentialError } from "@repo/domain/PullRequest";
import {
  type RepoSlug,
  RepoSlug as RepoSlugSchema,
} from "@repo/domain/Session";
import {
  type CredentialConfigShape,
  type CredentialProviderShape,
  selectCredentialProvider,
} from "./credentials";
import { githubApiUrl } from "./pr";

/** A review that could not be posted, in the words the reviewer's tool result carries. */
export class ReviewPostError extends Schema.TaggedError<ReviewPostError>()(
  "ReviewPostError",
  { message: Schema.String },
) {}

/** What the control plane posts for a reviewer run. */
export type ReviewPostRequest = {
  readonly target: ReviewTarget;
  readonly body: string;
  /** The hidden line in `body` that identifies this comment (`reviewMarker`). */
  readonly marker: string;
};

/** How a reviewer's comment reaches the PR: `SessionServiceOptions.reviewPoster`. */
export type ReviewPoster = (
  request: ReviewPostRequest,
) => Effect.Effect<ReviewPosted, ReviewPostError>;

/** The reviewer's own credential variables (module doc). */
export const ReviewerCredentialConfig = Config.all({
  token: Config.option(Config.Redacted("GITHUB_REVIEWER_TOKEN")),
  appId: Config.option(Config.String("GITHUB_REVIEWER_APP_ID")),
  appPrivateKey: Config.option(
    Config.Redacted("GITHUB_REVIEWER_APP_PRIVATE_KEY"),
  ),
  appInstallationId: Config.option(
    Config.String("GITHUB_REVIEWER_APP_INSTALLATION_ID"),
  ),
});

export type ReviewerCredentialConfigShape = {
  readonly token: Option.Option<Redacted.Redacted<string>>;
  readonly appId: Option.Option<string>;
  readonly appPrivateKey: Option.Option<Redacted.Redacted<string>>;
  readonly appInstallationId: Option.Option<string>;
};

/** What the reviewer is told when no identity of its own is configured. */
export const NO_REVIEWER_IDENTITY =
  "no reviewer identity is configured (GITHUB_REVIEWER_TOKEN, or GITHUB_REVIEWER_APP_ID with its key and installation); a review is never posted as the pull request's author";

const nonEmpty = (
  value: Option.Option<Redacted.Redacted<string>>,
): Option.Option<Redacted.Redacted<string>> =>
  Option.filter(value, (secret) => Redacted.value(secret).length > 0);

/**
 * The reviewer's credential provider, distinct from the worker's (module doc): its App when it names
 * one, its token otherwise, and a provider that refuses every repo when it names neither. Refused
 * outright — a typed error, so the boot fails — when it is the worker's own App or token.
 */
export const selectReviewerCredentialProvider = (
  worker: CredentialConfigShape,
  reviewer: ReviewerCredentialConfigShape,
): Effect.Effect<
  CredentialProviderShape,
  CredentialError,
  HttpClient.HttpClient
> => {
  const sameAsAuthor = (what: string) =>
    Effect.fail(
      new CredentialError({
        repo: "*",
        code: "unsupported",
        message: `the reviewer's ${what} is the worker's own, so its reviews would come from the pull request's author: give the reviewer an identity of its own`,
      }),
    );
  const appId = Option.filter(reviewer.appId, (id) => id.length > 0);
  if (Option.isSome(appId)) {
    if (Option.contains(worker.githubAppId, appId.value)) {
      return sameAsAuthor(`GitHub App (${appId.value})`);
    }
    return selectCredentialProvider({
      githubToken: Option.none(),
      githubAppId: appId,
      githubAppPrivateKey: reviewer.appPrivateKey,
      githubAppInstallationId: reviewer.appInstallationId,
      githubApiUrl: worker.githubApiUrl,
    }).pipe(
      Effect.mapError(
        (error) =>
          new CredentialError({
            repo: error.repo,
            code: error.code,
            message: error.message.replaceAll(
              "GITHUB_APP_",
              "GITHUB_REVIEWER_APP_",
            ),
          }),
      ),
    );
  }
  const token = nonEmpty(reviewer.token);
  if (Option.isNone(token)) {
    return Effect.succeed({
      source: "static-token",
      tokenFor: (repo: RepoSlug) =>
        Effect.fail(
          new CredentialError({
            repo,
            code: "missing",
            message: NO_REVIEWER_IDENTITY,
          }),
        ),
    });
  }
  const workerToken = nonEmpty(worker.githubToken);
  if (
    Option.isSome(workerToken) &&
    Redacted.value(workerToken.value) === Redacted.value(token.value)
  ) {
    return sameAsAuthor("token (GITHUB_REVIEWER_TOKEN equals GITHUB_TOKEN)");
  }
  return Effect.succeed({
    source: "static-token",
    tokenFor: () => Effect.succeed(token.value),
  });
};

/** The PR as far as the post reads it: the commit its head is at now. */
const GitHubPull = Schema.Struct({
  head: Schema.Struct({ sha: Schema.String }),
});

/** One page of a PR's reviews: each one's body and page. */
const GitHubReviews = Schema.Array(
  Schema.Struct({
    body: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.optional(Schema.String),
  }),
);

const GitHubReview = Schema.Struct({ html_url: Schema.String });

/**
 * The poster, over the reviewer's credentials (module doc): read the PR's head, read its reviews for
 * the marker, post one `COMMENT` review. `apiUrl` defaults to the deployment's `GITHUB_API_URL`, the
 * same root every GitHub client here reads, so a loopback fake answers all of them.
 */
export const githubReviewPoster = (input: {
  readonly credentials: CredentialProviderShape;
  readonly apiUrl?: string;
}): Effect.Effect<ReviewPoster, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return (request) =>
      Effect.gen(function* () {
        const { target } = request;
        const where = `${target.repo}#${target.number}`;
        const fail = (message: string) =>
          new ReviewPostError({
            message: `the review of ${where} was not posted: ${message}`,
          });
        const repo = Schema.decodeOption(RepoSlugSchema)(target.repo);
        if (Option.isNone(repo)) {
          return yield* fail(`${target.repo} is not an owner/name repository`);
        }
        const token = yield* input.credentials
          .tokenFor(repo.value)
          .pipe(Effect.mapError((error) => fail(error.message)));
        const apiUrl = input.apiUrl ?? githubApiUrl();
        const pull = `${apiUrl}/repos/${target.repo}/pulls/${target.number}`;
        const headers = {
          authorization: `Bearer ${Redacted.value(token)}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        };
        const read = <S extends Schema.Top>(
          what: string,
          response: HttpClientResponse.HttpClientResponse,
          schema: S,
        ) =>
          HttpClientResponse.filterStatusOk(response).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.mapError((error) =>
              fail(
                error._tag === "HttpClientError" &&
                  error.reason._tag === "StatusCodeError"
                  ? `GitHub answered HTTP ${error.reason.response.status} to ${what}`
                  : `GitHub's answer to ${what} could not be read`,
              ),
            ),
          );
        const send = (what: string, req: HttpClientRequest.HttpClientRequest) =>
          http
            .execute(req)
            .pipe(
              Effect.mapError(() =>
                fail(`GitHub could not be reached for ${what}`),
              ),
            );

        const pr = yield* send(
          "the pull request",
          HttpClientRequest.get(pull, { headers }),
        ).pipe(
          Effect.flatMap((response) =>
            read("the pull request", response, GitHubPull),
          ),
        );
        if (pr.head.sha !== target.head) {
          return { _tag: "stale", head: pr.head.sha } satisfies ReviewPosted;
        }
        const reviews = yield* send(
          "its reviews",
          HttpClientRequest.get(`${pull}/reviews?per_page=100`, { headers }),
        ).pipe(
          Effect.flatMap((response) =>
            read("its reviews", response, GitHubReviews),
          ),
        );
        const already = reviews.find(
          (review) =>
            typeof review.body === "string" &&
            review.body.includes(request.marker),
        );
        if (already !== undefined) {
          return {
            _tag: "posted",
            url: already.html_url ?? target.url,
          } satisfies ReviewPosted;
        }
        const post = yield* HttpClientRequest.post(`${pull}/reviews`, {
          headers,
        }).pipe(
          HttpClientRequest.bodyJson({
            commit_id: target.head,
            event: "COMMENT",
            body: request.body,
          }),
          Effect.mapError(() => fail("the review body could not be encoded")),
        );
        const posted = yield* send("the review", post).pipe(
          Effect.flatMap((response) =>
            read("the review", response, GitHubReview),
          ),
        );
        return { _tag: "posted", url: posted.html_url } satisfies ReviewPosted;
      });
  });
