/**
 * The Jira adapter (LOB-189, part 2 of LOB-34): a Jira Cloud issue event in, one session and one
 * issue comment out.
 *
 * Part 1 (`@repo/domain/Trigger` + `./TriggerService`) owns everything after normalization — the
 * dedupe claim, the action filter, the label → `{repo, baseRef, prompt}` mapping, the session and
 * the write-back call. An adapter is therefore one extractor (`jiraEvent`) and one client
 * (`JiraWriteBack`), and this file is both: it adds no rule of its own about what makes a delivery
 * a replay, and it modifies no other adapter's module.
 *
 * **What the extractor reads.** Jira Cloud's issue webhook: `webhookEvent` says what happened,
 * `issue.key` is what a write-back addresses (`FAC-1`), and the issue's `fields` carry the words
 * and the labels a mapping rule matches. `jira:issue_created` is the one event that starts work;
 * every other `webhookEvent` is passed through under its own name, so the seam's filter refuses it
 * and the recorded reason names Jira's event rather than a word this adapter invented.
 *
 * The description is either plain text or Atlassian Document Format, depending on the project's
 * editor, so the body falls back to flattening an ADF tree's text nodes.
 *
 * **The idempotency key is derived, because Jira sends none.** Linear puts a delivery id in a
 * header; Jira Cloud does not, and the seam's dedupe is a row keyed by that id. So the adapter
 * builds one from what the payload says about itself — `webhookEvent:issue:timestamp` — which makes
 * a replayed *body* one delivery (the same body repeats its timestamp) and is honest about the
 * limit: a redelivery that re-stamps the payload is a new delivery, and Jira's redeliveries do
 * re-stamp. Closing that gap needs a delivery header on the route, which is LOB-217's job.
 *
 * **The write-back is one injected client.** `TriggerWriteBack` is the seam's port; this layer
 * fills it with Jira's `POST /rest/api/3/issue/{key}/comment` over the Effect `HttpClient` every
 * other control-plane client uses, so a fake needs no interception library — the same seam
 * `pr.ts` uses for GitHub. A failed comment fails the delivery (`write-back`), which gives the
 * claim back so the sender's retry runs the work instead of reading "already handled".
 */
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { SessionId } from "@repo/domain/Session";
import {
  TRIGGER_ACTION,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
} from "@repo/domain/Trigger";
import { TriggerWriteBack } from "./TriggerService";

/** One page of an issue's comments, as `GET /rest/api/3/issue/{key}/comment` answers it. */
const JiraCommentPage = Schema.Struct({
  comments: Schema.Array(Schema.Struct({ body: Schema.Unknown })),
});

/** Jira's one event that starts work; every other `webhookEvent` is the seam's to refuse. */
const JIRA_CREATE_EVENT = "jira:issue_created";

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

/** Jira's `labels` are bare strings; anything else is not a label and is dropped. */
const labelNames = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * The text inside an Atlassian Document Format node, depth-first.
 *
 * ADF is a tree of `{type, content?, text?}` nodes; a `text` node is the only one that carries
 * words. Paragraphs and list items become line breaks, so a description copied into a prompt keeps
 * the shape it had in Jira instead of collapsing into one line.
 */
const adfText = (node: unknown): string => {
  if (typeof node === "string") return node;
  const record = asRecord(node);
  if (record === undefined) return "";
  const text = stringField(record, "text");
  if (text !== undefined) return text;
  const content = record["content"];
  if (!Array.isArray(content)) return "";
  const type = stringField(record, "type");
  const inner = content.map(adfText).join("");
  // A paragraph (or a list item) ends a line; a block that only groups them (the `doc` root, a
  // table) adds nothing of its own.
  return type === "paragraph" || type === "listItem" ? `${inner}\n` : inner;
};

/** A description as text, whether the project's editor stores ADF or a plain string. */
const descriptionText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return adfText(value).trim();
};

