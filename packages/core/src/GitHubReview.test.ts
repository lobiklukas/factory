/**
 * The reviewer's GitHub half (LOB-36): its identity, and the one comment it posts.
 *
 * No GitHub: the three endpoints the poster calls (`GET /pulls/{n}`, `GET /pulls/{n}/reviews`,
 * `POST /pulls/{n}/reviews`) are a hand-written fake behind Effect's `HttpClient`, answering GitHub's
 * documented shapes and recording every request, so the cases assert what was asked as which token.
 * The identity cases are pure: which credential the reviewer is given, and which it is refused.
 */
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { RepoSlug } from "@repo/domain/Session";
import { reviewMarker, type ReviewTarget } from "@repo/harness";
import type {
  CredentialConfigShape,
  CredentialProviderShape,
} from "./credentials";
import {
  githubReviewPoster,
  NO_REVIEWER_IDENTITY,
  selectReviewerCredentialProvider,
  type ReviewerCredentialConfigShape,
} from "./GitHubReview";

const HEAD = "1".repeat(40);
const TARGET: ReviewTarget = {
  repo: "acme/sum",
  number: 7,
  url: "https://github.com/acme/sum/pull/7",
  base: "main",
  head: HEAD,
};
const MARKER = reviewMarker(TARGET);
const BODY = `${MARKER}\n## Factory review: changes needed`;
const REPO = "acme/sum" as RepoSlug;

type Recorded = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

/** The forge as one PR: its head, its reviews, and what a post answers. */
const fakeForge = (forge: {
  readonly head?: string;
  readonly reviews?: ReadonlyArray<unknown>;
  readonly postStatus?: number;
}) => {
  const requests: Recorded[] = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
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
          path: `${url.pathname}${url.search}`,
          authorization: request.headers["authorization"],
          body,
        });
        const answer =
          request.method === "POST"
            ? {
                status: forge.postStatus ?? 200,
                body: {
                  id: 1,
                  html_url: `${TARGET.url}#pullrequestreview-1`,
                },
              }
            : url.pathname.endsWith("/reviews")
              ? { status: 200, body: forge.reviews ?? [] }
              : {
                  status: 200,
                  body: { number: 7, head: { sha: forge.head ?? HEAD } },
                };
        const text = yield* Schema.encodeEffect(Json)(answer.body).pipe(
          Effect.orDie,
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(text, {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }).pipe(Effect.orDie),
    ),
  );
  return { requests, client };
};

const reviewerToken: CredentialProviderShape = {
  source: "static-token",
  tokenFor: () => Effect.succeed(Redacted.make("ghs-reviewer")),
};

const post = (
  forge: ReturnType<typeof fakeForge>,
  credentials: CredentialProviderShape = reviewerToken,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const poster = yield* githubReviewPoster({
        credentials,
        apiUrl: "https://forge.test",
      });
      return yield* poster({ target: TARGET, body: BODY, marker: MARKER });
    }).pipe(Effect.provide(forge.client)),
  );

