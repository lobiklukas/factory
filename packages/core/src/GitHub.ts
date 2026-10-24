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
import { githubApiUrl } from "./pr";
import { TriggerWriteBack } from "./TriggerService";

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
  return { requestId: githubRequestId(event, rules), event };
};

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
