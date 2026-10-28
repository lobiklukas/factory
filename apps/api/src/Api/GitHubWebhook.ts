/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/**
 * `POST /webhooks/github`: one GitHub webhook, two events, picked by `X-GitHub-Event`.
 *
 * - `pull_request` (LOB-15) is mirrored on the Linear issue the PR's session was delegated from — a
 *   merge moves it to done, an unmerged close explains itself — a signed merge tears the PR's
 *   sessions' and reviewer runs' worktrees and branches down whatever the mirror answered (LOB-268),
 *   and (LOB-36) starts the reviewer run
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
 * - `issues` and `issue_comment` (LOB-190's adapter, served by LOB-259) are the issue intake: a
 *   `factory` label on an issue, or a comment mentioning `@factory` (`GITHUB_MENTION`), is one
 *   delivery to the same trigger seam the other routes share, keyed by the issue, so a redelivery —
 *   or the label and then the mention — starts nothing more (`@repo/core`'s
 *   `handleGitHubIssueWebhook`). The seam comments the session's link on the issue
 *   (`GitHubWriteBack`). Which repo, and which prompt, is a `TRIGGER_RULES` rule on the label; the
 *   repo is the payload's own, and has to be registered.
 *
 * - A signed `pull_request` **merge** also reads the plan again when `PLAN_FRESHNESS=merged` (LOB-45,
 *   `@repo/core`'s `handlePlanFreshnessDelivery`): one plan-freshness pass per spec of record, its
 *   proposals filed on the spec's session for a person to approve, its worst-case cost bounded by
 *   `PLAN_FRESHNESS_MAX_COST`. Off by default, when nothing reads the payload for it; a redelivery of
 *   the same merge runs no second pass. Each claimed pass runs on `PlanFreshnessPasses`, past the
 *   answer, which carries each pass as `accepted` (or `replayed`) under `planFreshness`.
 *
 * Any other event is answered `202` and ignored.
 */
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  gitReviewFetch,
  handleDocsPushWebhook,
  handleGitHubPullRequestWebhook,
  handleGitHubIssueWebhook,
  handlePlanFreshnessDelivery,
  handlePullRequestReviewWebhook,
  PLAN_FRESHNESS_OFF,
  PlanFreshnessPasses,
  planFreshnessConfigOf,
  releaseMergedDelivery,
  TriggerService,
  type GitHubWebhookAnswer,
} from "@repo/core";
import { TriggerSeamLive } from "./Webhook";

/** The header naming one delivery attempt; the docs push logs it beside the id it derives. */
const GITHUB_DELIVERY_HEADER = "x-github-delivery";

/**
 * A handler's answer as a response: its status, its body and its headers — the `Retry-After` an
 * `at-capacity` refusal carries (LOB-70), so a sender told `503` is also told when.
 */
const respond = (answer: GitHubWebhookAnswer) =>
  HttpServerResponse.jsonUnsafe(answer.body, {
    status: answer.status,
    ...(answer.headers === undefined ? {} : { headers: answer.headers }),
  });

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

/** The comment that asks for work, when the deployment names none: `@factory`. */
const mention = (): string | undefined => {
  const configured = process.env["GITHUB_MENTION"]?.trim();
  return configured === undefined || configured === "" ? undefined : configured;
};

/**
 * The plan-freshness cadence (LOB-45), read per delivery like the secret: `PLAN_FRESHNESS` (`off` or
 * `merged`, `off` when unset) and `PLAN_FRESHNESS_MAX_COST` (US dollars per pass). A value that does
 * not read is logged and the cadence stays off: a typo must not start paying for model calls.
 */
const planFreshnessConfig = Effect.gen(function* () {
  const read = planFreshnessConfigOf({
    cadence: process.env["PLAN_FRESHNESS"],
    maxCost: process.env["PLAN_FRESHNESS_MAX_COST"],
  });
  if (read.ok) return read.config;
  yield* Effect.logWarning(`plan freshness: off, because ${read.error}`);
  return PLAN_FRESHNESS_OFF;
});

