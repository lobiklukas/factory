/**
 * The GitHub adapter (LOB-190, part 3 of LOB-34): a GitHub issue event in, one session and one
 * issue comment out.
 *
 * Part 1 (`@repo/domain/Trigger` + `./TriggerService`) owns everything after normalization — the
 * dedupe claim, the action filter, the label → `{repo, baseRef, prompt}` mapping, the session and
 * the write-back call. An adapter is therefore one extractor (`githubEvent`) and one client
 * (`GitHubWriteBack`), and this file is both: it adds no rule of its own about what makes a delivery
 * a replay, and it modifies no other adapter's module.
 *
 * **The repo is on the event, not in a rule.** A GitHub installation serves many repositories, so
 * `repository.full_name` is where the answer to "which repo does this label mean" lives; a rule's
 * `repo` would run one repository's issue in another's checkout. `githubEvent` therefore sets
 * `TriggerEvent.repo`, and `resolveMapping` lets the event win (LOB-190).
 *
 * **Two actions start work.** `opened` (an issue created carrying the label) and `labeled` (the
 * same label added to an existing issue) both normalize to `create`; `unlabeled` and every other
 * `action` keep GitHub's own name, so the seam's filter refuses them and the recorded reason reads
 * "action \"unlabeled\" is not \"create\"" rather than a word this adapter invented.
 *
 * **GitHub fires both for one issue, so the idempotency key names the intent.** Creating an issue
 * with a label emits `opened` *and* one `labeled` per label, as two deliveries with two
 * `X-GitHub-Delivery` values; keying the dedupe on the delivery would open two sessions for one
 * issue. An issue is one unit of work, so the key is the issue once any rule claims it: the pair is
 * one delivery, a redelivery of either is one too, and a second label does not open a second
 * session. A delivery a rule does not claim is keyed by the labels it carried, so an issue opened
 * unlabelled records its skip without swallowing the delivery that labels it later. The limits this
 * buys are recorded in `docs/testing-third-parties.md`: re-adding a label that already started a
 * session is a replay (where GitHub's own delivery id would make it new), and two rules cannot both
 * start work on one issue.
 *
 * **The route is `POST /webhooks/github` (LOB-259), and it also reads comments.** `githubIssueIntake`
 * decides which `issues` and `issue_comment` payloads ask for work — a label added, or a comment
 * mentioning `@factory`, which is the same ask and so carries the handle as one more label — and
 * `handleGitHubIssueWebhook` is the route's whole answer, signature to seam, so the unit tests and
 * the drive run what the route runs.
 *
 * **The write-back is one injected client.** `TriggerWriteBack` is the seam's port; this layer
 * fills it with `POST /repos/{owner}/{repo}/issues/{number}/comments` over the same credential seam
 * and Effect `HttpClient` the PR client uses (`pr.ts`), so a loopback fake needs no interception
 * library. A failed comment fails the delivery (`write-back`), which gives the claim back so the
 * sender's retry runs the work instead of reading "already handled".
 */
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  resolveMapping,
  TRIGGER_ACTION,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { CredentialProvider } from "./credentials";
import { type GitHubWebhookAnswer, refuseGitHubDelivery } from "./LinearSync";
import { githubApiUrl } from "./pr";
import { TriggerService, TriggerWriteBack } from "./TriggerService";

/** GitHub's two actions that start work; every other `action` is the seam's to refuse. */
const GITHUB_STARTING_ACTIONS: ReadonlyArray<string> = ["opened", "labeled"];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * GitHub's `labels` are objects with a `name`; a bare string is accepted too, because that is what
 * a hand-written payload (a fake, a `workflow_dispatch` body) carries.
 */
const labelNames = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry): ReadonlyArray<string> => {
        if (typeof entry === "string") return [entry];
        const name = stringField(asRecord(entry), "name");
        return name === undefined ? [] : [name];
      })
    : [];

/**
 * A repository slug from GitHub's `full_name`, or `undefined` when it is not one.
 *
 * GitHub preserves the case it was created with (`Octocat/Hello-World`) while `RepoSlug` is
 * lowercase by contract, so the slug is lowercased before it is checked: the same repository must
 * be one slug whether a rule or a payload named it.
 */