/**
 * A Jira webhook payload, normalized.
 *
 * `undefined` is "this is not a Jira issue event": a payload with no `issue`, or with no key or id
 * to address, is a sender's mistake, and the caller answers it as a bad request rather than
 * recording a delivery it could never write back to.
 */
export const jiraEvent = (payload: unknown): TriggerEvent | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  const issue = asRecord(body["issue"]);
  if (issue === undefined) return undefined;
  const key = stringField(issue, "key") ?? stringField(issue, "id");
  if (key === undefined) return undefined;
  const fields = asRecord(issue["fields"]);
  const webhookEvent = stringField(body, "webhookEvent");
  return {
    source: "jira",
    key,
    // Only the create event is renamed: an update keeps Jira's own name so the skip reason reads
    // "action \"jira:issue_updated\" is not \"create\"" and an operator can see what arrived.
    action:
      webhookEvent === JIRA_CREATE_EVENT
        ? TRIGGER_ACTION
        : (webhookEvent ?? TRIGGER_ACTION),
    title: stringField(fields, "summary") ?? "",
    body: descriptionText(fields?.["description"]),
    labels: labelNames(fields?.["labels"]),
  };
};

/**
 * The delivery id for a Jira payload, derived from the event itself.
 *
 * Jira sends no delivery id, so the seam's dedupe key has to come from the payload: the event, the
 * issue and Jira's own `timestamp`. A replayed body repeats all three and is one delivery; a
 * redelivery that re-stamps the body is not, which is the gap a delivery header would close.
 */
export const jiraRequestId = (
  payload: Record<string, unknown>,
  event: TriggerEvent,
): string => {
  const timestamp =
    typeof payload["timestamp"] === "number"
      ? String(payload["timestamp"])
      : (stringField(payload, "timestamp") ?? "no-timestamp");
  return `jira:${event.action}:${event.key}:${timestamp}`;
};

/** A payload as the seam takes it: the normalized event, named by its derived delivery id. */
export const jiraDelivery = (payload: unknown): TriggerDelivery | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  const event = jiraEvent(body);
  if (event === undefined) return undefined;
  return { requestId: jiraRequestId(body, event), event };
};

/** Where the write-back posts, and who it authenticates as. */
export type JiraConfig = {
  /** The site's REST root, e.g. `https://acme.atlassian.net`. */
  readonly baseUrl: string;
  /** The account the API token belongs to. Jira Cloud authenticates as `email:token`. */
  readonly email: string;
  readonly apiToken: Redacted.Redacted<string>;
  /**
   * Where a reader finds the session, so the comment links to it. Absent means the comment names
   * the session id alone — a deployment with no dashboard still leaves a trace it can search.
   */
  readonly sessionUrlBase?: string;
};

/** The environment a deployment configures the adapter with. */
export type JiraEnv = {
  readonly baseUrl: string | undefined;
  readonly email: string | undefined;
  readonly apiToken: string | undefined;
  readonly sessionUrlBase: string | undefined;
};

/**
 * A config from environment-shaped values, or `undefined` when the deployment configured none.
 *
 * All three of `baseUrl`, `email` and `apiToken` are required together: a half-configured adapter
 * would fail every delivery at the write-back instead of refusing to be built, and "no Jira
 * adapter enabled" has to be a state the process can be in.
 */
export const jiraConfigFromEnv = (env: JiraEnv): JiraConfig | undefined => {
  const baseUrl = env.baseUrl?.trim();
  const email = env.email?.trim();
  const apiToken = env.apiToken?.trim();
  if (!baseUrl || !email || !apiToken) return undefined;
  const sessionUrlBase = env.sessionUrlBase?.trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email,
    apiToken: Redacted.make(apiToken),
    ...(sessionUrlBase === undefined ? {} : { sessionUrlBase }),
  };
};

