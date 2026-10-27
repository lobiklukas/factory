/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/**
 * `POST /webhooks/github`: one GitHub webhook, two events, picked by `X-GitHub-Event`.
 *
 * - `pull_request` (LOB-15) is mirrored on the Linear issue the PR's session was delegated from — a
 *   merge moves it to done, an unmerged close explains itself — and (LOB-36) starts the reviewer run
 *   its head asks for: `opened`, `reopened`, `ready_for_review` and `synchronize` on a PR the factory
 *   opened from a card (`@repo/core`'s `handlePullRequestReviewWebhook`). The answer carries both, the
 *   review under `review`; a failed mirror's status wins, then a failed review's.
 * - `push` (LOB-234) is the docs trigger's: a push to the repository's default branch starts one docs
 *   run on `factory/doc-<push>` (`@repo/core`'s `handleDocsPushWebhook`), a redelivery is a replay,
 *   and a push to any other branch is `400` and starts nothing.
 *
 * One route rather than two because GitHub sends every event a webhook subscribes to to one URL with
 * one secret, and both handlers refuse an unsigned delivery the same way (`refuseGitHubDelivery`).
 *
 * The route is thin on purpose: verifying `X-Hub-Signature-256`, reading the event, and syncing or
 * delivering are all `@repo/core`'s (`handleGitHubPullRequestWebhook`, `handleDocsPushWebhook`), so
 * the unit tests and the verify drives run exactly what this route runs. The secret is `GITHUB_WEBHOOK_SECRET`, read per request like the
 * trigger routes' secrets; unset, the route refuses every delivery (`503`). The sync is the process's
 * one `LinearIssueSync` (`./LinearSync`), which writes nothing when no Linear key is set.
 *
 * **The body is capped before anything reads it whole**, because the signature can only be checked
 * over the whole body: an unsigned caller who can reach the port must not be able to make the
 * process buffer an arbitrary amount first. A declared `Content-Length` over the cap is refused
 * without reading, and a body that streams past it is refused as soon as it does. The cap is
 * `GITHUB_WEBHOOK_MAX_BODY_BYTES`, 1 MiB by default — larger than the trigger routes' 64 KiB because
 * a `pull_request` payload carries the PR's body and two repository objects, and smaller than
 * GitHub's own 25 MB ceiling by far.
 *
 * Only `pull_request` and `push` are read. GitHub's issue events (`@repo/core`'s `githubDelivery`,
 * LOB-190) are a different adapter and are not wired here; such a delivery is answered `202` and
 * ignored.
 */
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  gitReviewFetch,
  handleDocsPushWebhook,
  handleGitHubPullRequestWebhook,
  handlePullRequestReviewWebhook,
} from "@repo/core";

/** The header naming one delivery attempt; the docs push logs it beside the id it derives. */
const GITHUB_DELIVERY_HEADER = "x-github-delivery";

/** The default cap on a GitHub webhook body, in bytes. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const maxBodyBytes = (): number => {
  const cap = Number(
    process.env["GITHUB_WEBHOOK_MAX_BODY_BYTES"] ?? DEFAULT_MAX_BODY_BYTES,
  );
  return Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_BODY_BYTES;
};

const tooLarge = (limit: number, size?: number) =>
  HttpServerResponse.setStatus(
    HttpServerResponse.jsonUnsafe({
      ok: false,
      error:
        size === undefined
          ? `the delivery is over the limit of ${limit} bytes`
          : `the delivery is ${size} bytes; the limit is ${limit}`,
      code: "body-too-large",
    }),
    413,
  );

/**
 * The body as text, or `undefined` once it passes `limit` bytes. An empty or unreadable body is
 * `""`: it carries no valid signature, so the handler refuses it as it would any unsigned one.
 */
const readCapped = (
  req: HttpServerRequest.HttpServerRequest,
  limit: number,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEachWhile(req.stream, (chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        if (size > limit) return false;
        chunks.push(chunk);
        return true;
      }),
    );
    if (size > limit) return undefined;
    return Buffer.concat(chunks).toString("utf8");
  }).pipe(Effect.orElseSucceed(() => ""));

export const GitHubWebhookLive = HttpRouter.add(
  "POST",
  "/webhooks/github",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const limit = maxBodyBytes();
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      return tooLarge(limit, declared);
    }
    const raw = yield* readCapped(req, limit);
    if (raw === undefined) return tooLarge(limit);
    const secret = process.env["GITHUB_WEBHOOK_SECRET"];
    const signature = req.headers[GITHUB_SIGNATURE_HEADER];
    const event = req.headers[GITHUB_EVENT_HEADER];
    if (event === "push") {
      const pushed = yield* handleDocsPushWebhook({
        secret,
        raw,
        signature,
        delivery: req.headers[GITHUB_DELIVERY_HEADER],
      });
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe(pushed.body),
        pushed.status,
      );
    }
    const mirrored = yield* handleGitHubPullRequestWebhook({
      secret,
      raw,
      signature,
      event,
    });
    // Only a signed `pull_request` the mirror read reaches the review: every refusal before it (no
    // secret, a bad signature, another event, a payload naming no PR) is the mirror's answer alone.
    if (event !== "pull_request" || mirrored.status !== 200) {
      return HttpServerResponse.setStatus(
        HttpServerResponse.jsonUnsafe(mirrored.body),
        mirrored.status,
      );
    }
    // A head the registered checkout lacks (a push nobody made here) is fetched with the worker's
    // read credential before the reviewer's worktree is cut at it.
    const reviewed = yield* handlePullRequestReviewWebhook({
      secret,
      raw,
      signature,
      fetch: yield* gitReviewFetch,
    });
    return HttpServerResponse.setStatus(
      HttpServerResponse.jsonUnsafe({
        ...mirrored.body,
        review: reviewed.body,
      }),
      reviewed.status === 200 || reviewed.status === 400
        ? 200
        : reviewed.status,
    );
  }),
);