const repoSlug = (fullName: string): RepoSlug | undefined => {
  const decoded = Schema.decodeOption(RepoSlug)(fullName.toLowerCase());
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/**
 * A GitHub issues webhook payload, normalized.
 *
 * `undefined` is "this is not an issue event this adapter acts on": a payload with no `issue`, with
 * no `repository.full_name` or no issue number to address, or one about a **pull request** —
 * GitHub's `issues` event fires for pull requests too, and a PR's body is not an issue to delegate.
 * The caller answers that as a bad request rather than recording a delivery it could never write
 * back to.
 */
export const githubEvent = (payload: unknown): TriggerEvent | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  const issue = asRecord(body["issue"]);
  if (issue === undefined) return undefined;
  // A pull request is an issue to GitHub; it is not one to this adapter.
  if (issue["pull_request"] !== undefined) return undefined;
  const number = issue["number"];
  if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
  const fullName = stringField(asRecord(body["repository"]), "full_name");
  if (fullName === undefined) return undefined;
  const repo = repoSlug(fullName);
  if (repo === undefined) return undefined;
  const action = stringField(body, "action");
  if (action === undefined) return undefined;
  return {
    source: "github",
    key: `${repo}#${number}`,
    // Only the two starting actions are renamed: every other action keeps GitHub's own name so the
    // skip reason reads "action \"unlabeled\" is not \"create\"" and an operator can see what
    // arrived.
    action: GITHUB_STARTING_ACTIONS.includes(action) ? TRIGGER_ACTION : action,
    title: stringField(issue, "title") ?? "",
    body: stringField(issue, "body") ?? "",
    labels: labelNames(issue["labels"]),
    repo,
  };
};

/**
 * The delivery id for a GitHub payload: **one issue is one unit of work**.
 *
 * GitHub *does* send a delivery id (`X-GitHub-Delivery`), but it sends two deliveries for one
 * issue created with a label (`opened`, then one `labeled` per label), and it sends one per label
 * added later. So the key is the issue, and every delivery that a rule claims for that issue is the
 * same delivery: the `opened`/`labeled` pair collapses, a redelivery collapses, and a second label
 * — whether the same rule claims it or another one does — does not open a second session for an
 * issue that already has one. An issue is one task; two rules on one issue would be two answers to
 * one question, and the seam's mapping picks one of them anyway (`resolveMapping` takes the first
 * rule in the operator's order).
 *
 * A delivery **no rule claims** is keyed by the labels it carried, so the skip it records cannot
 * swallow the labels that arrive next: an issue opened unlabelled records `unmapped:no-labels`, and
 * the delivery that labels it later is new work. Sorted and de-duplicated, so the order GitHub
 * lists labels in cannot make a redelivery look new.
 *
 * Nothing here decides *whether* a delivery starts a session — that is the seam's filter — only
 * whether it is a delivery the seam has already seen.
 */
export const githubRequestId = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule>,
): string => {
  if (resolveMapping(rules, event) !== undefined) {
    return `github:${event.key}:mapped`;
  }
  const labels = [...new Set(event.labels)].sort().join(",");
  return `github:${event.key}:unmapped:${labels === "" ? "no-labels" : labels}`;
};

/** A payload as the seam takes it: the normalized event, named by its derived delivery id. */
export const githubDelivery = (
  payload: unknown,
  rules: ReadonlyArray<TriggerRule>,
): TriggerDelivery | undefined => {
  const event = githubEvent(payload);
  if (event === undefined) return undefined;
  return githubDeliveryOf(event, rules);
};

/**
 * An event as the seam takes it, named by its derived delivery id. A mapped one is also
 * `keyedByWork`: its key is the issue, so GitHub has no fresh delivery of it to offer, and a skip
 * recorded for a repo nobody registered must be reclaimable by the next delivery under the same
 * key once the operator registers it — the same mark Linear's adapter puts on a mapped issue.
 */
const githubDeliveryOf = (
  event: TriggerEvent,
  rules: ReadonlyArray<TriggerRule>,
): TriggerDelivery => ({
  requestId: githubRequestId(event, rules),
  event,
  ...(resolveMapping(rules, event) === undefined ? {} : { keyedByWork: true }),
});

/**
 * The adapter's delivery function, bound to one rule set.
 *
 * The key is derived against the rules the seam maps with, so a route should build it from the same
 * value it hands `TriggerServiceLive` (`githubDeliveryFor(rules)`), not from a second copy: rules
 * the service has and this does not would key a payload the service maps as unmapped, or the other
 * way round.
 */