/** The comment's one paragraph, as ADF: Jira Cloud's v3 comment API takes a document. */
export const jiraComment = (
  config: JiraConfig,
  sessionId: SessionId,
): Record<string, unknown> => {
  const link =
    config.sessionUrlBase === undefined
      ? ""
      : ` (${config.sessionUrlBase.replace(/\/+$/, "")}/${sessionId})`;
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `Factory started session ${sessionId} for this issue${link}.`,
          },
        ],
      },
    ],
  };
};

/**
 * A comment body as one searchable string: an ADF document flattened to its words, or a plain
 * string from a project still on the v2 API.
 */
const commentText = (body: unknown): string =>
  typeof body === "string" ? body : adfText(body);

/**
 * The seam's write-back port, filled by Jira's comment API.
 *
 * `POST /rest/api/3/issue/{key}/comment` with Basic auth is the call: Jira wants the issue *key*
 * (or id) in the path and an ADF document in the body, and it answers `201` with the created
 * comment. Anything else — an unreachable site, a refusal, a body that cannot be encoded — is a
 * `write-back` `TriggerError`, which the seam answers by giving the delivery's claim back.
 *
 * **It reads the issue's comments before it posts one.** The seam's retry contract is "any failed
 * delivery gives its claim back", so a write-back that posted again on the retry would put a second
 * comment on the issue whenever the comment landed and its acknowledgement did not (a timeout, a
 * dropped connection, a failed `processed` write). A comment naming this session is therefore the
 * record the retry looks for, exactly as the session's own request id is what keeps the retry from
 * opening a second session. The read is Jira's default page (50 comments); a very long thread is the
 * one shape this check cannot see, which `docs/testing-third-parties.md` records.
 */
export const JiraWriteBack = (
  config: JiraConfig,
): Layer.Layer<TriggerWriteBack, never, HttpClient.HttpClient> =>
  Layer.effect(
    TriggerWriteBack,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const authorization = `Basic ${Buffer.from(
        `${config.email}:${Redacted.value(config.apiToken)}`,
      ).toString("base64")}`;
      const headers = { authorization, accept: "application/json" };
      const fail = (message: string): TriggerError =>
        new TriggerError({ code: "write-back", message });
      const issueUrl = (key: string): string =>
        `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;

      /** Whether this issue already carries a comment for this session. */
      const alreadyCommented = (input: {
        readonly key: string;
        readonly sessionId: SessionId;
      }): Effect.Effect<boolean, TriggerError> =>
        Effect.gen(function* () {
          const response = yield* http
            .execute(HttpClientRequest.get(issueUrl(input.key), { headers }))
            .pipe(
              Effect.mapError(() =>
                fail(`Jira could not be read for ${input.key}`),
              ),
            );
          if (response.status < 200 || response.status > 299) {
            return yield* fail(
              `Jira answered HTTP ${response.status} reading ${input.key}'s comments`,
            );
          }
          const page = yield* HttpClientResponse.schemaBodyJson(
            JiraCommentPage,
          )(response).pipe(
            Effect.mapError(() =>
              fail(`Jira's comment list for ${input.key} could not be read`),
            ),
          );
          return page.comments.some((comment) =>
            commentText(comment.body).includes(input.sessionId),
          );
        });

      return TriggerWriteBack.of({
        write: (input) =>
          Effect.gen(function* () {
            const key = input.event.key;
            const already = yield* alreadyCommented({
              key,
              sessionId: input.sessionId,
            });
            if (already) return;

            const request = yield* HttpClientRequest.post(issueUrl(key), {
              headers,
            }).pipe(
              HttpClientRequest.bodyJson({
                body: jiraComment(config, input.sessionId),
              }),
              Effect.mapError(() =>
                fail("the comment body could not be encoded"),
              ),
            );
            const response = yield* http
              .execute(request)
              .pipe(
                Effect.mapError(() =>
                  fail(`Jira could not be reached for ${key}`),
                ),
              );
            if (response.status < 200 || response.status > 299) {
              return yield* fail(
                `Jira answered HTTP ${response.status} for ${key}`,
              );
            }
          }),
      });
    }),
  );
