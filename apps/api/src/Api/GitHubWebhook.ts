/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/**
 * `POST /webhooks/github` (LOB-15): GitHub's `pull_request` events, mirrored on the Linear issue the
 * PR's session was delegated from — a merge moves it to done, an unmerged close explains itself.
 *
 * The route is thin on purpose: verifying `X-Hub-Signature-256`, reading the event, and syncing are
 * all `@repo/core`'s `handleGitHubPullRequestWebhook`, so the unit tests and the verify drive run
 * exactly what this route runs. The secret is `GITHUB_WEBHOOK_SECRET`, read per request like the
 * trigger routes' secrets; unset, the route refuses every delivery (`503`). The sync is the process's
 * one `LinearIssueSync` (`./LinearSync`), which writes nothing when no Linear key is set.
 *
 * Only `pull_request` is read. GitHub's issue events (`@repo/core`'s `githubDelivery`, LOB-190) are a
 * different adapter and are not wired here; such a delivery is answered `202` and ignored.
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  handleGitHubPullRequestWebhook,
} from "@repo/core";

export const GitHubWebhookLive = HttpRouter.add(
  "POST",
  "/webhooks/github",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* req.text;
    const answer = yield* handleGitHubPullRequestWebhook({
      secret: process.env["GITHUB_WEBHOOK_SECRET"],
      raw,
      signature: req.headers[GITHUB_SIGNATURE_HEADER],
      event: req.headers[GITHUB_EVENT_HEADER],
    });
    return HttpServerResponse.setStatus(
      HttpServerResponse.jsonUnsafe(answer.body),
      answer.status,
    );
  }),
);