export const githubDeliveryFor =
  (rules: ReadonlyArray<TriggerRule>) =>
  (payload: unknown): TriggerDelivery | undefined =>
    githubDelivery(payload, rules);

/** What an `@mention` is called when the deployment names none: `@factory` is the `factory` label. */
export const DEFAULT_GITHUB_MENTION = "@factory";

/** A mention as a pattern: the handle, not part of a longer word, an e-mail or a hyphenated name. */
const mentionPattern = (mention: string): RegExp =>
  new RegExp(
    `(?<![\\w@])${mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    "i",
  );

/** What the route does with one `issues` or `issue_comment` payload. */
export type GitHubIssueIntake =
  /** Start work: hand the seam this delivery. */
  | { readonly _tag: "delivery"; readonly delivery: TriggerDelivery }
  /** A well-formed event that asks for nothing; the route answers `202` and records nothing. */
  | { readonly _tag: "ignored"; readonly reason: string }
  /** A payload this adapter cannot address; the route answers `400`. */
  | { readonly _tag: "refused"; readonly reason: string };

/**
 * An `issues` or `issue_comment` payload, read for what it asks of the factory (LOB-259). Two things
 * start work, and the rest is `ignored` before the seam so a busy repository's edits, closes and
 * chatter record no delivery:
 *
 * - **a `factory` label**: an issue `opened` or `labeled` — `githubDelivery`'s two starting actions;
 *   the rule's label picks the repo's work, as it does for every adapter;
 * - **an `@factory` mention**: a comment *created* on an issue whose text mentions `mention`. The
 *   mention is the same ask as the label, so the event carries the handle (`factory`) as one more
 *   label, and a rule on `factory` claims it. Its key is the issue's, as the label's is, so asking
 *   twice — or labelling and then mentioning — is one issue, one delivery, one session.
 *
 * Why an action the seam would only skip is ignored here instead: an `edited` delivery for an issue
 * a rule claims shares its idempotency key (`githubRequestId`), so the skip it records would answer
 * the label added next as a replay.
 *
 * A pull request is no issue to delegate, whether its comment or its event; a bot's comment never
 * asks (the factory's own is posted as one, and a loop is the cost of getting that wrong). Who
 * *may* ask is not decided here: any commenter on a repository this webhook watches can, until the
 * trust gate (S:trigger-trust-gating) lands.
 */
export const githubIssueIntake = (input: {
  readonly event: "issues" | "issue_comment";
  readonly payload: unknown;
  readonly rules: ReadonlyArray<TriggerRule>;
  readonly mention?: string | undefined;
}): GitHubIssueIntake => {
  const body = asRecord(input.payload);
  const action = stringField(body, "action");
  const ignored = (reason: string): GitHubIssueIntake => ({
    _tag: "ignored",
    reason,
  });
  const refused = (reason: string): GitHubIssueIntake => ({
    _tag: "refused",
    reason,
  });

  if (input.event === "issues") {
    if (action !== undefined && !GITHUB_STARTING_ACTIONS.includes(action)) {
      return ignored(
        `an issue "${action}" event starts no work; only ${GITHUB_STARTING_ACTIONS.map((a) => `"${a}"`).join(" and ")} do`,
      );
    }
    const delivery = githubDeliveryFor(input.rules)(input.payload);
    return delivery === undefined
      ? refused(
          "the payload is not an issue event: it names no issue, repository or action, or it is a pull request",
        )
      : { _tag: "delivery", delivery };
  }

  const issue = asRecord(body?.["issue"]);
  if (issue?.["pull_request"] !== undefined) {
    return ignored("a comment on a pull request is not an issue to delegate");
  }
  if (action !== "created") {
    return ignored(
      `a comment "${action ?? ""}" event asks for nothing; only a created comment can mention the factory`,
    );
  }
  const comment = asRecord(body?.["comment"]);
  const commenter = asRecord(comment?.["user"]);
  if (
    stringField(commenter, "type") === "Bot" ||
    stringField(asRecord(body?.["sender"]), "type") === "Bot"
  ) {
    return ignored("a bot's comment never asks for work");
  }
  const handle = input.mention ?? DEFAULT_GITHUB_MENTION;
  const text = stringField(comment, "body") ?? "";
  if (!mentionPattern(handle).test(text)) {
    return ignored(`the comment does not mention ${handle}`);
  }
  // `githubEvent` reads the issue and the repository; only the action and the words differ.
  const base = githubEvent({ ...body, action: "opened" });
  if (base === undefined) {
    return refused(
      "the payload is not an issue comment: it names no issue, repository or issue number",
    );
  }
  const label = handle.replace(/^@/, "");
  const who = stringField(commenter, "login") ?? "a user";
  const event: TriggerEvent = {
    ...base,
    labels: [...new Set([...base.labels, label])],
    body: [base.body, `Comment from ${who}:\n${text}`]
      .filter((part) => part !== "")
      .join("\n\n"),
  };
  return { _tag: "delivery", delivery: githubDeliveryOf(event, input.rules) };
};

/**
 * One `issues` or `issue_comment` delivery, taken to the seam. This is what `POST /webhooks/github`
 * runs for those two events (`apps/api`), kept here so a test and the drive run the code the route
 * does.
 *
 * In the order each step refuses more, as the other GitHub handlers do: no secret is `503`, a wrong
 * signature `401` (`refuseGitHubDelivery`), a body that is not JSON `400`, an event that asks for
 * nothing `202` and ignored. A delivery is the seam's: `{status, replayed, sessionId}` the first
 * time and `replayed: true` after, `skipped` with its reason for an unmapped label or an
 * unregistered repo, `503 in-progress` for a replay of a claim with no outcome yet, and `500` for a
 * real failure (a write-back that could not comment included), so GitHub's delivery log shows it.
 */
export const handleGitHubIssueWebhook = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
  readonly event: "issues" | "issue_comment";
  readonly rules: ReadonlyArray<TriggerRule>;
  readonly mention?: string | undefined;
}): Effect.Effect<GitHubWebhookAnswer, never, TriggerService> =>
  Effect.gen(function* () {
    const refused = refuseGitHubDelivery(input);
    if (refused !== undefined) return refused;
    const payload = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(input.raw).pipe(Effect.orElseSucceed(() => undefined));
    if (asRecord(payload) === undefined) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "the body is not a JSON object",
          code: "bad-json",
        },
      } satisfies GitHubWebhookAnswer;
    }
    const intake = githubIssueIntake({
      event: input.event,
      payload,
      rules: input.rules,
      mention: input.mention,
    });
    if (intake._tag === "refused") {
      return {
        status: 400,
        body: { ok: false, error: intake.reason, code: "bad-payload" },
      } satisfies GitHubWebhookAnswer;
    }
    if (intake._tag === "ignored") {
      return {
        status: 202,
        body: { ok: true, ignored: intake.reason },
      } satisfies GitHubWebhookAnswer;
    }
    const triggers = yield* TriggerService;
    return yield* triggers.deliver(intake.delivery).pipe(
      Effect.map((delivered): GitHubWebhookAnswer => {
        if (delivered.replayed && delivered.status === "received") {
          // A claim with no outcome yet is not an answer a retry may stop on (LOB-216).
          return {
            status: 503,
            body: {
              ok: false,
              status: delivered.status,
              replayed: true,
              code: "in-progress",
              error:
                "this delivery is claimed and has no outcome yet; retry later",
            },
          };
        }
        return {
          status: 200,
          body: {
            ok: true,
            status: delivered.status,
            replayed: delivered.replayed,
            ...(delivered.sessionId === undefined
              ? {}
              : { sessionId: delivered.sessionId }),
            ...(delivered.reason === undefined
              ? {}
              : { reason: delivered.reason }),
          },
        };
      }),
      // A refusal is an answer (`skipped`), so only a real failure reaches here.
      Effect.catchTag("TriggerError", (cause) =>
        Effect.logError(
          `github issue: delivery ${intake.delivery.requestId} failed: ${cause.message}`,
        ).pipe(
          Effect.as<GitHubWebhookAnswer>({
            status: 500,
            body: { ok: false, error: cause.message, code: cause.code },
          }),
        ),
      ),
    );
  });

/** Where the write-back posts, and where a reader finds the session. */
export type GitHubConfig = {
  /**
   * The API root. Absent means the deployment's `GITHUB_API_URL` — the same variable the PR client
   * reads (LOB-51), so one value points both GitHub clients at the same forge, and a loopback fake
   * answers without any credential being real.
   */
  readonly apiUrl?: string;
  /** Where a reader finds the session, so the comment links to it. */
  readonly sessionUrlBase?: string;
};

/** The comment's markdown: the session id, and a link when the deployment knows its own address. */
export const githubComment = (
  config: GitHubConfig,
  sessionId: SessionId,
): string => {
  const link =
    config.sessionUrlBase === undefined
      ? ""
      : ` (${config.sessionUrlBase.replace(/\/+$/, "")}/${sessionId})`;
  return `Factory started session ${sessionId} for this issue${link}.`;
};

/** One page of an issue's comments, as GitHub's list endpoint answers it: an array. */
const GitHubComments = Schema.Array(Schema.Struct({ body: Schema.Unknown }));

/**
 * The seam's write-back port, filled by GitHub's issue-comment API.
 *
 * `POST /repos/{owner}/{repo}/issues/{number}/comments` with the installation token from the
 * credential seam is the call: GitHub wants the issue *number* in the path and `{ body }` — plain
 * markdown — and it answers `201` with the created comment. Anything else — an unreachable forge, a
 * refusal, a body that cannot be encoded — is a `write-back` `TriggerError`, which the seam answers
 * by giving the delivery's claim back.
 *
 * **It reads the issue's comments before it posts one.** The seam's retry contract is "any failed
 * delivery gives its claim back", so a write-back that posted again on the retry would put a second
 * comment on the issue whenever the comment landed and its acknowledgement did not. A comment
 * naming this session is the record the retry looks for, exactly as on Jira (`Jira.ts`). The read is
 * GitHub's default page (30 comments); a very long thread is the one shape this check cannot see,
 * which `docs/testing-third-parties.md` records.
 */
export const GitHubWriteBack = (
  config: GitHubConfig,
): Layer.Layer<
  TriggerWriteBack,
  never,
  HttpClient.HttpClient | CredentialProvider
> =>
  Layer.effect(
    TriggerWriteBack,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const credentials = yield* CredentialProvider;
      const apiUrl = config.apiUrl ?? githubApiUrl();
      const fail = (message: string): TriggerError =>
        new TriggerError({ code: "write-back", message });

      return TriggerWriteBack.of({
        write: (input) =>
          Effect.gen(function* () {
            const repo = input.event.repo;
            if (repo === undefined) {
              return yield* fail(
                `the payload for ${input.event.key} named no repository to comment on`,
              );
            }
            const number = input.event.key.slice(
              input.event.key.lastIndexOf("#") + 1,
            );
            const [owner, name] = repo.split("/");
            const token = yield* credentials
              .tokenFor(repo)
              .pipe(
                Effect.mapError(() =>
                  fail(`no credential for ${repo} to comment with`),
                ),
              );
            const commentsUrl = `${apiUrl}/repos/${owner}/${name}/issues/${number}/comments`;
            const headers = {
              authorization: `Bearer ${Redacted.value(token)}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            };

            const existing = yield* http
              .execute(HttpClientRequest.get(commentsUrl, { headers }))
              .pipe(
                Effect.mapError(() =>
                  fail(`GitHub could not be read for ${input.event.key}`),
                ),
              );
            if (existing.status < 200 || existing.status > 299) {
              return yield* fail(
                `GitHub answered HTTP ${existing.status} reading ${input.event.key}'s comments`,
              );
            }
            const comments = yield* HttpClientResponse.schemaBodyJson(
              GitHubComments,
            )(existing).pipe(
              Effect.mapError(() =>
                fail(
                  `GitHub's comment list for ${input.event.key} could not be read`,
                ),
              ),
            );
            const already = comments.some((comment) =>
              typeof comment.body === "string"
                ? comment.body.includes(input.sessionId)
                : false,
            );
            if (already) return;

            const request = yield* HttpClientRequest.post(commentsUrl, {
              headers,
            }).pipe(
              HttpClientRequest.bodyJson({
                body: githubComment(config, input.sessionId),
              }),
              Effect.mapError(() =>
                fail("the comment body could not be encoded"),
              ),
            );
            const response = yield* http
              .execute(request)
              .pipe(
                Effect.mapError(() =>
                  fail(`GitHub could not be reached for ${input.event.key}`),
                ),
              );
            if (response.status < 200 || response.status > 299) {
              return yield* fail(
                `GitHub answered HTTP ${response.status} for ${input.event.key}`,
              );
            }
          }),
      });
    }),
  );