describe("the review post", () => {
  it("reads the head and the reviews, then posts one COMMENT review on the reviewed commit, as the reviewer", async () => {
    const forge = fakeForge({});
    const exit = await post(forge);

    expect(exit).toEqual(
      Exit.succeed({
        _tag: "posted",
        url: `${TARGET.url}#pullrequestreview-1`,
      }),
    );
    expect(forge.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repos/acme/sum/pulls/7",
      "GET /repos/acme/sum/pulls/7/reviews?per_page=100",
      "POST /repos/acme/sum/pulls/7/reviews",
    ]);
    for (const request of forge.requests) {
      expect(request.authorization).toBe("Bearer ghs-reviewer");
    }
    // A comment, never an approval: nothing a push could leave standing.
    expect(forge.requests[2]?.body).toEqual({
      commit_id: HEAD,
      event: "COMMENT",
      body: BODY,
    });
  });

  it("posts nothing when its comment is already there (a retry after a lost acknowledgement)", async () => {
    const forge = fakeForge({
      reviews: [
        { body: "someone else's review", html_url: "https://x/1" },
        { body: `${BODY}\n(earlier copy)`, html_url: "https://x/2" },
      ],
    });
    const exit = await post(forge);
    expect(exit).toEqual(Exit.succeed({ _tag: "posted", url: "https://x/2" }));
    expect(forge.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("answers stale and posts nothing when the PR moved past the reviewed head", async () => {
    const moved = "2".repeat(40);
    const forge = fakeForge({ head: moved });
    const exit = await post(forge);
    expect(exit).toEqual(Exit.succeed({ _tag: "stale", head: moved }));
    expect(forge.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("fails naming GitHub's status when the post is refused", async () => {
    const forge = fakeForge({ postStatus: 422 });
    const exit = await post(forge);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(
      "the review of acme/sum#7 was not posted: GitHub answered HTTP 422 to the review",
    );
  });

  it("asks nothing of GitHub when the reviewer has no identity", async () => {
    const forge = fakeForge({});
    const none = await Effect.runPromise(
      selectReviewerCredentialProvider(workerWith({}), reviewerWith({})).pipe(
        Effect.provide(forge.client),
      ),
    );
    const exit = await post(forge, none);
    expect(JSON.stringify(exit)).toContain(NO_REVIEWER_IDENTITY);
    expect(forge.requests).toHaveLength(0);
  });
});

const workerWith = (
  over: Partial<CredentialConfigShape>,
): CredentialConfigShape => ({
  githubToken: Option.none(),
  githubAppId: Option.none(),
  githubAppPrivateKey: Option.none(),
  githubAppInstallationId: Option.none(),
  githubApiUrl: "https://forge.test",
  ...over,
});

const reviewerWith = (
  over: Partial<ReviewerCredentialConfigShape>,
): ReviewerCredentialConfigShape => ({
  token: Option.none(),
  appId: Option.none(),
  appPrivateKey: Option.none(),
  appInstallationId: Option.none(),
  ...over,
});

const select = (
  worker: CredentialConfigShape,
  reviewer: ReviewerCredentialConfigShape,
) =>
  Effect.runPromiseExit(
    selectReviewerCredentialProvider(worker, reviewer).pipe(
      Effect.flatMap((provider) =>
        Effect.map(provider.tokenFor(REPO), (token) => ({
          source: provider.source,
          token: Redacted.value(token),
        })),
      ),
      Effect.provide(fakeForge({}).client),
    ),
  );

describe("the reviewer's identity", () => {
  it("is its own token, never the worker's", async () => {
    const worker = workerWith({
      githubToken: Option.some(Redacted.make("ghp-worker")),
    });
    expect(
      await select(
        worker,
        reviewerWith({ token: Option.some(Redacted.make("ghp-reviewer")) }),
      ),
    ).toEqual(Exit.succeed({ source: "static-token", token: "ghp-reviewer" }));

    // With no reviewer credential, the worker's token is not borrowed: every repo is refused.
    const none = await select(worker, reviewerWith({}));
    expect(JSON.stringify(none)).toContain(NO_REVIEWER_IDENTITY);
    expect(JSON.stringify(none)).not.toContain("ghp-worker");
  });

  it("is refused when it is the worker's token or the worker's App", async () => {
    const sameToken = await select(
      workerWith({ githubToken: Option.some(Redacted.make("ghp-same")) }),
      reviewerWith({ token: Option.some(Redacted.make("ghp-same")) }),
    );
    expect(JSON.stringify(sameToken)).toContain(
      "would come from the pull request's author",
    );
    const sameApp = await select(
      workerWith({ githubAppId: Option.some("12345") }),
      reviewerWith({ appId: Option.some("12345") }),
    );
    expect(JSON.stringify(sameApp)).toContain("GitHub App (12345)");
  });

  it("is a second App when it names one, and names its own variables when one is missing", async () => {
    const missing = await select(
      workerWith({ githubAppId: Option.some("1") }),
      reviewerWith({ appId: Option.some("2") }),
    );
    expect(JSON.stringify(missing)).toContain(
      "GITHUB_REVIEWER_APP_PRIVATE_KEY",
    );
    expect(JSON.stringify(missing)).toContain(
      "GITHUB_REVIEWER_APP_INSTALLATION_ID",
    );

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = await Effect.runPromise(
      selectReviewerCredentialProvider(
        workerWith({ githubAppId: Option.some("1") }),
        reviewerWith({
          appId: Option.some("2"),
          appPrivateKey: Option.some(
            Redacted.make(
              privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
            ),
          ),
          appInstallationId: Option.some("99"),
        }),
      ).pipe(Effect.provide(fakeForge({}).client)),
    );
    expect(provider.source).toBe("github-app");
  });
});