const GitHubWebhookRoute = HttpRouter.add(
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
    if (event === "issues" || event === "issue_comment") {
      // The rules the intake maps with are the seam's own (stored routes, then `TRIGGER_RULES`), so
      // the intake and the seam cannot disagree about which deliveries a rule claims (LOB-266).
      const triggers = yield* TriggerService;
      const read = yield* triggers.rules.pipe(
        Effect.map((rules) => ({ ok: true as const, rules })),
        Effect.catchTag("TriggerError", (cause) =>
          Effect.succeed({ ok: false as const, cause }),
        ),
      );
      if (!read.ok) {
        return HttpServerResponse.setStatus(
          HttpServerResponse.jsonUnsafe({
            ok: false,
            error: read.cause.message,
            code: read.cause.code,
          }),
          500,
        );
      }
      const answered = yield* handleGitHubIssueWebhook({
        secret,
        raw,
        signature,
        event,
        rules: read.rules,
        mention: mention(),
      });
      return respond(answered);
    }
    if (event === "push") {
      const pushed = yield* handleDocsPushWebhook({
        secret,
        raw,
        signature,
        delivery: req.headers[GITHUB_DELIVERY_HEADER],
      });
      return respond(pushed);
    }
    const mirrored = yield* handleGitHubPullRequestWebhook({
      secret,
      raw,
      signature,
      event,
    });
    // A merge is a terminal event (LOB-268): the PR's sessions' worktrees and branches are torn
    // down, now that the work is on the base. Gated on the delivery being a signed `pull_request`
    // (the release checks the signature itself), not on the mirror: a Linear write-back that failed
    // is a `500` GitHub does not retry by itself, and must not leave the merge's workspaces behind.
    // A redelivery finds them released and releases nothing.
    // The plan is read again after a merge (LOB-45), gated as the release is: on the signed delivery
    // alone, not on the mirror. Off by default; a redelivery runs no second pass.
    let planFreshness: unknown = undefined;
    if (event === "pull_request") {
      const released = yield* releaseMergedDelivery({ secret, raw, signature });
      if (released > 0) {
        yield* Effect.logInfo(
          `github: a merged pull request released ${released} session workspace(s)`,
        );
      }
      // Each claimed pass runs on the process's own fiber set, not on this request: its model call
      // can outlast the 10 s GitHub waits, and a closed connection interrupts the request. The
      // answer says which passes were `accepted`; the revision lands on the spec's session.
      const passes = yield* PlanFreshnessPasses;
      const plan = yield* handlePlanFreshnessDelivery({
        secret,
        raw,
        signature,
        config: yield* planFreshnessConfig,
        fork: passes.run,
      });
      if (plan.status === "merged") planFreshness = plan;
    }
    // Only a signed `pull_request` the mirror read reaches the review: every refusal before it (no
    // secret, a bad signature, another event, a payload naming no PR) is the mirror's answer alone.
    if (event !== "pull_request" || mirrored.status !== 200) {
      return respond(
        planFreshness === undefined
          ? mirrored
          : { ...mirrored, body: { ...mirrored.body, planFreshness } },
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
    return respond({
      body: {
        ...mirrored.body,
        review: reviewed.body,
        ...(planFreshness === undefined ? {} : { planFreshness }),
      },
      status:
        reviewed.status === 200 || reviewed.status === 400
          ? 200
          : reviewed.status,
      ...(reviewed.headers === undefined ? {} : { headers: reviewed.headers }),
    });
  }),
);

/**
 * The route, with the shared trigger seam provided to every request: the issue events are
 * delivered to it, and the other two events do not ask for it.
 */
export const GitHubWebhookLive = GitHubWebhookRoute.pipe(
  HttpRouter.provideRequest(TriggerSeamLive),
);
